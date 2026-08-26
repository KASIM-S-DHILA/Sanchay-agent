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

        // Attribute the audit row to the order's session
        const orderRow: any = await env.DB.prepare(
          "SELECT session_id FROM orders WHERE razorpay_order_id = ?",
        )
          .bind(orderId)
          .first();
        const orderSession = orderRow?.session_id ?? "";

        // Cross-session memory — record purchase history for the buyer
        if (orderRow?.session_id) {
          const items = JSON.parse(orderRow.items_json || "[]") as { productId?: string }[];
          const productIds = items.map((i) => i.productId).filter(Boolean) as string[];

          // Resolve the user email: sessions table first, then live DO state
          let userEmail: string | null = null;
          try {
            const sessRow: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
              .bind(orderRow.session_id)
              .first();
            userEmail = sessRow?.user_id ?? null;
          } catch {
            // sessions table may not exist in isolated test D1
          }
          if (!userEmail) {
            try {
              const doId = env.SanchayAgent.idFromName(orderRow.session_id);
              const stub = env.SanchayAgent.get(doId) as unknown as {
                getUserEmail(): Promise<string | null>;
              };
              userEmail = await stub.getUserEmail();
            } catch {
              // DO unreachable — skip purchase history rather than fail the webhook
            }
          }

          if (userEmail && productIds.length > 0) {
            await env.DB.prepare(
              "CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY, preferred_categories TEXT, budget_preference INTEGER, previous_products TEXT, purchase_history TEXT, session_count INTEGER DEFAULT 0, last_active TEXT, updated_at TEXT)",
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

        // Webhooks bypass the DO — write audit directly to D1 audit_logs
        await env.DB.prepare(
          "INSERT INTO audit_logs (id, session_id, action, intent, params_json, result_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(
            crypto.randomUUID(),
            orderSession,
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
      const sessionId = url.searchParams.get("sid");
      if (!sessionId) {
        return Response.json({ error: "Missing sid parameter" }, { status: 400 });
      }

      // 1. Cross-session events from D1 (webhooks, etc.)
      const d1Logs = await env.DB.prepare(
        "SELECT id, session_id, action, intent, params_json, result_json, status, created_at FROM audit_logs WHERE session_id = ? ORDER BY created_at ASC",
      )
        .bind(sessionId)
        .all();

      // 2. Per-session turn-engine events from the DO's SQLite.
      // Same-runtime DO RPC — getAuditEvents is a plain public method.
      let doEvents: Record<string, unknown>[] = [];
      try {
        const doId = env.SanchayAgent.idFromName(sessionId);
        // Same-runtime DO RPC — typed via structural cast (Env's namespace is untyped)
        const stub = env.SanchayAgent.get(doId) as unknown as {
          getAuditEvents(): Promise<{ events: Record<string, unknown>[] }>;
        };
        const res = await stub.getAuditEvents();
        doEvents = res.events ?? [];
      } catch (e) {
        console.warn(`audit: DO fetch failed for ${sessionId}:`, e);
      }

      // 3. Merge and sort chronologically
      const merged = [
        ...(d1Logs.results as any[]).map((row) => ({
          source: "d1",
          id: String(row.id),
          ts: new Date(row.created_at).getTime(),
          action: row.action,
          status: row.status,
          reason: row.intent || "",
          detail: row.params_json || row.result_json || "",
        })),
        ...doEvents.map((e: any) => ({
          source: "do",
          id: String(e.id),
          ts: e.ts,
          action: e.action,
          status: e.status,
          reason: e.reason,
          detail: e.detail || "",
          actor: e.actor,
          sku: e.sku,
          order_id: e.order_id,
          payment_id: e.payment_id,
          amount_paise: e.amount_paise,
          bound_paise: e.bound_paise,
        })),
      ].sort((a, b) => a.ts - b.ts);

      return Response.json({ events: merged, sessionId });
    }

    // Serve the React frontend via assets binding
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
