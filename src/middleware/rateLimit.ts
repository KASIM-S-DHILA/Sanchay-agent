import type { Env } from "../types";

/**
 * Fixed-window rate limiter backed by the `rate_limits` D1 table (see
 * schema.sql). Used for otp send/verify, token mint, and checkout — actions
 * cheap to call but expensive to abuse (spam an inbox, brute-force a code,
 * mint unlimited JWTs).
 *
 * `key` must already encode both the action and the caller (e.g.
 * `otp_send:ip:1.2.3.4`) — this function only tracks counts, it doesn't
 * know what's being limited.
 *
 * Not perfectly race-free under true concurrency (two requests in the same
 * millisecond can both read count=N and both write N+1, so on a very tight
 * race a caller could get one request past the true limit) — an
 * UPDATE...RETURNING-based single-statement version would close that, but
 * D1's SQLite dialect makes that awkward across the insert-vs-update split
 * this needs. Good enough for its purpose: throttling abuse, not enforcing
 * a hard security boundary.
 */
export async function checkRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, window_start FROM rate_limits WHERE key = ?")
    .bind(key)
    .first<{ count: number; window_start: string }>();

  if (!row || now - new Date(row.window_start).getTime() >= windowSeconds * 1000) {
    // No row, or the existing window has expired — start a fresh one.
    await env.DB.prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start`,
    )
      .bind(key, new Date(now).toISOString())
      .run();
    return { allowed: true, remaining: limit - 1 };
  }

  if (row.count >= limit) {
    return { allowed: false, remaining: 0 };
  }

  await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").bind(key).run();
  return { allowed: true, remaining: limit - row.count - 1 };
}

/**
 * Opportunistic cleanup for rows that would otherwise accumulate forever —
 * there's no scheduled/cron Worker in this project, so instead of adding
 * one just for housekeeping, every call has a small (~2%) chance of also
 * sweeping rows old enough that no live rate-limit window or valid OTP
 * could still reference them. Best-effort: a failure here must never
 * affect the caller's actual rate-limit check or OTP verification.
 */
export async function maybeCleanupExpiredRows(env: Env): Promise<void> {
  if (Math.random() >= 0.02) return;
  try {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM otps WHERE created_at < ?").bind(cutoff),
      // api_call_log had NO cleanup at all and no read of it was ever
      // capped either — the frontend polls GET /api/audit every 3 seconds
      // for as long as a session/tab stays open, so a single long-lived
      // session accumulated ~4,000 rows in one real session, at which
      // point every poll (parsing every row's params_json/response_json
      // twice, in JS) started exceeding the Worker's CPU time limit
      // outright — not just breaking the audit feed, but taking other
      // requests down with it under the same overloaded isolate. GET
      // /api/audit is now separately capped to the most recent 200 rows
      // (see handleAudit) as the immediate fix; this prevents the table
      // from growing unbounded in the first place.
      env.DB.prepare("DELETE FROM api_call_log WHERE created_at < ?").bind(cutoff),
    ]);
  } catch (e) {
    console.error("maybeCleanupExpiredRows failed:", e);
  }
}

/** Best-effort client IP for rate-limit keys — Cloudflare's header, with a
 *  fallback for local dev where it's absent. */
export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/**
 * Shared 429 response shape for every rate-limited endpoint, so a throttled
 * caller sees the same error format everywhere.
 */
export function rateLimitedResponse(): Response {
  return Response.json(
    { success: false, error: "Too many requests — please wait a moment and try again" },
    { status: 429 },
  );
}
