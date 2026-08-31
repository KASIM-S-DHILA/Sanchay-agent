import type { Env } from "../types";
import { json, withApiLogging, logApiCall, type ApiResult } from "../middleware/audit";
import { hmacSHA256 } from "../crypto";
import { clearPaidItemsFromCart, releaseOrderStock } from "./logic";

export async function handleRazorpayWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("x-razorpay-signature") || "";

  return withApiLogging(
    env,
    { sessionId: null, endpoint: "/webhooks/razorpay", method: "POST", params: null },
    async (): Promise<ApiResult> => {
      const expected = await hmacSHA256(body, env.RAZORPAY_WEBHOOK_SECRET);
      if (signature !== expected) {
        return json({ success: false, error: "Invalid signature" }, 400);
      }

      const event = JSON.parse(body);

      // All 44 Razorpay webhook events may arrive here (the account has
      // every event enabled) — anything outside this set (subscriptions,
      // payouts, disputes, settlements, refunds, etc.) is safely ignored;
      // Sanchay doesn't use those Razorpay products.
      if (event.event === "payment.failed") {
        return await handlePaymentFailed(env, event);
      }
      // order.paid carries the same "this order is settled" fact as
      // payment.captured but as a combined order+payment payload —
      // payment_link.paid is the equivalent event when the fallback
      // Payment Link (rather than the Checkout.js modal) is what actually
      // got paid. All three converge on the same handlePaymentCaptured
      // path since marking the order paid and clearing the cart doesn't
      // depend on which of the three told us about it.
      if (event.event === "payment.captured") {
        return await handlePaymentCaptured(
          env,
          event.payload.payment.entity.id,
          event.payload.payment.entity.order_id,
          event.payload.payment.entity.amount,
        );
      }
      if (event.event === "order.paid") {
        return await handlePaymentCaptured(
          env,
          event.payload.payment?.entity?.id ?? "",
          event.payload.order.entity.id,
          event.payload.order.entity.amount,
        );
      }
      if (event.event === "payment_link.paid") {
        // Payment Links reference the order via notes.order_id (see
        // createPaymentLink in src/razorpay.ts, which sets notes.order_id
        // explicitly for exactly this reason) rather than a top-level
        // order_id field.
        const linkedOrderId = event.payload.payment_link?.entity?.notes?.order_id;
        if (!linkedOrderId) {
          return json({ success: true, data: { status: "ignored", event: event.event, reason: "no linked order_id in notes" } });
        }
        return await handlePaymentCaptured(
          env,
          event.payload.payment?.entity?.id ?? "",
          linkedOrderId,
          event.payload.payment_link.entity.amount_paid ?? event.payload.payment_link.entity.amount,
        );
      }

      return json({ success: true, data: { status: "ignored", event: event.event } });
    },
  );
}

/**
 * A failed payment attempt (declined card, insufficient funds, timeout,
 * etc.) is NOT abandonment — the shopper may retry the exact same order
 * immediately. Marks the order 'attempted' (checkoutCart's idempotency
 * already treats 'attempted' as still-active and returns the SAME
 * order/paymentUrl on the next checkout call, so a retry doesn't need a
 * new order) and releases the reserved stock right away rather than
 * making the shopper wait out the full RESERVATION_TIMEOUT_MS for a
 * definitively-over attempt — no reason to hold stock hostage for up to
 * 15 minutes per failed try, especially if the shopper immediately tries
 * a different card and it works.
 */
async function handlePaymentFailed(env: Env, event: any): Promise<ApiResult> {
  const orderId = event.payload.payment?.entity?.order_id;
  if (!orderId) {
    return json({ success: true, data: { status: "ignored", event: event.event, reason: "no order_id" } });
  }
  const orderRow: any = await env.DB.prepare(
    "SELECT id, session_id, items_json, status FROM orders WHERE razorpay_order_id = ?",
  )
    .bind(orderId)
    .first();
  if (!orderRow || orderRow.status === "paid" || orderRow.status === "cancelled") {
    // Already settled or already reconciled — a failure notification for
    // an order we've moved past is a no-op, not an error (Razorpay's own
    // retry/backoff can deliver events out of order).
    return json({ success: true, data: { status: "ok", note: "order already settled or reconciled" } });
  }

  const errorDescription = event.payload.payment?.entity?.error_description ?? null;

  // Guard against double-releasing stock: this handler releases it
  // immediately on failure, but the order is left in 'attempted' (not
  // 'cancelled') so a retry can still reuse the same order/paymentUrl via
  // checkoutCart's idempotency check. Without stock_released, a LATER
  // reconcileExpiredOrders pass (which matches status IN
  // ('created','attempted')) would see this same still-'attempted' order
  // once it ages past RESERVATION_TIMEOUT_MS and release its stock a
  // SECOND time — crediting phantom stock that was never actually
  // re-reserved for it.
  await env.DB.prepare("UPDATE orders SET status = 'attempted', stock_released = 1 WHERE id = ?")
    .bind(orderRow.id)
    .run();
  await releaseOrderStock(env, orderRow.items_json);

  await logApiCall(env, {
    sessionId: orderRow.session_id ?? null,
    endpoint: "/webhooks/razorpay",
    method: "POST",
    params: { orderId, event: "payment.failed", error_description: errorDescription },
    response: { status: "attempted" },
    status: "ok",
    durationMs: 0,
  });

  return json({ success: true, data: { status: "ok" } });
}

