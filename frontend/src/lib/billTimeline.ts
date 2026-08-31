/**
 * Translates raw api_call_log audit events into shopper-friendly activity
 * lines. This is the ONLY reading of the audit feed that reaches the screen —
 * ActivityLog's old "Raw log" toggle (method, endpoint, timings, full
 * params/response JSON) was removed because it put internal API shapes in
 * front of anyone looking at the page.
 *
 * That makes this file the boundary: an endpoint with no case below prints
 * nothing rather than falling back to its own route name (see the fallback
 * at the bottom). Adding an endpoint means writing a sentence for it.
 *
 * Kept deliberately dumb — no state, pure function of one event — so it's
 * easy to verify against real audit rows and easy to extend per endpoint.
 */

export interface AuditEvent {
  id: string;
  ts: number;
  endpoint: string;
  method: string;
  params?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
  status: string; // ok | error | blocked
  duration_ms?: number;
}

export type TimelineTone = "info" | "success" | "warn" | "error";

export interface TimelineEntry {
  id: string;
  ts: number;
  tone: TimelineTone;
  text: string;
}

const rupees = (paise: unknown): string =>
  typeof paise === "number" ? `₹${(paise / 100).toLocaleString("en-IN")}` : "";

function dataOf(e: AuditEvent): Record<string, any> {
  const r: any = e.response ?? {};
  return r.data ?? r;
}

/**
 * Converts one audit event into a timeline entry, or null to omit it from
 * the friendly view (e.g. 3-second cart-refresh polling, which would flood
 * the timeline with a "checked cart" line every few seconds).
 */
