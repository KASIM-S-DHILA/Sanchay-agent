import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { checkRateLimit, clientIp, rateLimitedResponse } from "../middleware/rateLimit";
import { logApiCall } from "../middleware/audit";

// Text-only model for answering a shopper's question about a product from
// its STORED visual_description (see catalog/visualDescribe.ts) — never
// touches the image itself. gemini-3.7-flash is the current GA Flash model
// per the Gemini skill (2.x models are deprecated). This is now a small
// text-only completion, not a vision call, so latency/cost are both a
// fraction of what the old live-vision path was.
const TEXT_MODEL = "gemini-3.7-flash";
// Matches the floating-window cap (see useProductWindows.ts) — a shopper
// can never have more than this many windows open at once, so this is
// already the natural ceiling; enforced independently here too so a
// caller bypassing the frontend (a raw tool call with a hand-built
// product_ids array) can't push past it either.
const MAX_IMAGES_PER_CALL = 4;

interface ProductRow {
  id: string;
  name: string;
  category: string;
  visual_description: string | null;
}

/**
 * POST /api/describe-products — answers what a shopper sees/asks about a
 * product's photo WITHOUT ever calling a vision model at request time.
 *
 * This used to be a one-shot multimodal Gemini call that fetched the
 * product image and asked Gemini to describe/compare it live, mid-voice-
 * call — measured in production anywhere from ~3s to 45+ seconds, which is
 * a genuinely damaging amount of dead air in a live voice conversation.
 * Per the agreed fix, every product's photo is now summarized ONCE, ahead
 * of time, right after it's seeded (see admin.ts calling
 * generateVisualDescriptions, and catalog/visualDescribe.ts for the actual
 * vision call and prompt). This endpoint now only ever does two things,
 * both fast:
 *   1. No question asked → return the stored description(s) directly.
 *      Plain D1 read, no LLM call at all.
 *   2. A question asked (e.g. a comparison) → one small TEXT-ONLY
 *      completion combining the question with the stored description(s).
 *      No image fetch, no vision call — just text in, text out.
 *
 * A real tradeoff this accepts: if a shopper asks about a specific visual
 * detail the seed-time summary didn't mention, there is no live fallback
 * that re-looks at the photo. The stored description is written to be
 * thorough specifically to keep this rare in practice (see the prompt in
 * visualDescribe.ts), but it is not exhaustive by construction.
 *
 * product_ids is OPTIONAL and, per the design discussion, is expected to
 * be omitted in the common case: the frontend passes whatever product ids
 * are CURRENTLY OPEN as floating detail windows (the shopper is already
 * looking at these photos on screen) rather than the model needing to
 * name specific ids itself. Explicit product_ids is the fallback path —
 * describing something straight from search results, before any window
 * is open. Both paths converge on the same logic below; the only
 * difference is where the id list comes from, which is entirely the
 * CALLER's (frontend's) responsibility to resolve — this endpoint has no
 * concept of "which windows are open", by design, since window state is
 * ephemeral frontend UI state, never persisted.
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
    await env.DB.prepare(
      `SELECT id, name, category, visual_description FROM products WHERE id IN (${placeholders})`,
    )
      .bind(...productIds)
      .all<ProductRow>()
  ).results ?? [];

  if (rows.length === 0) {
    const res = { success: false, error: "None of those product ids were found." };
    await log(res, "error");
    return Response.json(res, { status: 404 });
  }

  // "Failed" is redefined from the old live-vision meaning ("the image
  // didn't load over HTTP right now") to "no stored description exists for
  // this product" — e.g. the seed-time vision call failed or hasn't run
  // yet for a newly added product. Either way, this endpoint has nothing
  // to say about that product until generateVisualDescriptions backfills
  // it (see catalog/visualDescribe.ts, run from /admin/seed-catalog).
  const described = rows.filter((r) => !!r.visual_description);
  const failed = rows.filter((r) => !r.visual_description).map((r) => r.name);

  if (described.length === 0) {
    const res = {
      success: false,
      error: "No visual description is available yet for those product(s) — they may not have finished being processed.",
      data: { failedToLoad: failed },
    };
    await log(res, "error");
    return Response.json(res, { status: 502 });
  }

  // No question → hand back the stored description(s) directly. Plain D1
  // read already happened above; this is the near-zero-latency path with
  // no LLM call at all.
  if (!question) {
    const description = described
      .map((r) => `${r.name} (${r.category}): ${r.visual_description}`)
      .join("\n\n");
    const responseBody = {
      success: true,
      data: {
        description,
        describedProductIds: described.map((r) => r.id),
        failedToLoad: failed,
      },
    };
    await log(responseBody, "ok");
    return Response.json(responseBody);
  }

  // A question was asked (often a comparison across multiple open
  // windows) — one small TEXT-ONLY completion combining the question with
  // the stored description(s). No image fetch, no vision call.
  const promptText =
    `A shopper is looking at these product(s) and asked: "${question}". Using ONLY the descriptions ` +
    `below (you cannot see the actual photos), answer their question directly in 1-3 sentences. If ` +
    `comparing multiple items, be specific about which is which by name.\n\n` +
    described.map((r) => `${r.name} (${r.category}): ${r.visual_description}`).join("\n\n");

  // Generous relative to how fast a text-only completion normally is, but
  // nowhere near the old vision timeout — there's no image to wait on
  // anymore, so a real hang here would be unusual.
  const TEXT_TIMEOUT_MS = 15_000;
  const storedFallback = () => ({
    success: true,
    data: {
      description: described
        .map((r) => `${r.name} (${r.category}): ${r.visual_description}`)
        .join("\n\n"),
      describedProductIds: described.map((r) => r.id),
      failedToLoad: failed,
      fallback: true,
    },
  });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEXT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: promptText }] }] }),
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
    const json: any = await res.json();
    // Text-model outage fallback: Google 503'd consistently in prod
    // ("high demand", UNAVAILABLE) for both 3.8 and 3.7-flash — a
    // hard 502 here would stall the voice call with nothing to say.
    // The stored descriptions already answer most questions well
    // enough, so degrade to the no-question path (D1-only, ~0.4s)
    // instead of failing. ponytail: no retry/backoff, fallback covers it.
    if (!res.ok) {
      console.error("describe-products: Gemini text call non-ok:", res.status, JSON.stringify(json).slice(0, 500));
      const fallbackBody = storedFallback();
      await log({ ...fallbackBody, _textError: res.status }, "ok");
      return Response.json(fallbackBody);
    }
    const text: string = json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    const responseBody = {
      success: true,
      data: {
        description: text || "Couldn't come up with an answer from the stored description.",
        describedProductIds: described.map((r) => r.id),
        failedToLoad: failed,
      },
    };
    await log(responseBody, "ok");
    return Response.json(responseBody);
  } catch (e: any) {
    console.error("describe-products: text completion failed:", e);
    const fallbackBody = storedFallback();
    await log({ ...fallbackBody, _textError: e?.name ?? "unknown" }, "ok");
    return Response.json(fallbackBody);
  }
}
