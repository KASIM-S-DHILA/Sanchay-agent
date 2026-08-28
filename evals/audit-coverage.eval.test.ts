import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

/**
 * Covers audit-trail gaps found while auditing the Bill Timeline mapping
 * (frontend/src/lib/billTimeline.ts): sign-in/sign-in-code-send previously
 * wrote NOTHING to api_call_log, making them invisible to /api/audit —
 * indistinguishable from never having been attempted. These tests assert
 * the log rows exist and never leak the OTP code or JWT.
 */

let env: any;
const START = "https://test/api/session/start";
const KNOWN_CODE = "654321";

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

async function getAuditRows(sessionId: string, endpoint: string) {
  const res = (
    await env.DB.prepare(
      "SELECT params_json, response_json, status FROM api_call_log WHERE session_id = ? AND endpoint = ? ORDER BY created_at ASC",
    )
      .bind(sessionId, endpoint)
      .all()
  ).results ?? [];
  return res;
}

async function resetVerifyRateLimit(): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = 'otp_verify:ip:unknown'").run();
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Audit coverage: sign-in is no longer invisible", () => {
  it("an OTP send attempt is logged exactly once, without leaking the email/code, whatever the outcome", async () => {
    const sessionId = await startSession();
    // RESEND_API_KEY is a real secret in this test environment (loaded
    // from .dev.vars), so this hits Resend's actual API rather than the
    // dev-log fallback — deliberately NOT asserting the send itself
    // succeeds (that depends on live network access and Resend's
    // validation rules, neither of which this test is about). What must
    // hold regardless: exactly one log row, and it never contains the
    // email or a code.
    const email = "audit-otp-send@example.com";
    await SELF.fetch("https://test/api/auth/otp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ email }),
    });

    const rows: any[] = await getAuditRows(sessionId, "/api/auth/otp");
    expect(rows).toHaveLength(1);
    // No params logged at all for this endpoint (params: null in the
    // handler) — email/code must never land in the audit trail.
    expect(rows[0].params_json).toBeNull();
    expect(JSON.stringify(rows[0].response_json)).not.toContain(email);
  });

  it("a rejected OTP send (invalid email) is still logged, as an error", async () => {
    const sessionId = await startSession();
    await SELF.fetch("https://test/api/auth/otp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ email: "not-an-email" }),
    });

    const rows: any[] = await getAuditRows(sessionId, "/api/auth/otp");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
  });

  it("a successful verify is logged as ok, without leaking the token", async () => {
    await resetVerifyRateLimit();
    const sessionId = await startSession();
    const email = "audit-verify-ok@example.com";
    await seedOtp(email);

    await SELF.fetch("https://test/api/auth/otp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ email, code: KNOWN_CODE, sessionId }),
    });

    const rows: any[] = await getAuditRows(sessionId, "/api/auth/otp/verify");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
    expect(rows[0].response_json).not.toContain("eyJ"); // no JWT (base64url JWTs start with this)
  });

  it("a wrong code is logged as blocked, not silently dropped", async () => {
    await resetVerifyRateLimit();
    const sessionId = await startSession();
    const email = "audit-verify-wrong@example.com";
    await seedOtp(email);

    await SELF.fetch("https://test/api/auth/otp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ email, code: "000000", sessionId }),
    });

    const rows: any[] = await getAuditRows(sessionId, "/api/auth/otp/verify");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("blocked");
  });
});

describe("Audit coverage: gated cart proposals are distinguishable from mutations", () => {
  it("propose-add logs separately from the eventual confirm-triggered add", async () => {
    const sessionId = await startSession();
    const proposeRes = await SELF.fetch("https://test/api/cart/propose-add", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ product_id: "TEE-BLACK-001", quantity: 1 }),
    });
    const proposeData: any = await proposeRes.json();
    expect(proposeData.success).toBe(true);
    const token = proposeData.data.action_token;

    // Exactly one propose-add row, no cart/add row yet — nothing has
    // mutated the cart at this point.
    const proposeRows = await getAuditRows(sessionId, "/api/cart/propose-add");
    expect(proposeRows).toHaveLength(1);
    const addRowsBefore = await getAuditRows(sessionId, "/api/cart/add");
    expect(addRowsBefore).toHaveLength(0);

    await SELF.fetch("https://test/api/cart/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ action_token: token }),
    });

    // Confirming a valid proposal delegates to addToCart, which logs under
    // /api/cart/add, not /api/cart/confirm — confirming this matches
    // confirmCartAction's actual behavior, not an assumption about it.
    const addRowsAfter = await getAuditRows(sessionId, "/api/cart/add");
    expect(addRowsAfter).toHaveLength(1);
    const confirmRows = await getAuditRows(sessionId, "/api/cart/confirm");
    expect(confirmRows).toHaveLength(0); // success never logs under /api/cart/confirm
  });

  it("confirming an invalid token logs under /api/cart/confirm as a failure", async () => {
    const sessionId = await startSession();
    await SELF.fetch("https://test/api/cart/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ action_token: "not-a-real-token" }),
    });

    const rows = await getAuditRows(sessionId, "/api/cart/confirm");
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).status).not.toBe("ok");
  });
});
