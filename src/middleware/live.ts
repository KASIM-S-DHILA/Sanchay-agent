import type { Env } from "../types";

/**
 * Tells this session's SessionHub Durable Object (see
 * src/durable/SessionHub.ts) that something changed, so a browser holding
 * a live connection (see /api/live in index.ts) re-fetches immediately
 * instead of waiting for its next poll.
 *
 * Deliberately best-effort and silent on failure — a shopper's actual
 * mutation (the cart write, the checkout, the payment) has already
 * succeeded by the time this is called; a hiccup notifying the DO must
 * never turn a successful cart-add into an error response. Worst case if
 * this fails: the frontend simply doesn't get the instant push and falls
 * back to its own timer-based poll (see useSessionLive.ts's fallback),
 * which is exactly today's existing behavior, not a broken one.
 */
export async function notifySessionChanged(env: Env, sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return;
  try {
    const stub = env.SESSION_HUB.getByName(sessionId);
    const result = await stub.notify();
    console.log(`notifySessionChanged: session=${sessionId} delivered=${result.delivered}`);
  } catch (e) {
    console.error("notifySessionChanged failed:", e);
  }
}
