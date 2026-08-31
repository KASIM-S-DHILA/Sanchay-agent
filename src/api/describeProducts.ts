import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { checkRateLimit, clientIp, rateLimitedResponse } from "../middleware/rateLimit";
import { logApiCall } from "../middleware/audit";

const VISION_MODEL = "gemini-2.0-flash";
// Matches the floating-window cap (see useProductWindows.ts) — a shopper
// can never have more than this many windows open at once, so this is
// already the natural ceiling; enforced independently here too so a
// caller bypassing the frontend (a raw tool call with a hand-built
// product_ids array) can't push past it either.
const MAX_IMAGES_PER_CALL = 4;
const FETCH_TIMEOUT_MS = 6000;

interface ProductRow {
  id: string;
  name: string;
  description: string;
  category: string;
  image_url: string | null;
}

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    // Cap the actual decoded size, not just trust content-length (which can
    // be absent or wrong) — a single oversized image shouldn't be able to
    // blow up the base64 conversion or the eventual Gemini request body.
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const bytes = new Uint8Array(buf);
    let binary = "";
    // Chunked to avoid call-stack limits String.fromCharCode(...bytes) hits
    // on large arrays.
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return { data: btoa(binary), mimeType: contentType.split(";")[0] };
  } catch {
    return null; // network error, timeout, or abort — treated as "couldn't load this one"
  }
}

/**
 * POST /api/describe-products — one-shot (non-Live) multimodal call so
 * Gemini can genuinely SEE product photos, without touching the Live
 * voice session at all. Deliberately kept outside the Live WebSocket:
 * Google's own docs say audio-only Live sessions get 15 minutes, but
 * audio+VIDEO sessions are capped at 2 minutes — sending even one image
 * through the Live session's video channel would reclassify it and blow
 * away the 15-minute budget the checkout-timer/payment-expiry work
 * already depends on. A plain generateContent call has none of that
 * session-duration coupling.
 *
 * product_ids is OPTIONAL and, per the design discussion, is expected to
 * be omitted in the common case: the frontend passes whatever product ids
 * are CURRENTLY OPEN as floating detail windows (the shopper is already
 * looking at these photos on screen) rather than the model needing to
 * name specific ids itself. Explicit product_ids is the fallback path —
 * describing something straight from search results, before any window
 * is open. Both paths converge on the same image-fetch + single-call
 * logic below; the only difference is where the id list comes from,
 * which is entirely the CALLER's (frontend's) responsibility to resolve —
 * this endpoint has no concept of "which windows are open", by design,
 * since window state is ephemeral frontend UI state, never persisted.
 */
export async function handleDescribeProducts(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/describe-products");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  // Deliberately more generous than other tool-backed endpoints — per the
  // explicit product decision, vision is core to the shopping experience
  // and must not feel throttled during normal use (a shopper asking about
  // several items back-to-back is completely ordinary). Still bounded:
  // this makes a REAL external Gemini API call with real cost per
  // invocation, so an unlimited rate would let a runaway model loop (or a
  // caller bypassing the frontend) run up API spend with no ceiling at all.
  const sessionLimit = await checkRateLimit(env, `describe_products:session:${session.id}`, 40, 60);
  if (!sessionLimit.allowed) return rateLimitedResponse();
  const ipLimit = await checkRateLimit(env, `describe_products:ip:${clientIp(request)}`, 100, 60);
  if (!ipLimit.allowed) return rateLimitedResponse();

  let body: { product_ids?: unknown; question?: unknown } = {};
  try { body = await request.json(); } catch { }

  const rawIds = Array.isArray(body.product_ids) ? body.product_ids : [];
  const productIds = [...new Set(rawIds.map((v) => String(v).trim()).filter(Boolean))].slice(0, MAX_IMAGES_PER_CALL);
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 500) : "";

  const started = Date.now();
  const log = (response: Record<string, unknown>, status: "ok" | "error" | "blocked") =>
    logApiCall(env, {
      sessionId: session.id,
      endpoint: "/api/describe-products",
      method: "POST",
      params: { product_ids: productIds, question: question || null },
      response,
      durationMs: Date.now() - started,
      status,
    }).catch((e) => console.error("api_call_log write failed:", e));

  if (productIds.length === 0) {
    const res = {
      success: false,
      error: "Nothing to describe — no product ids were given and no product windows are open. Search for or open something first.",
    };
    await log(res, "error");
    return Response.json(res, { status: 400 });
  }

  const placeholders = productIds.map(() => "?").join(",");
  const rows: ProductRow[] = (
    await env.DB.prepare(`SELECT id, name, description, category, image_url FROM products WHERE id IN (${placeholders})`)
      .bind(...productIds)
      .all<ProductRow>()
  ).results ?? [];

  if (rows.length === 0) {
    const res = { success: false, error: "None of those product ids were found." };
    await log(res, "error");
    return Response.json(res, { status: 404 });
  }

  const imageResults = await Promise.all(
    rows.map(async (r) => ({ row: r, image: r.image_url ? await fetchImageAsBase64(r.image_url) : null })),
  );

  const loaded = imageResults.filter((r) => r.image !== null);
  const failed = imageResults.filter((r) => r.image === null).map((r) => r.row.name);

  if (loaded.length === 0) {
    const res = {
      success: false,
      error: "Couldn't load any of those product photos right now — the images may be temporarily unreachable.",
      data: { failedToLoad: failed },
    };
    await log(res, "error");
    return Response.json(res, { status: 502 });
  }

  const promptText = question
    ? `A shopper is looking at these product photo(s) and asked: "${question}". Answer their question directly, in 1-3 sentences, based on what you actually see in the image(s). If comparing multiple, be specific about which is which by name.`
    : `Describe what you see in each of these product photo(s) in 1-2 sentences per item — color, visible material/texture, notable design details (buttons, collar, pockets, pattern, etc.). Refer to each by its name. Be concise and factual about what's visible, not marketing language.`;

  const parts: any[] = [{ text: promptText }];
  for (const { row, image } of loaded) {
    parts.push({ text: `Product: ${row.name} (${row.category}).` });
    parts.push({ inlineData: { mimeType: image!.mimeType, data: image!.data } });
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }] }),
      },
    );
    const json: any = await res.json();
    if (!res.ok) {
      const errBody = { success: false, error: json?.error?.message || `Vision request failed: ${res.status}` };
      await log(errBody, "error");
      return Response.json(errBody, { status: 502 });
    }
    const text: string = json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    const responseBody = {
      success: true,
      data: {
        description: text || "Couldn't make out enough detail in the photo to describe it.",
        describedProductIds: loaded.map((r) => r.row.id),
        failedToLoad: failed,
      },
    };
    await log(responseBody, "ok");
    return Response.json(responseBody);
  } catch (e) {
    console.error("describe-products: vision call failed:", e);
    const errBody = { success: false, error: "Vision request failed unexpectedly." };
    await log(errBody, "error");
    return Response.json(errBody, { status: 500 });
  }
}
