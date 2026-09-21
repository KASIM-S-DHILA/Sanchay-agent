import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";

/**
 * One instance per session (see getByName(sessionId) at the call sites in
 * index.ts and every "notify" call below) — holds this session's live
 * WebSocket connection(s) and tells them "something changed" the instant a
 * mutation actually happens, instead of the browser finding out up to 3
 * seconds later via polling.
 *
 * Deliberately dumb: this object has NO idea what a cart or an audit row
 * is, never touches D1, and never shapes a response. Its entire job is
 * "hold a connection, relay a signal" — every existing REST handler
 * (handleCartGet, handleAudit) stays the untouched source of truth for
 * what the data actually is. The browser still does a normal fetch() the
 * moment it's told something changed; this object only removes the need
 * to ask "did anything change?" every 3 seconds when the honest answer is
 * almost always "no."
 *
 * Uses WebSocket Hibernation (acceptWebSocket, not accept) specifically so
 * a connection sitting open between voice actions — most of a call, in
 * practice — doesn't keep this object pinned in memory (and billed for
 * wall-clock duration) while nothing is happening. That's the same
 * cost-safety property the call-gated polling this replaces already had:
 * idle time should cost nothing.
 */
export class SessionHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /**
   * WebSocket upgrade entry point — called via stub.fetch(request) from
   * the Worker's /api/live/:sessionId route (see index.ts). Ownership of
   * WHETHER a caller is allowed to open this session's connection at all
   * is the Worker's job (validateSession runs there, before this is ever
   * reached) — this object trusts that it's only reached for a session
   * that's already been proven valid.
   */
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernatable — see class doc comment for why this matters over a
    // plain server.accept().
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Called via RPC from every mutation handler that changes this session's
   * cart/audit state (see handleCartAdd/handleCartRemove in api/cart.ts,
   * handleCheckout in api/checkout.ts, handlePaymentCaptured in
   * api/webhook.ts). One generic signal rather than separate "cart changed"
   * / "audit changed" messages — every mutation that matters here touches
   * BOTH (an add/remove/checkout/webhook always writes an audit row too),
   * so there's no real case where a listener would want one but not the
   * other; keeping one message type keeps both this object and the
   * frontend listener simpler with no lost precision.
   *
   * Fire-and-forget from the caller's point of view: notify() never
   * throws, and a caller with zero open connections (the common case —
   * most sessions have no listener at all, e.g. no voice call live) is
   * exactly as cheap as calling it with an open connection, since
   * getWebSockets() on an object with none is just an empty array.
   */
  async notify(): Promise<{ delivered: number }> {
    const message = JSON.stringify({ type: "changed" });
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
        delivered++;
      } catch {
        // A dead/closing socket failing to send is not this method's
        // problem to solve — webSocketClose below is what actually cleans
        // up bookkeeping, if this object ever needs any beyond the
        // runtime's own getWebSockets() list.
      }
    }
    return { delivered };
  }

  /**
   * No per-connection state to restore on wake (see the class doc comment
   * — this object never tracks anything beyond "which sockets are open
   * right now", which getWebSockets() already answers) — required by the
   * hibernation API regardless, since the runtime delivers messages here
   * rather than to an addEventListener that would've been lost on
   * hibernation. The frontend never actually sends anything meaningful;
   * this only exists so an unexpected client message doesn't throw.
   */
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // No-op — this channel is server-to-browser only, by design (see the
    // class doc comment: cart/audit mutations always go through normal
    // POST requests, never through this socket).
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing/closed — nothing left to do.
    }
  }
}
