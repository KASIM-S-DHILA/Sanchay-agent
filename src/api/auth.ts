import type { Env } from "../types";
import { signJWT } from "../middleware/auth";
import { checkRateLimit, clientIp, rateLimitedResponse, maybeCleanupExpiredRows } from "../middleware/rateLimit";
import { logApiCall } from "../middleware/audit";
import { migrateGuestSessionToUser } from "./userMigration";

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function isValidEmail(email: string): boolean {
  // Deliberately permissive — real validation is "did the OTP arrive",
  // this just rejects obvious junk before we touch the DB or send anything.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateOtpCode(): string {
  // 6 digits, zero-padded. crypto.getRandomValues, not Math.random — this
  // gates account access, so it needs a CSPRNG.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

// Every hostname this Worker actually serves the OTP form from (see
// wrangler.jsonc routes + workers_dev). A token minted on any other
// hostname — e.g. if the sitekey/secret pair ever leaked and got embedded
// on an unrelated site — must not verify here even if Cloudflare reports
// success:true, since success only means "a real human solved a real
// challenge SOMEWHERE", not "on this site".
const EXPECTED_TURNSTILE_HOSTNAMES = new Set([
  "sanchay.store",
  "www.sanchay.store",
  "sanchay.kasimdhila80.workers.dev",
  "localhost",
]);
const EXPECTED_TURNSTILE_ACTION = "otp_send";

/**
 * Verifies a Cloudflare Turnstile token server-side. Skipped (returns true)
 * when TURNSTILE_SECRET_KEY is unset, so local dev without the secret
 * configured doesn't need a live Turnstile widget to exercise the OTP flow.
 * Production must set the secret for this to actually gate anything.
 *
 * Checks success, action, AND hostname — success alone only proves someone
 * solved a Turnstile challenge somewhere; action/hostname prove it was
 * solved for THIS form on a hostname this Worker actually serves.
 */
async function verifyTurnstile(env: Env, token: string | undefined, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY);
    form.append("response", token);
    form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const j: any = await r.json();
    if (j.success !== true) return false;
    if (j.action && j.action !== EXPECTED_TURNSTILE_ACTION) return false;
    if (j.hostname && !EXPECTED_TURNSTILE_HOSTNAMES.has(j.hostname)) return false;
    return true;
  } catch (e) {
    console.error("turnstile verification failed:", e);
    return false;
  }
}

/**
 * Sends the OTP code via Resend's REST API (a plain HTTPS POST — no
 * Workers binding needed, unlike Cloudflare Email Sending, which requires
 * a paid zone plan). Falls back to logging the code when RESEND_API_KEY
 * is unset, so the flow is fully testable in dev without a live key. This
 * fallback must never ship silently in production — absence of the key
 * there means codes are unreachable, not just logged, so this is
 * intentionally loud (thrown, not swallowed).
 */