export function toTimelineEntry(e: AuditEvent): TimelineEntry | null {
  const params = e.params ?? {};
  const data = dataOf(e);
  const failed = e.status !== "ok";
  const errorText = typeof (e.response as any)?.error === "string" ? (e.response as any).error : "Something went wrong";

  switch (e.endpoint) {
    case "/api/cart":
      // Reading the cart is never a shopper action, whichever caller does it:
      // the browser polls this every 3s and Sarvam's tools call it as POST
      // (their tools are all-POST), so both would otherwise flood the log and
      // bury the events that actually moved money. Cart *changes* are logged
      // under /api/cart/add and /api/cart/remove instead.
      return null;

    case "/api/audit":
      // The audit endpoint logs its OWN calls (see withApiLogging in
      // api/audit.ts), and the browser polls it every 3s right alongside
      // /api/cart — every single poll would otherwise show up as its own
      // "GET /api/audit" line, burying everything that actually happened
      // under a flood of the log reading itself.
      return null;

    case "/api/session/start":
      return { id: e.id, ts: e.ts, tone: "info", text: "Counter opened" };

    case "/api/session/end":
      return { id: e.id, ts: e.ts, tone: "info", text: "Counter closed" };

    case "/api/session/budget": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Cap not set — ${errorText}` };
      }
      return { id: e.id, ts: e.ts, tone: "info", text: `Spending cap set to ${rupees(data.budget)}` };
    }

    case "/api/catalog": {
      const count = Array.isArray(data.products) ? data.products.length : 0;
      const query = typeof params.query === "string" ? params.query.trim() : "";
      const text = query
        ? `Searched “${query}” — ${count} found`
        : `Browsed the shelf — ${count} item${count === 1 ? "" : "s"}`;
      return { id: e.id, ts: e.ts, tone: "info", text };
    }

    case "/api/cart/add": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Couldn't add item — ${errorText}` };
      }
      const productId = params.product_id as string | undefined;
      const qty = (params.quantity as number | undefined) ?? 1;
      const item = Array.isArray(data.items) ? data.items.find((i: any) => i.productId === productId) : null;
      const name = item?.name ?? productId ?? "item";
      const price = item ? rupees(item.price * item.quantity) : "";
      const budgetNote =
        typeof data.budgetRemaining === "number" ? ` · budget left ${rupees(data.budgetRemaining)}` : "";
      return {
        id: e.id,
        ts: e.ts,
        tone: "success",
        text: `Added ${qty}× ${name}${price ? ` — ${price}` : ""}${budgetNote}`,
      };
    }

    case "/api/cart/remove": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Couldn't remove item — ${errorText}` };
      }
      const productId = params.product_id as string | undefined;
      const removedQty = params.quantity as number | undefined;
      // Logged explicitly since a fully-removed item no longer appears in
      // data.items by the time this call is recorded.
      const name = (params.product_name as string | undefined) ?? productId ?? "item";
      const text = removedQty ? `Removed ${removedQty}× ${name}` : `Removed ${name}`;
      return { id: e.id, ts: e.ts, tone: "info", text };
    }

    case "/api/checkout": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Checkout blocked — ${errorText}` };
      }
      const amount = rupees(data.amount);
      if (params.idempotent) {
        return { id: e.id, ts: e.ts, tone: "info", text: `Checkout already in progress — ${amount} due` };
      }
      return { id: e.id, ts: e.ts, tone: "success", text: `Checkout started — ${amount} due` };
    }

    case "/api/order": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: "Order not found" };
      }
      const status = typeof data.status === "string" ? data.status : "unknown";
      return { id: e.id, ts: e.ts, tone: status === "paid" ? "success" : "info", text: `Order status — ${status}` };
    }

    case "/api/auth/otp": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Sign-in code couldn't be sent — ${errorText}` };
      }
      return { id: e.id, ts: e.ts, tone: "info", text: "Sign-in code sent" };
    }

    case "/api/auth/otp/verify": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Sign-in failed — ${errorText}` };
      }
      return { id: e.id, ts: e.ts, tone: "success", text: "Signed in" };
    }

    case "/api/cart/propose-add": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Couldn't propose add — ${errorText}` };
      }
      // Success shape is data.preview.{name,quantity} — see proposeAddToCart
      // in src/api/logic.ts. Confirming the proposal logs separately under
      // /api/cart/add (confirmCartAction delegates to addToCart on success),
      // so this line only ever represents the proposal itself, never the
      // mutation.
      const preview = (data.preview ?? {}) as Record<string, any>;
      const name = preview.name ?? "an item";
      const qty = preview.quantity ?? 1;
      return { id: e.id, ts: e.ts, tone: "info", text: `Proposed adding ${qty}× ${name} — awaiting confirmation` };
    }

    case "/api/cart/propose-remove": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Couldn't propose remove — ${errorText}` };
      }
      const preview = (data.preview ?? {}) as Record<string, any>;
      const name = preview.name ?? "an item";
      return { id: e.id, ts: e.ts, tone: "info", text: `Proposed removing ${name} — awaiting confirmation` };
    }

    case "/api/cart/confirm":
      // A SUCCESSFUL confirm never logs under this endpoint at all —
      // confirmCartAction delegates to addToCart/removeFromCart on
      // success, which log themselves under /api/cart/add or
      // /api/cart/remove instead (see confirmCartAction in
      // src/api/logic.ts). Every row that DOES land here is therefore
      // already a failure (invalid/expired/already-consumed token, or a
      // lost race against a concurrent confirm of the same token).
      return { id: e.id, ts: e.ts, tone: "warn", text: `Confirmation failed — ${errorText}` };

    case "/api/user/name": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Didn't catch the name — ${errorText}` };
      }
      const name = typeof data.name === "string" ? data.name : (params.name as string | undefined);
      if (data.persisted === false) {
        return { id: e.id, ts: e.ts, tone: "info", text: `Said hello to ${name ?? "the shopper"} (not saved — sign in to remember)` };
      }
      return { id: e.id, ts: e.ts, tone: "success", text: `Saved name — ${name ?? "shopper"}` };
    }

    case "/webhooks/razorpay": {
      if (data.status === "paid") {
        return { id: e.id, ts: e.ts, tone: "success", text: `Payment received — ${rupees(data.amount)}` };
      }
      return null; // ignored/ non-payment webhook events aren't shopper-relevant
    }

    case "/api/viewed-products":
      // Bookkeeping, not an action: this fires when a detail window has been
      // open long enough to count as "seen" (see logViewedProduct), purely so
      // the agent can refer back to it later. The shopper already knows they
      // looked at it — the window was on their screen.
      return null;

    case "/api/voice/transcript":
      // Internal: reads back the stored conversation. Never a shopper action.
      return null;

    case "/api/product-details": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Couldn't open those details — ${errorText}` };
      }
      const names = Array.isArray(data.products)
        ? data.products.map((p: any) => p?.name).filter((n: unknown): n is string => typeof n === "string")
        : [];
      if (names.length === 0) return null;
      return {
        id: e.id,
        ts: e.ts,
        tone: "info",
        text: `Opened details — ${names.join(", ")}`,
      };
    }

    case "/api/describe-products": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Couldn't look at those photos — ${errorText}` };
      }
      const count = Array.isArray(params.product_ids) ? params.product_ids.length : 0;
      return {
        id: e.id,
        ts: e.ts,
        tone: "info",
        text: count > 1 ? `Looked at the photos of ${count} items` : "Looked at the photo",
      };
    }

    case "/api/account/profile": {
      if (failed) {
        return { id: e.id, ts: e.ts, tone: "warn", text: `Couldn't read your account — ${errorText}` };
      }
      return { id: e.id, ts: e.ts, tone: "info", text: "Checked your account" };
    }

    default:
      break;
  }

  // Fallback for an endpoint this mapping doesn't know about yet.
  //
  // Deliberately says nothing about WHICH endpoint. This used to render
  // `${e.method} ${e.endpoint}`, which meant every unmapped call showed up
  // on screen as raw internal API text ("POST /api/viewed-products") in the
  // plain, shopper-facing view — visible to anyone looking at the page, in a
  // screen share, or in a recording. A successful call nobody has written a
  // sentence for isn't worth a line at all; a failure is worth admitting,
  // but the shopper-readable error is the useful part, not the route.
  if (!failed) return null;
  return { id: e.id, ts: e.ts, tone: "error", text: errorText };
}

export function toTimeline(events: AuditEvent[]): TimelineEntry[] {
  return events
    .map(toTimelineEntry)
    .filter((e): e is TimelineEntry => e !== null);
}
