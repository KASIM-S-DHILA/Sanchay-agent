import { hmacSHA256 } from "../crypto";

function b64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str: string): string {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
}
export async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const h = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const b = b64urlEncode(JSON.stringify(payload));
  const d = `${h}.${b}`;
  const hex = await hmacSHA256(d, secret);
  const sig = b64urlEncodeBytes(new Uint8Array(hex.match(/.{2}/g)!.map((x) => parseInt(x, 16))));
  return `${d}.${sig}`;
}
export async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const p = token.split(".");
  if (p.length !== 3) return null;
  const [h, b, s] = p;
  const d = `${h}.${b}`;
  const hex = await hmacSHA256(d, secret);
  const expSig = b64urlEncodeBytes(new Uint8Array(hex.match(/.{2}/g)!.map((x) => parseInt(x, 16))));
  if (s !== expSig) return null;
  try {
    const payload = JSON.parse(b64urlDecode(b));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}
export async function getAuthUser(request: Request, env: { JWT_SIGNING_KEY?: string }): Promise<string | null> {
  const a = request.headers.get("Authorization") || "";
  const t = a.startsWith("Bearer ") ? a.slice(7).trim() : "";
  if (!t) return null;
  const s = (env as any).JWT_SIGNING_KEY || "your_jwt_signing_key";
  const p = await verifyJWT(t, s);
  if (!p || typeof p.sub !== "string") return null;
  return p.sub as string;
}

/**
 * Strengthens an already-validated session with an optional auth check.
 *
 * No Authorization header at all: behaves exactly like guest-only
 * validateSession always has — the session is trusted as-is. This is the
 * default for every existing endpoint and keeps guest checkout working
 * unchanged.
 *
 * Authorization header present: it must verify AND its `sub` must match
 * the session's own user_id, or the request is rejected even though the
 * x-session-id itself was valid. This stops a caller who holds someone
 * else's session id (e.g. leaked from a shared link or captured in a log)
 * from acting on it while presenting a token for a different account —
 * without this check, a bearer token would only prove "I am someone", not
 * "I am the owner of THIS session".
 *
 * A session with no user_id (anonymous/guest) presenting a valid bearer
 * token is accepted — that's the normal "sign in mid-shop" path handled by
 * migrateGuestSessionToUser, not a mismatch.
 */
export async function validateSessionWithAuth(
  request: Request,
  env: { JWT_SIGNING_KEY?: string },
  session: { userId: string | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return { ok: true };

  const authedUserId = await getAuthUser(request, env);
  if (!authedUserId) return { ok: false, reason: "invalid_or_expired_token" };

  if (session.userId && session.userId !== authedUserId) {
    return { ok: false, reason: "token_does_not_own_session" };
  }
  return { ok: true };
}