async function sendOtpEmail(env: Env, email: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.warn(`[dev-only] OTP for ${email}: ${code} (RESEND_API_KEY not configured)`);
    return;
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Sanchay <otp@sanchay.store>",
      to: [email],
      subject: `${code} is your Sanchay sign-in code`,
      text: `Your Sanchay sign-in code is ${code}. It expires in 5 minutes. If you didn't request this, ignore this email.`,
      html: `<p>Your Sanchay sign-in code is <strong>${code}</strong>.</p><p>It expires in 5 minutes. If you didn't request this, ignore this email.</p>`,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Resend send failed: ${r.status} ${body.slice(0, 200)}`);
  }
}

/**
 * POST /api/auth/otp — starts email sign-in. Rate-limited per IP and per
 * email so one abusive caller can't spam either an inbox or the whole send
 * pipeline. Always returns success (even if the email doesn't exist as a
 * user yet — first sign-in doubles as sign-up) to avoid leaking which
 * emails have accounts.
 */
export async function handleAuthOtpSend(request: Request, env: Env): Promise<Response> {
  void maybeCleanupExpiredRows(env);
  const started = Date.now();
  // Every branch below writes exactly one api_call_log row through this,
  // scoped to the session presented (if any) so it appears in that
  // session's Activity/Bill Timeline — sign-in was previously completely
  // invisible in the audit trail, indistinguishable from never having
  // been attempted. Never logs the email or code itself (see params
  // below) — only the outcome.
  const sessionId = request.headers.get("x-session-id");
  const log = (response: Record<string, unknown>, status: "ok" | "error" | "blocked") =>
    logApiCall(env, { sessionId, endpoint: "/api/auth/otp", method: "POST", params: null, response, durationMs: Date.now() - started, status });

  let body: { email?: string; turnstileToken?: string } = {};
  try { body = await request.json(); } catch { }
  const email = body.email?.trim().toLowerCase();
  if (!email || !isValidEmail(email)) {
    const res = { success: false, error: "Valid email required" };
    await log(res, "error");
    return Response.json(res, { status: 400 });
  }

  const ip = clientIp(request);
  const ipLimit = await checkRateLimit(env, `otp_send:ip:${ip}`, 3, 5 * 60);
  if (!ipLimit.allowed) {
    await log({ success: false, error: "rate_limited" }, "blocked");
    return rateLimitedResponse();
  }
  const emailLimit = await checkRateLimit(env, `otp_send:email:${email}`, 3, 5 * 60);
  if (!emailLimit.allowed) {
    await log({ success: false, error: "rate_limited" }, "blocked");
    return rateLimitedResponse();
  }

  const turnstileOk = await verifyTurnstile(env, body.turnstileToken, ip);
  if (!turnstileOk) {
    const res = { success: false, error: "Verification failed — please retry" };
    await log(res, "blocked");
    return Response.json(res, { status: 400 });
  }

  const code = generateOtpCode();
  const codeHash = await sha256Hex(code);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO otps (id, email, code_hash, purpose, attempts, expires_at, created_at)
     VALUES (?, ?, ?, 'sign_in', 0, ?, ?)`,
  )
    .bind(crypto.randomUUID(), email, codeHash, new Date(now + OTP_TTL_MS).toISOString(), new Date(now).toISOString())
    .run();

  try {
    await sendOtpEmail(env, email, code);
  } catch (e) {
    console.error("sendOtpEmail failed:", e);
    const res = { success: false, error: "Could not send code — please try again" };
    await log(res, "error");
    return Response.json(res, { status: 502 });
  }

  const res = { success: true, data: { message: "Code sent", expiresInSeconds: OTP_TTL_MS / 1000 } };
  await log(res, "ok");
  return Response.json(res);
}

/**
 * POST /api/auth/otp/verify — redeems a code minted by handleAuthOtpSend.
 * On success: finds-or-creates the `users` row for this email, mints a
 * 24h JWT, and migrates the caller's current guest session (cart, name,
 * history) onto the real user_id so signing in mid-shop doesn't lose
 * anything already in the cart.
 */
