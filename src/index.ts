import { routeAgentRequest } from "agents";
import { SanchayAgent } from "./agent";
import { embedProducts } from "./catalog/embed";
import { searchProducts } from "./catalog/search";
import { seedCatalog } from "./catalog/seed";
import { hmacSHA256 } from "./crypto";
import type { Env } from "./types";

export { SanchayAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Try the Agents SDK router first (handles WebSocket upgrades to the Agent)
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Custom HTTP endpoints
    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/admin/seed-catalog" && request.method === "POST") {
      await seedCatalog(env);
      await embedProducts(env);
      return Response.json({ status: "ok", message: "Catalog seeded" });
    }

    if (url.pathname === "/catalog.json") {
      if (request.method === "GET") {
        const q = url.searchParams.get("q");
        if (q) {
          const results = await searchProducts(env, q, 10);
          return Response.json(results);
        }
        const result = await env.DB.prepare(
          `SELECT id, name, description, price, category, stock FROM products`
        ).all();
        return Response.json(result.results ?? []);
      }
    }

    if (url.pathname === "/checkout" && request.method === "POST") {
      return Response.json({
        status: "not_implemented",
        message: "Checkout endpoint coming in Phase 8",
      });
    }

    if (url.pathname === "/verify" && request.method === "POST") {
      return Response.json({
        status: "not_implemented",
        message: "Verify endpoint coming in Phase 8",
      });
    }

    if (url.pathname === "/webhooks/razorpay" && request.method === "POST") {
      // Verify webhook signature
      const body = await request.text();
      const signature = request.headers.get("x-razorpay-signature") || "";
      const expectedSignature = await hmacSHA256(body, env.RAZORPAY_WEBHOOK_SECRET);

      if (signature !== expectedSignature) {
        return new Response("Invalid signature", { status: 400 });
      }

      const event = JSON.parse(body);

      // Handle payment.captured event
      if (event.event === "payment.captured") {
        const paymentId = event.payload.payment.entity.id;
        const orderId = event.payload.payment.entity.order_id;
        const amount = event.payload.payment.entity.amount;

        // Update order status in D1
        await env.DB.prepare("UPDATE orders SET status = 'paid' WHERE razorpay_order_id = ?")
          .bind(orderId)
          .run();

        // Webhooks bypass the DO — write audit directly to D1 audit_logs
        await env.DB.prepare(
          "INSERT INTO audit_logs (id, session_id, action, intent, params_json, result_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(
            crypto.randomUUID(),
            "",
            "payment.captured",
            "payment",
            JSON.stringify({ paymentId, orderId }),
            JSON.stringify({ amount }),
            "ok",
            new Date().toISOString(),
          )
          .run();

        return Response.json({ status: "ok" });
      }

      return Response.json({ status: "ignored", event: event.event });
    }

    if (url.pathname === "/audit") {
      // Return audit trail for a session — will be wired in Phase 9
      return Response.json({
        status: "not_implemented",
        message: "Audit endpoint coming in Phase 9",
      });
    }

    // Serve the React frontend via assets binding
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