async function handlePaymentCaptured(env: Env, paymentId: string, orderId: string, amount: number): Promise<ApiResult> {
  {
    // Razorpay explicitly documents that webhook delivery is retried on
    // failure/timeout, so this handler MUST be idempotent against
    // receiving the same payment.captured event more than once. Stock is
    // decremented atomically at order-creation time (checkoutCart), not
    // here — this handler only needs to guard against double-marking the
    // order paid / double-writing purchase history on a duplicate
    // delivery for an order that's already settled.
    const orderRow: any = await env.DB.prepare(
      "SELECT session_id, items_json, status FROM orders WHERE razorpay_order_id = ?",
    )
      .bind(orderId)
      .first();

    if (orderRow?.status === "paid") {
      await logApiCall(env, {
        sessionId: orderRow.session_id ?? null,
        endpoint: "/webhooks/razorpay",
        method: "POST",
        params: { paymentId, orderId, duplicate_delivery: true },
        response: { amount, status: "paid" },
        status: "ok",
        durationMs: 0,
      });
      return json({ success: true, data: { status: "ok", note: "duplicate delivery — already processed" } });
    }

    await env.DB.prepare("UPDATE orders SET status = 'paid' WHERE razorpay_order_id = ?")
      .bind(orderId)
      .run();

    const sessionId = orderRow?.session_id ?? null;

    // The actual fix for "paid items still show up in the cart on
    // reload" — checkoutCart never removes what it's charging for, only
    // reserves stock, so nothing else in this codebase ever did this
    // until now. Removing only the paid items/quantities (not the whole
    // cart) means anything added after checkout started stays put.
    //
    // cart_cleared is set here (the fast path) so reconcilePaidOrders'
    // safety-net pass on the next cart read sees this order as already
    // handled and skips it — otherwise it would re-run this exact
    // clearing again on the very next /api/cart read and delete a
    // legitimate LATER add of the same product, which is what made
    // add_to_cart look broken for a repeat purchase.
    if (sessionId && orderRow.items_json) {
      await clearPaidItemsFromCart(env, sessionId, orderRow.items_json);
      await env.DB.prepare("UPDATE orders SET cart_cleared = 1 WHERE razorpay_order_id = ?").bind(orderId).run();
    }

    if (sessionId && orderRow.items_json) {
      const items = JSON.parse(orderRow.items_json) as { productId: string; quantity: number }[];

      // Purchase history → user_preferences
      const productIds = items.map((i) => i.productId).filter(Boolean);
      if (productIds.length > 0) {
        const sess: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
          .bind(sessionId)
          .first();
        const userEmail = sess?.user_id ?? null;

        if (userEmail) {
          await env.DB.prepare(
            `CREATE TABLE IF NOT EXISTS user_preferences (
                user_id TEXT PRIMARY KEY,
                previous_products TEXT,
                purchase_history TEXT,
                session_count INTEGER DEFAULT 0,
                last_active TEXT,
                updated_at TEXT
              )`,
          ).run();
          await env.DB.prepare(
            "INSERT OR IGNORE INTO user_preferences (user_id, previous_products, purchase_history, session_count, last_active, updated_at) VALUES (?, '[]', '[]', 0, NULL, NULL)",
          )
            .bind(userEmail)
            .run();
          const prefs: any = await env.DB.prepare(
            "SELECT purchase_history FROM user_preferences WHERE user_id = ?",
          )
            .bind(userEmail)
            .first();
          const existing = JSON.parse(prefs?.purchase_history || "[]");
          const updated = [...new Set([...existing, ...productIds])];
          await env.DB.prepare(
            "UPDATE user_preferences SET purchase_history = ?, updated_at = ? WHERE user_id = ?",
          )
            .bind(JSON.stringify(updated), new Date().toISOString(), userEmail)
            .run();
        }
      }
    }

    // Audit entry attributed to the order's session
    await logApiCall(env, {
      sessionId,
      endpoint: "/webhooks/razorpay",
      method: "POST",
      params: { paymentId, orderId },
      response: { amount, status: "paid" },
      status: "ok",
      durationMs: 0,
    });

    return json({ success: true, data: { status: "ok" } });
  }
}


