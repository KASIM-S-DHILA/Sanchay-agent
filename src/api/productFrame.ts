import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { checkRateLimit, clientIp, rateLimitedResponse } from "../middleware/rateLimit";
import { logApiCall } from "../middleware/audit";

// Serves ONE catalog product's photo bytes to the browser so the Live
// voice session can look at it via sendRealtimeInput({video}) — Tier-2
// "eyes on demand" (see the look_at_product tool in
// frontend/src/hooks/useGeminiLive.ts). The stored visual_description
// (Tier 1) answers most questions from D1 alone; this exists for the
// detail questions a written summary can miss (stitching, logos, exact
// shade, counts).
//
// Security boundary is the D1 allowlist below: product_id must match a
// real products row, and only THAT row's stored image_url is ever
// fetched — client-supplied URLs are never accepted (attacker images
// are a prompt-injection channel). Session-authenticated +
// rate-limited like /api/describe-products.
const FETCH_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

export async function handleProductFrame(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/product-frame");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  // Same generous-but-bounded shape as describe_products: frames cost
  // context per call, so an uncapped caller (or model loop) must not be
  // able to burn budget without a ceiling.
  const sessionLimit = await checkRateLimit(env, `product_frame:session:${session.id}`, 40, 60);
  if (!sessionLimit.allowed) return rateLimitedResponse();
  const ipLimit = await checkRateLimit(env, `product_frame:ip:${clientIp(request)}`, 100, 60);
  if (!ipLimit.allowed) return rateLimitedResponse();

  let body: { product_id?: unknown } = {};
  try { body = await request.json(); } catch { }

  const productId = typeof body.product_id === "string" ? body.product_id.trim() : "";

  const started = Date.now();
  const log = (response: Record<string, unknown>, status: "ok" | "error" | "blocked") =>
    logApiCall(env, {
      sessionId: session.id,
      endpoint: "/api/product-frame",
      method: "POST",
      params: { product_id: productId || null },
      response,
      durationMs: Date.now() - started,
      status,
    }).catch((e) => console.error("api_call_log write failed:", e));

  if (!productId) {
    const res = { success: false, error: "product_id is required — pass one exact catalog id." };
    await log(res, "error");
    return Response.json(res, { status: 400 });
  }

  const row: { id: string; name: string; image_url: string | null } | null = await env.DB.prepare(
    `SELECT id, name, image_url FROM products WHERE id = ?`,
  ).bind(productId).first();

  if (!row) {
    const res = { success: false, error: `No product found for id "${productId}".` };
    await log(res, "error");
    return Response.json(res, { status: 404 });
  }
  if (!row.image_url) {
    const res = { success: false, error: `"${row.name}" has no photo to show.` };
    await log(res, "error");
    return Response.json(res, { status: 502 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(row.image_url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const errBody = { success: false, error: "The product photo couldn't be fetched right now." };
      await log(errBody, "error");
      return Response.json(errBody, { status: 502 });
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      const errBody = { success: false, error: "The product photo URL didn't return an image." };
      await log(errBody, "error");
      return Response.json(errBody, { status: 502 });
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      const errBody = { success: false, error: "The product photo is too large to show in-call." };
      await log(errBody, "error");
      return Response.json(errBody, { status: 502 });
    }
    // Raw bytes as base64 — the browser downscales via canvas before
    // sending (token economy), but the SOURCE bytes always come from
    // this allowlisted fetch, never from a client-supplied URL.
    const responseBody = {
      success: true,
      data: {
        productId: row.id,
        name: row.name,
        mimeType: contentType.split(";")[0],
        imageBase64: arrayBufferToBase64(buf),
      },
    };
    await log({ success: true, data: { productId: row.id } }, "ok");
    return Response.json(responseBody);
  } catch (e: any) {
    const timedOut = e?.name === "AbortError";
    console.error("product-frame: image fetch failed:", e);
    const errBody = {
      success: false,
      error: timedOut ? "Fetching the photo took too long — try again." : "Request failed unexpectedly.",
    };
    await log(errBody, "error");
    return Response.json(errBody, { status: timedOut ? 504 : 500 });
  }
}
