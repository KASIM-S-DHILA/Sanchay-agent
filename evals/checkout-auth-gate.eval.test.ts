import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";
import { signIn } from "./helpers/auth";

/**
 * Covers the "must be signed in to check out" gate added to handleCheckout
 * (src/api/checkout.ts) — the deliberate design point being that a valid
 * bearer token is required, NOT merely sessions.user_id being non-null.
 * user_id can also be set by the older, unauthenticated
 * startSession({user_email}) path (see startSession in src/api/logic.ts),
 * which exists purely so a guest can optionally tag a session for
 * order-history lookups without any OTP verification at all — gating
 * checkout on that alone would let anyone bypass sign-in just by passing
 * an arbitrary email string at session start.
 */

let env: any;
const START = "https://test/api/session/start";

async function startSession(body: Record<string, unknown> = {}): Promise<string> {
  const res = await SELF.fetch(START, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  return json.data.sessionId;
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

async function getCart(sessionId: string, token?: string) {
  const res = await SELF.fetch("https://test/api/cart", {
    headers: { "x-session-id": sessionId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return res.json() as Promise<any>;
}

async function checkout(sessionId: string, token?: string) {
  const res = await SELF.fetch("https://test/api/checkout", {
    method: "POST",
    headers: { "x-session-id": sessionId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, data: (await res.json()) as any };
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Checkout auth gate: guest browsing is fine, guest checkout is not", () => {
  it("a guest with items in the cart can browse and read the cart normally", async () => {
    const sessionId = await startSession();
    const addRes = await addProduct(sessionId, "red-sports-tee");
    expect(addRes.success).toBe(true);

    const cart = await getCart(sessionId);
    expect(cart.success).toBe(true);
    expect(cart.data.items.length).toBe(1);
  });

  it("a guest cart reports isSignedIn: false", async () => {
    const sessionId = await startSession();
    const cart = await getCart(sessionId);
    expect(cart.data.isSignedIn).toBe(false);
  });

  it("a guest checkout attempt is rejected with 403, cart untouched", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "red-sports-tee");

    const { status, data } = await checkout(sessionId);
    expect(status).toBe(403);
    expect(data.success).toBe(false);
    expect(data.error.toLowerCase()).toContain("sign in");

    // The cart survives the rejection — nothing was lost.
    const cart = await getCart(sessionId);
    expect(cart.data.items.length).toBe(1);
  });

  it("starting a session with a bare user_email (no OTP) does NOT unlock checkout", async () => {
    // This is the exact bypass the gate must close: startSession({user_email})
    // sets sessions.user_id directly with zero authentication.
    const sessionId = await startSession({ user_email: "no-otp-bypass@example.com" });
    await addProduct(sessionId, "red-sports-tee");

    const row: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?").bind(sessionId).first();
    expect(row.user_id).toBe("no-otp-bypass@example.com"); // user_id IS set...

    const { status, data } = await checkout(sessionId); // ...but checkout must still reject
    expect(status).toBe(403);
    expect(data.success).toBe(false);
  });

  it("the guest-checkout rejection is a real, session-attributed audit row, not silently dropped", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "red-sports-tee");
    await checkout(sessionId);

    const rows: any[] = (
      await env.DB.prepare(
        "SELECT status, session_id FROM api_call_log WHERE session_id = ? AND endpoint = '/api/checkout' ORDER BY created_at DESC LIMIT 1",
      )
        .bind(sessionId)
        .all()
    ).results ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("blocked");
    expect(rows[0].session_id).toBe(sessionId); // NOT null — this session really did make this call
  });
});

describe("Checkout auth gate: a real sign-in unlocks checkout", () => {
  it("after OTP sign-in, isSignedIn flips to true and checkout is no longer rejected for lack of auth", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "red-sports-tee");
    const token = await signIn(env, sessionId, "gate-unlock@example.com");

    const cart = await getCart(sessionId, token);
    expect(cart.data.isSignedIn).toBe(true);
    // Cart survived the sign-in migration.
    expect(cart.data.items.length).toBe(1);

    const { status, data } = await checkout(sessionId, token);
    expect(status).not.toBe(403);
    expect(data.success).toBe(true);
  });

  it("a bearer token for a DIFFERENT account than the session's owner is rejected (session hijack guard)", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "red-sports-tee");
    await signIn(env, sessionId, "gate-owner@example.com"); // migrates sessionId to gate-owner

    // A second, unrelated session/account mints its own valid token...
    const otherSessionId = await startSession();
    const otherToken = await signIn(env, otherSessionId, "gate-attacker@example.com");

    // ...but presenting it against the FIRST session (which belongs to a
    // different account) must be rejected, not silently accepted.
    const { status, data } = await checkout(sessionId, otherToken);
    expect(status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("checkout without any Authorization header still works as pure guest-rejection, unaffected by unrelated sessions signing in", async () => {
    const signedInSession = await startSession();
    await signIn(env, signedInSession, "gate-unrelated@example.com");

    const guestSession = await startSession();
    await addProduct(guestSession, "red-sports-tee");
    const { status } = await checkout(guestSession); // no token at all
    expect(status).toBe(403);
  });
});
