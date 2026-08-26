import type { Env } from "../types";

export interface LogMeta {
  sessionId: string | null;
  endpoint: string;
  method: string;
  params?: Record<string, unknown> | null;
}

export type ApiResult = { body: Record<string, unknown>; status?: number };

export function json(body: Record<string, unknown>, status = 200): ApiResult {
  return { body, status };
}

/**
 * Wraps an API handler: times it, serializes the JSON response, and writes
 * the call to api_call_log. This log IS the audit trail.
 */
export async function withApiLogging(
  env: Env,
  meta: LogMeta,
  fn: () => Promise<ApiResult>,
): Promise<Response> {
  const started = Date.now();
  let result: ApiResult;
  try {
    result = await fn();
  } catch (e) {
    console.error(`${meta.method} ${meta.endpoint} failed:`, e);
    result = { body: { success: false, error: "Internal server error" }, status: 500 };
  }

  const status =
    result.body.success === false
      ? result.status === 401 || result.status === 403
        ? "blocked"
        : "error"
      : "ok";

  await logApiCall(env, {
    sessionId: meta.sessionId,
    endpoint: meta.endpoint,
    method: meta.method,
    params: meta.params ?? null,
    response: result.body,
    status,
    durationMs: Date.now() - started,
  }).catch((e) => console.error("api_call_log write failed:", e));

  return Response.json(result.body, { status: result.status ?? 200 });
}

export async function logApiCall(
  env: Env,
  entry: {
    sessionId: string | null;
    endpoint: string;
    method: string;
    params: Record<string, unknown> | null;
    response: Record<string, unknown> | null;
    status: string; // "ok" | "error" | "blocked"
    durationMs: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO api_call_log (id, session_id, endpoint, method, params_json, response_json, status, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      entry.sessionId,
      entry.endpoint,
      entry.method,
      entry.params ? JSON.stringify(entry.params) : null,
      entry.response ? JSON.stringify(entry.response) : null,
      entry.status,
      entry.durationMs,
      new Date().toISOString(),
    )
    .run();
}
