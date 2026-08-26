import { handleSessionStart, handleSessionEnd } from "./api/session";
import { handleCatalogSearch } from "./api/catalog";
import { handleCartAdd, handleCartRemove, handleCartGet } from "./api/cart";
import { handleCheckout, handleOrderStatus } from "./api/checkout";
import { handleAudit } from "./api/audit";
import { handleRazorpayWebhook } from "./api/webhook";
import { handleSeedCatalog, handleImportFlipkartCatalog } from "./api/admin";
import { handleGetTools, handleOpenApiSpec } from "./api/tools";
import { handleVoiceWebSocket } from "./voice/bridge";
import { checkAdminToken } from "./middleware/adminAuth";
import type { Env } from "./types";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-session-id",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      let response: Response;

      if (url.pathname === "/healthz") {
        response = Response.json({ status: "ok" });
      } else if (url.pathname === "/api/session/start" && request.method === "POST") {
        response = await handleSessionStart(request, env);
      } else if (url.pathname === "/api/session/end" && request.method === "POST") {
        response = await handleSessionEnd(request, env);
      } else if (url.pathname === "/api/catalog" && (request.method === "GET" || request.method === "POST")) {
        // POST accepted: Sarvam tools are configured all-POST
        response = await handleCatalogSearch(request, env, url);
      } else if (url.pathname === "/api/cart/add" && request.method === "POST") {
        response = await handleCartAdd(request, env);
      } else if (url.pathname === "/api/cart/remove" && request.method === "POST") {
        response = await handleCartRemove(request, env);
      } else if (url.pathname === "/api/cart" && (request.method === "GET" || request.method === "POST")) {
        response = await handleCartGet(request, env);
      } else if (url.pathname === "/api/checkout" && request.method === "POST") {
        response = await handleCheckout(request, env);
      } else if (url.pathname.startsWith("/api/order/") && (request.method === "GET" || request.method === "POST")) {
        response = await handleOrderStatus(request, env, url);
      } else if (url.pathname === "/api/audit" && request.method === "GET") {
        response = await handleAudit(request, env, url);
      } else if (url.pathname === "/api/tools" && request.method === "GET") {
        response = await handleGetTools(request, env);
      } else if (url.pathname === "/openapi.yaml" && request.method === "GET") {
        response = await handleOpenApiSpec(request, env);
      } else if (url.pathname === "/webhooks/razorpay" && request.method === "POST") {
        response = await handleRazorpayWebhook(request, env);
      } else if (url.pathname === "/voice" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        // Explicit 426 for non-WS requests to /voice
        response = new Response("Expected WebSocket", { status: 426 });
      } else if (url.pathname === "/voice") {
        response = await handleVoiceWebSocket(request, env);
      } else if (url.pathname === "/admin/seed-catalog" && request.method === "POST") {
        response = checkAdminToken(env, request) ?? (await handleSeedCatalog(request, env));
      } else if (url.pathname === "/admin/import-flipkart" && request.method === "POST") {
        response = checkAdminToken(env, request) ?? (await handleImportFlipkartCatalog(request, env, url));
      } else {
        // Frontend SPA
        response = await env.ASSETS.fetch(request);
      }

      // WebSocket upgrade (101) must pass through untouched — reconstructing
      // a Response drops the webSocket property and throws
      if (response.status === 101) return response;

      // CORS on every response — Sarvam tool calls come from Sarvam's servers,
      // frontend polls come from the browser
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });

    } catch (e) {
      console.error("unhandled worker error:", e);
      return Response.json(
        { success: false, error: "Internal server error" },
        { status: 500, headers: CORS_HEADERS },
      );
    }
  },
} satisfies ExportedHandler<Env>;
