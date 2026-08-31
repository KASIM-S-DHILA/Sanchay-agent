import { SELF } from "cloudflare:test";

/**
 * Shared OTP sign-in helper for evals that need a REAL, verified bearer
 * token — not just a session with sessions.user_id set (that can also come
 * from the older, unauthenticated startSession({user_email}) path, which
 * is deliberately NOT sufficient to pass handleCheckout's sign-in gate;
 * see the comment there). Any test exercising checkout must go through
 * this to get a token that will actually be accepted.
 */

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Inserts a known-plaintext OTP directly into D1, bypassing the send
 *  pipeline (Resend/Turnstile) entirely — mirrors the exact hash
 *  handleAuthOtpVerify expects. */
export async function seedOtp(env: any, email: string, code: string): Promise<void> {
  const codeHash = await sha256Hex(code);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO otps (id, email, code_hash, purpose, attempts, expires_at, created_at)
     VALUES (?, ?, ?, 'sign_in', 0, ?, ?)`,
  )
    .bind(crypto.randomUUID(), email, codeHash, new Date(now + 5 * 60 * 1000).toISOString(), new Date(now).toISOString())
    .run();
}

/**
 * Signs in on the given session (which must already exist) and returns the
 * bearer token — the session is migrated onto the account exactly like a
 * real shopper signing in mid-shop, so its cart/history survive.
 *
 * otp_verify is rate-limited per IP (5/5min), and every SELF.fetch call in
 * the test environment shares the same "unknown" IP bucket — clears that
 * bucket first so repeated calls across a test file don't 429.
 */
export async function signIn(env: any, sessionId: string, email: string): Promise<string> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = 'otp_verify:ip:unknown'").run();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await seedOtp(env, email, code);
  const res = await SELF.fetch("https://test/api/auth/otp/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ email, code, sessionId }),
  });
  const data: any = await res.json();
  if (!data.success || !data.data?.token) {
    throw new Error(`signIn helper failed: ${JSON.stringify(data)}`);
  }
  return data.data.token as string;
}
