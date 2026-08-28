import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";

function normalizeName(input: string): string | null {
  const m = input.trim().match(/([A-Za-z\u0900-\u097F]{2,30})/);
  if (!m) return null;
  const n = m[1].trim();
  if (!/^[\p{L} ]{2,30}$/u.test(n)) return null;
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

export async function handleSaveName(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/user/name");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }
  if (request.method === "GET") {
    return Response.json({ success: true, data: { name: null } });
  }
  let body: { name?: string } = {};
  try { body = await request.json(); } catch {}
  const raw = String(body.name ?? "").trim();
  const name = normalizeName(raw);
  if (!name) return Response.json({ success: false, error: "Please tell me your first name (2-30 letters)" }, { status: 400 });
  // Minimal: just acknowledge, no DB persistence for guest — keeps greeting flow working
  return Response.json({ success: true, data: { name, persisted: false } });
}