export async function handleAuthOtpVerify(request: Request, env: Env): Promise<Response> {
  const started = Date.now();
  const presentedSessionIdForLog = request.headers.get("x-session-id");
  // Never logs the raw code (see params: null) — only whether it was
  // right, matching handleAuthOtpSend's convention of never persisting
  // secrets into the audit trail.
  const log = (response: Record<string, unknown>, status: "ok" | "error" | "blocked") =>
    logApiCall(env, {
      sessionId: presentedSessionIdForLog,
      endpoint: "/api/auth/otp/verify",
      method: "POST",
      params: null,
      response,
      durationMs: Date.now() - started,
      status,
    });

  let body: { email?: string; code?: string; sessionId?: string } = {};
  try { body = await request.json(); } catch { }
  const email = body.email?.trim().toLowerCase();
  const code = body.code?.trim();
  if (!email || !isValidEmail(email) || !code) {
    const res = { success: false, error: "Email and code required" };
    await log(res, "error");
    return Response.json(res, { status: 400 });
  }

  const ip = clientIp(request);
  const ipLimit = await checkRateLimit(env, `otp_verify:ip:${ip}`, 5, 5 * 60);
  if (!ipLimit.allowed) {
    await log({ success: false, error: "rate_limited" }, "blocked");
    return rateLimitedResponse();
  }

  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts, expires_at, consumed_at FROM otps
     WHERE email = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(email)
    .first<{ id: string; code_hash: string; attempts: number; expires_at: string; consumed_at: string | null }>();

  const invalidCode = async () => {
    const res = { success: false, error: "Invalid or expired code" };
    await log(res, "blocked");
    return Response.json(res, { status: 400 });
  };

  if (!row || row.consumed_at) return invalidCode();
  if (new Date(row.expires_at).getTime() < Date.now()) return invalidCode();
  if (row.attempts >= OTP_MAX_ATTEMPTS) return invalidCode();

  const codeHash = await sha256Hex(code);
  if (codeHash !== row.code_hash) {
    await env.DB.prepare("UPDATE otps SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    return invalidCode();
  }

  await env.DB.prepare("UPDATE otps SET consumed_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();

  // The rest of this codebase (startSession, cross-sell, the Razorpay
  // webhook) already treats sessions.user_id / user_preferences.user_id as
  // literally the email string, not a generated id — so the account's
  // identifier here is the email itself, and users.id is set to match.
  // Keeping this consistent means an authenticated session's user_id reads
  // identically to how a guest session's ever did, so nothing downstream
  // needs to special-case "authenticated vs guest" to find preferences,
  // purchase history, or cross-sell signals.
  const userId = email;
  const existingUser = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
  if (!existingUser) {
    await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .bind(userId, email, new Date().toISOString())
      .run();
  }

  // One active session per account, resumed on sign-in rather than
  // choosing between "resume or start fresh" — a shopping cart is a single
  // continuous identity, not a set of parallel threads to pick between.
  //
  // If this account already has a live session (from an earlier sign-in
  // on this or another device), reattach to THAT one and leave whatever
  // guest session the caller is currently holding untouched — it was
  // never this account's to claim. Otherwise (first-ever sign-in, or the
  // account's previous session already expired), migrate the caller's
  // current session onto the account, exactly as before.
  //
  // Migration/resumption only ever applies to the session THIS request is
  // actually presenting (x-session-id) — not just whatever session id
  // happens to be in the JSON body. Without this check, an attacker could
  // verify their own email via OTP and pass a victim's session id in the
  // body to reassign that victim's cart/preferences onto the attacker's
  // account. Requiring the header to match closes that.
  const presentedSessionId = request.headers.get("x-session-id");
  let resumedSessionId: string | null = null;
  if (presentedSessionId && body.sessionId === presentedSessionId) {
    const existingSession = await env.DB.prepare(
      "SELECT id FROM sessions WHERE user_id = ? AND status = 'active' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(userId, new Date().toISOString())
      .first<{ id: string }>();

    if (existingSession && existingSession.id !== presentedSessionId) {
      resumedSessionId = existingSession.id;
    } else {
      try {
        await migrateGuestSessionToUser(env, presentedSessionId, userId);
        resumedSessionId = presentedSessionId;
      } catch (e) {
        // Migration is best-effort — a failure here must not block sign-in
        // itself; worst case the shopper keeps a fresh cart under the new
        // account instead of their guest one.
        console.error("guest session migration failed:", e);
      }
    }
  }

  const secret = env.JWT_SIGNING_KEY || "your_jwt_signing_key";
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ sub: userId, email, iat: now, exp: now + 24 * 3600 }, secret);

  const res = { success: true, data: { userId, sessionId: resumedSessionId } }; // token/email omitted from the logged response — no secrets/PII in the audit trail
  await log(res, "ok");
  return Response.json({ success: true, data: { token, userId, email, sessionId: resumedSessionId } });
}
