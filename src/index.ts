import { handleSessionStart, handleSessionEnd, handleSessionBudget, handleSessionHistory } from "./api/session";
import { handleCatalogSearch } from "./api/catalog";
import {
  handleCartAdd,
  handleCartRemove,
  handleCartGet,
  handlePropseAddToCart,
  handleProposeRemoveFromCart,
  handleConfirmCartAction,
} from "./api/cart";
import { handleCheckout, handleOrderStatus } from "./api/checkout";
import { handleAudit } from "./api/audit";
import { handleGetTranscript } from "./api/transcript";
import { handleRazorpayWebhook } from "./api/webhook";
import { handleSeedCatalog, handleReplaceCatalog } from "./api/admin";
import { handleSaveName } from "./api/user";
import { handleAuthOtpSend, handleAuthOtpVerify } from "./api/auth";
import { handleAccountProfile } from "./api/account";
import { handleLogViewedProduct, handleGetViewedProducts } from "./api/viewedProducts";
import { handleDescribeProducts } from "./api/describeProducts";
import { handleProductDetails } from "./api/productDetails";
import { handleGetTools, handleOpenApiSpec } from "./api/tools";
import { handleGeminiToken } from "./api/geminiToken";
import { checkAdminToken } from "./middleware/adminAuth";
import { validateSession } from "./middleware/session";
import type { Env } from "./types";

// Re-exported so wrangler can find the class named in wrangler.jsonc's
// durable_objects binding — required regardless of whether index.ts
// itself references SessionHub by name anywhere else.
export { SessionHub } from "./durable/SessionHub";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-session-id, Authorization",
};

/**
 * Upgrades to a WebSocket held by this session's SessionHub Durable Object
 * (see src/durable/SessionHub.ts) — pushes a "changed" signal after cart/
 * checkout/webhook mutations so the frontend can re-fetch immediately
 * instead of waiting for its next poll tick.
 *
 * Session validation happens HERE, in the Worker, before the DO is ever
 * reached — same trust model /api/audit already uses (a session id in
 * ?session_id, matched against the caller's own x-session-id header; see
 * validateSession in middleware/session.ts). The DO itself has no concept
 * of auth at all; it trusts that reaching it at all already proves the
 * caller owns this session. Not gated any tighter than that on purpose —
 * this channel only ever pushes "something changed", never any cart/
 * order contents, so there's nothing sensitive to leak even in the guest-
 * session-id-only trust model the rest of this app's cart/audit endpoints
 * already use.
 */
async function handleSessionLive(request: Request, env: Env, url: URL): Promise<Response> {
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("Missing session_id", { status: 400 });
  }
  const caller = await validateSession(env, request);
  if (!caller || caller.id !== sessionId) {
    return new Response("Invalid or expired session", { status: 401 });
  }
  const stub = env.SESSION_HUB.getByName(sessionId);
  return stub.fetch(request);
}

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
      } else if (url.pathname === "/api/session/budget" && request.method === "POST") {
        response = await handleSessionBudget(request, env);
      } else if (url.pathname === "/api/session/history" && request.method === "GET") {
        response = await handleSessionHistory(request, env);
      } else if (url.pathname === "/api/account/profile" && request.method === "GET") {
        response = await handleAccountProfile(request, env);
      } else if (url.pathname === "/api/viewed-products" && request.method === "POST") {
        response = await handleLogViewedProduct(request, env);
      } else if (url.pathname === "/api/viewed-products" && request.method === "GET") {
        response = await handleGetViewedProducts(request, env);
      } else if (url.pathname === "/api/describe-products" && request.method === "POST") {
        response = await handleDescribeProducts(request, env);
      } else if (url.pathname === "/api/product-details" && request.method === "POST") {
        response = await handleProductDetails(request, env);
      } else if ((url.pathname === "/api/user/name") && (request.method === "POST" || request.method === "GET")) {
        response = await handleSaveName(request, env);
      } else if (url.pathname === "/api/auth/otp" && request.method === "POST") {
        response = await handleAuthOtpSend(request, env);
      } else if (url.pathname === "/api/auth/otp/verify" && request.method === "POST") {
        response = await handleAuthOtpVerify(request, env);
      } else if (url.pathname === "/api/catalog" && (request.method === "GET" || request.method === "POST")) {
        // POST accepted: Sarvam tools are configured all-POST
        response = await handleCatalogSearch(request, env, url);
      } else if (url.pathname === "/api/cart/add" && request.method === "POST") {
        response = await handleCartAdd(request, env);
      } else if (url.pathname === "/api/cart/remove" && request.method === "POST") {
        response = await handleCartRemove(request, env);
      } else if (url.pathname === "/api/cart/propose-add" && request.method === "POST") {
        response = await handlePropseAddToCart(request, env);
      } else if (url.pathname === "/api/cart/propose-remove" && request.method === "POST") {
        response = await handleProposeRemoveFromCart(request, env);
      } else if (url.pathname === "/api/cart/confirm" && request.method === "POST") {
        response = await handleConfirmCartAction(request, env);
      } else if (url.pathname === "/api/cart" && (request.method === "GET" || request.method === "POST")) {
        response = await handleCartGet(request, env);
      } else if (url.pathname === "/api/checkout" && request.method === "POST") {
        response = await handleCheckout(request, env);
      } else if (
        (url.pathname.startsWith("/api/order/") || url.pathname === "/api/order") &&
        (request.method === "GET" || request.method === "POST")
      ) {
        // /api/order/{id} for the browser; POST /api/order with {order_id} for
        // voice tools, which are simpler to configure without a path template.
        response = await handleOrderStatus(request, env, url);
      } else if (url.pathname === "/api/audit" && request.method === "GET") {
        response = await handleAudit(request, env, url);
      } else if (url.pathname === "/api/live" && request.method === "GET") {
        response = await handleSessionLive(request, env, url);

      } else if (url.pathname === "/api/voice/transcript" && request.method === "GET") {
        response = await handleGetTranscript(request, env, url);
      } else if (url.pathname === "/api/tools" && request.method === "GET") {
        response = await handleGetTools(request, env);
      } else if (url.pathname === "/openapi.yaml" && request.method === "GET") {
        response = await handleOpenApiSpec(request, env);
      } else if (url.pathname === "/webhooks/razorpay" && request.method === "POST") {
        response = await handleRazorpayWebhook(request, env);
      } else if (url.pathname === "/api/gemini/token" && request.method === "POST") {
        response = await handleGeminiToken(request, env);
      } else if (url.pathname === "/admin/seed-catalog" && request.method === "POST") {
        response = checkAdminToken(env, request) ?? (await handleSeedCatalog(request, env));
      } else if (url.pathname === "/admin/replace-catalog" && request.method === "POST") {
        response = checkAdminToken(env, request) ?? (await handleReplaceCatalog(request, env));
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
