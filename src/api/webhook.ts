import type { Env } from "../types";
import { json, withApiLogging, logApiCall, type ApiResult } from "../middleware/audit";
import { hmacSHA256 } from "../crypto";

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

      if (event.event !== "payment.captured") {
        return json({ success: true, data: { status: "ignored", event: event.event } });
      }

      const paymentId = event.payload.payment.entity.id;
      const orderId = event.payload.payment.entity.order_id;
      const amount = event.payload.payment.entity.amount;

      await env.DB.prepare("UPDATE orders SET status = 'paid' WHERE razorpay_order_id = ?")
        .bind(orderId)
        .run();

      const orderRow: any = await env.DB.prepare(
        "SELECT session_id, items_json FROM orders WHERE razorpay_order_id = ?",
      )
        .bind(orderId)
        .first();
      const sessionId = orderRow?.session_id ?? null;

      if (sessionId && orderRow.items_json) {
        const items = JSON.parse(orderRow.items_json) as { productId: string; quantity: number }[];

        // Decrement stock for each purchased item (clamped at zero)
        for (const item of items) {
          await env.DB.prepare("UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?")
            .bind(item.quantity, item.productId)
            .run();
        }

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
                preferred_categories TEXT,
                budget_preference INTEGER,
                previous_products TEXT,
                purchase_history TEXT,
                session_count INTEGER DEFAULT 0,
                last_active TEXT,
                updated_at TEXT
              )`,
            ).run();
            await env.DB.prepare(
              "INSERT OR IGNORE INTO user_preferences (user_id, preferred_categories, budget_preference, previous_products, purchase_history, session_count, last_active, updated_at) VALUES (?, '[]', NULL, '[]', '[]', 0, NULL, NULL)",
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
    },
  );
}


