import type { Env } from "../types";
import { createOrder, createPaymentLink } from "../razorpay";
import { json, withApiLogging, type ApiResult } from "../middleware/audit";
import { validateSession, UNAUTHORIZED } from "../middleware/session";

export async function handleCheckout(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);

  return withApiLogging(
    env,
    { sessionId: session?.id ?? null, endpoint: "/api/checkout", method: "POST", params: null },
    async (): Promise<ApiResult> => {
      if (!session) return UNAUTHORIZED();

      // Idempotency — an active order for this session is returned as-is
      const activeOrder: any = await env.DB.prepare(
        "SELECT razorpay_order_id, amount, payment_url FROM orders WHERE session_id = ? AND status IN ('created', 'attempted') ORDER BY created_at DESC LIMIT 1",
      )
        .bind(session.id)
        .first();
      if (activeOrder) {
        return json({
          success: true as const,
          data: {
            orderId: activeOrder.razorpay_order_id,
            amount: activeOrder.amount,
            paymentUrl: activeOrder.payment_url ?? undefined,
            status: activeOrder.status,
          },
        });
      }

      // Cart
      const rows: any[] = (
        await env.DB.prepare(
          "SELECT product_id, product_name, price, quantity FROM cart_items WHERE session_id = ? ORDER BY added_at ASC",
        )
          .bind(session.id)
          .all()
      ).results ?? [];
      if (rows.length === 0) {
        return json({ success: false, error: "Cart is empty" });
      }

      // Re-validate stock — remove anything that vanished and fail the turn
      for (const row of rows) {
        const product = await env.DB.prepare("SELECT name, stock FROM products WHERE id = ?")
          .bind(row.product_id)
          .first<any>();
        if (!product || product.stock <= 0) {
          await env.DB.prepare("DELETE FROM cart_items WHERE session_id = ? AND product_id = ?")
            .bind(session.id, row.product_id)
            .run();
          return json({ success: false, error: `${row.product_name} is no longer available` });
        }
      }

      const total = rows.reduce((sum, r) => sum + r.price * r.quantity, 0);
      const cartItems = rows.map((r) => ({
        productId: r.product_id as string,
        name: r.product_name as string,
        price: r.price as number,
        quantity: r.quantity as number,
      }));

      try {
        const order = await createOrder(
          env,
          total,
          `${session.id.slice(0, 12)}-${Date.now()}`,
        );

        const customerEmail = session.userId || "guest@example.com";
        let paymentUrl: string | undefined;
        try {
          paymentUrl = await createPaymentLink(env, order.id, customerEmail);
        } catch (e) {
          console.error("payment link failed (order kept):", e);
        }

        await env.DB.prepare(
          "INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, payment_url, created_at) VALUES (?, ?, ?, ?, 'INR', 'created', ?, ?, ?)",
        )
          .bind(
            crypto.randomUUID(),
            session.id,
            order.id,
            total,
            JSON.stringify(cartItems),
            paymentUrl ?? null,
            new Date().toISOString(),
          )
          .run();

        return json({
          success: true as const,
          data: {
            orderId: order.id,
            amount: total,
            paymentUrl,
            status: "created",
          },
        });
      } catch (e) {
        console.error("checkout gateway error:", e);
        return json({ success: false, error: "Payment gateway error" }, 502);
      }
    },
  );
}

export async function handleOrderStatus(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateSession(env, request);
  const orderId = url.pathname.split("/").pop() ?? "";

  return withApiLogging(
    env,
    { sessionId: session?.id ?? null, endpoint: `/api/order/${orderId}`, method: "GET", params: null },
    async (): Promise<ApiResult> => {
      if (!session) return UNAUTHORIZED();

      const row: any = await env.DB.prepare(
        "SELECT razorpay_order_id, status, amount, items_json FROM orders WHERE razorpay_order_id = ? AND session_id = ?",
      )
        .bind(orderId, session.id)
        .first();

      if (!row) {
        return json({ success: false, error: "Order not found" }, 404);
      }

      return json({
        success: true as const,
        data: {
          orderId: row.razorpay_order_id,
          status: row.status,
          amount: row.amount,
          items: JSON.parse(row.items_json || "[]"),
        },
      });
    },
  );
}

