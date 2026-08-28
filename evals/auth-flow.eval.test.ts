import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

/**
 * Covers the session-identity redesign: one active session per account,
 * resumed on sign-in rather than the caller choosing between "resume or
 * start fresh" (see handleAuthOtpVerify in src/api/auth.ts). Every test
 * here corresponds to a specific bug found and fixed during manual
 * debugging of the auth/session flow — this file exists so those bugs
 * have a regression test instead of relying on hand-querying D1 again.
 */

let env: any;
const START = "https://test/api/session/start";
const KNOWN_CODE = "123456";

async function startSession(body: Record<string, unknown> = {}): Promise<string> {
  const res = await SELF.fetch(START, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  return json.data.sessionId;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Inserts a known-plaintext OTP directly into D1, bypassing
 * handleAuthOtpSend (and therefore Resend/Turnstile) entirely — this test
 * only needs to exercise verify's resumption logic, not the send pipeline,
 * which is exercised separately. Mirrors the exact hash handleAuthOtpVerify
 * expects (sha256Hex of the plaintext code).
 */
async function seedOtp(email: string, code = KNOWN_CODE): Promise<void> {
  const codeHash = await sha256Hex(code);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO otps (id, email, code_hash, purpose, attempts, expires_at, created_at)
     VALUES (?, ?, ?, 'sign_in', 0, ?, ?)`,
  )
    .bind(crypto.randomUUID(), email, codeHash, new Date(now + 5 * 60 * 1000).toISOString(), new Date(now).toISOString())
    .run();
}

async function verifyOtp(email: string, code: string, sessionId: string | null) {
  const res = await SELF.fetch("https://test/api/auth/otp/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "x-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ email, code, sessionId }),
  });
  return res.json() as Promise<any>;
}

async function saveName(sessionId: string, name: string, token?: string) {
  const res = await SELF.fetch("https://test/api/user/name", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-id": sessionId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ name }),
  });
  return res.json() as Promise<any>;
}

async function getName(sessionId: string, token?: string) {
  const res = await SELF.fetch("https://test/api/user/name", {
    method: "GET",
    headers: {
      "x-session-id": sessionId,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  return res.json() as Promise<any>;
}

async function addProduct(sessionId: string, productId: string, quantity = 1) {
  return (
    await SELF.fetch("https://test/api/cart/add", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ product_id: productId, quantity }),
    })
  ).json() as Promise<any>;
}

async function getCart(sessionId: string) {
  const res = await SELF.fetch("https://test/api/cart", { headers: { "x-session-id": sessionId } });
  return res.json() as Promise<any>;
}

/** otp_verify is rate-limited per IP (5/5min), and every SELF.fetch call in
 *  these tests shares the same "unknown" IP bucket (no cf-connecting-ip
 *  header in the test environment) — six-plus verify calls across this file
 *  would otherwise start 429ing partway through. Clearing the bucket before
 *  each verify call tests real behavior (does resumption work?) rather than
 *  incidentally testing the rate limiter, which has its own coverage
 *  elsewhere if needed. */
async function resetVerifyRateLimit(): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = 'otp_verify:ip:unknown'").run();
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Auth flow: first-ever sign-in migrates the current session", () => {
  it("guest session with items in cart survives sign-in, tied to the account", async () => {
    await resetVerifyRateLimit();
    const email = "first-signin@example.com";
    const guestSessionId = await startSession();
    await addProduct(guestSessionId, "TEE-BLACK-001");

    await seedOtp(email);
    const verifyRes = await verifyOtp(email, KNOWN_CODE, guestSessionId);

    expect(verifyRes.success).toBe(true);
    expect(verifyRes.data.token).toBeTruthy();
    // No prior session existed for this account — the guest session itself
    // becomes the account's session, not a new/different one.
    expect(verifyRes.data.sessionId).toBe(guestSessionId);

    // Cart survived the migration.
    const cart = await getCart(guestSessionId);
    expect(cart.data.items.some((i: any) => i.productId === "TEE-BLACK-001")).toBe(true);

    // Session row now belongs to the account.
    const row: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
      .bind(guestSessionId)
      .first();
    expect(row.user_id).toBe(email);
  });
});

describe("Auth flow: session hijack via mismatched sessionId is rejected", () => {
  it("does not migrate a session the caller isn't actually presenting", async () => {
    await resetVerifyRateLimit();
    const email = "hijack-victim@example.com";
    const victimSession = await startSession();
    await addProduct(victimSession, "TEE-BLACK-001");

    // Attacker verifies their own email but claims the victim's session id
    // in the body while presenting a DIFFERENT (or no) x-session-id header.
    await seedOtp(email);
    const res = await SELF.fetch("https://test/api/auth/otp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // no x-session-id header at all
      body: JSON.stringify({ email, code: KNOWN_CODE, sessionId: victimSession }),
    });
    const data: any = await res.json();

    expect(data.success).toBe(true); // sign-in itself still succeeds
    expect(data.data.sessionId).toBeNull(); // but nothing was migrated/resumed

    // Victim's session is untouched — still not attributed to the attacker.
    const row: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
      .bind(victimSession)
      .first();
    expect(row.user_id).not.toBe(email);
  });
});

describe("Auth flow: one active session per account, resumed on re-sign-in", () => {
  it("signing in again on a fresh guest session resumes the account's existing session, not the new guest one", async () => {
    await resetVerifyRateLimit();
    const email = "resume-test@example.com";

    // First sign-in: migrates guestSessionA onto the account.
    const guestSessionA = await startSession();
    await seedOtp(email, "111111");
    const firstVerify = await verifyOtp(email, "111111", guestSessionA);
    expect(firstVerify.success).toBe(true);
    expect(firstVerify.data.sessionId).toBe(guestSessionA);

    // Save a name against the resumed session, to prove it's still reachable later.
    await saveName(guestSessionA, "Priya", firstVerify.data.token);

    // Some time later: shopper opens the app again — App.tsx creates a
    // brand-new anonymous guest session (guestSessionB) before sign-in
    // completes, exactly like a fresh page load with no stored session id.
    const guestSessionB = await startSession();
    expect(guestSessionB).not.toBe(guestSessionA);

    // Signing in again resumes guestSessionA (the account's existing
    // active session) rather than migrating guestSessionB onto the account.
    await resetVerifyRateLimit();
    await seedOtp(email, "222222");
    const secondVerify = await verifyOtp(email, "222222", guestSessionB);
    expect(secondVerify.success).toBe(true);
    expect(secondVerify.data.sessionId).toBe(guestSessionA);
    expect(secondVerify.data.sessionId).not.toBe(guestSessionB);

    // The resumed session still knows the name saved earlier.
    const nameCheck = await getName(guestSessionA, secondVerify.data.token);
    expect(nameCheck.data.name).toBe("Priya");

    // guestSessionB was never touched — still anonymous.
    const rowB: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
      .bind(guestSessionB)
      .first();
    expect(rowB.user_id).toBeNull();
  });

  it("an expired previous session falls back to migrating the current one", async () => {
    await resetVerifyRateLimit();
    const email = "expired-resume@example.com";

    const oldSession = await startSession();
    await seedOtp(email, "333333");
    const firstVerify = await verifyOtp(email, "333333", oldSession);
    expect(firstVerify.data.sessionId).toBe(oldSession);

    // Simulate the old session having expired since.
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), oldSession)
      .run();

    await resetVerifyRateLimit();
    const newSession = await startSession();
    await seedOtp(email, "444444");
    const secondVerify = await verifyOtp(email, "444444", newSession);

    expect(secondVerify.success).toBe(true);
    // No live previous session to resume — the current one is migrated instead.
    expect(secondVerify.data.sessionId).toBe(newSession);
  });
});

describe("Auth flow: name persistence across the resumed session", () => {
  it("a name saved before sign-out is still known when signing back in", async () => {
    await resetVerifyRateLimit();
    const email = "name-persist@example.com";
    const guestSession = await startSession();

    await seedOtp(email, "555555");
    const verify = await verifyOtp(email, "555555", guestSession);
    expect(verify.success).toBe(true);
    const sid = verify.data.sessionId as string;

    const saveRes = await saveName(sid, "Kasim", verify.data.token);
    expect(saveRes.success).toBe(true);
    expect(saveRes.data.persisted).toBe(true);

    // "Sign out" in the UI just drops the local token — the account's
    // name in user_preferences is untouched either way. Confirm directly.
    const row: any = await env.DB.prepare("SELECT name FROM user_preferences WHERE user_id = ?")
      .bind(email)
      .first();
    expect(row.name).toBe("Kasim");

    // Signing in again (fresh guest session, since sign-out clears it
    // client-side) resumes the SAME session and the name is still there.
    await resetVerifyRateLimit();
    const freshGuestSession = await startSession();
    await seedOtp(email, "666666");
    const reVerify = await verifyOtp(email, "666666", freshGuestSession);
    expect(reVerify.data.sessionId).toBe(sid);

    const nameCheck = await getName(sid, reVerify.data.token);
    expect(nameCheck.data.name).toBe("Kasim");
  });
});
