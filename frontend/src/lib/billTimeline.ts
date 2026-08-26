/**
 * Translates raw api_call_log audit events into shopper-friendly "Bill
 * Timeline" entries. Judges get the raw log (AuditTrail); shoppers get this.
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
      if (e.method === "GET") return null; // background poll, not a shopper action
      break;

    case "/api/session/start":
      return { id: e.id, ts: e.ts, tone: "info", text: "Counter opened" };

    case "/api/session/end":
      return { id: e.id, ts: e.ts, tone: "info", text: "Counter closed" };

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

    case "/webhooks/razorpay": {
      if (data.status === "paid") {
        return { id: e.id, ts: e.ts, tone: "success", text: `Payment received — ${rupees(data.amount)}` };
      }
      return null; // ignored/ non-payment webhook events aren't shopper-relevant
    }

    default:
      break;
  }

  // Fallback — never silently drop an event the mapping doesn't know about;
  // show it plainly rather than pretending nothing happened.
  return {
    id: e.id,
    ts: e.ts,
    tone: failed ? "error" : "info",
    text: `${e.method} ${e.endpoint}${failed ? ` — ${errorText}` : ""}`,
  };
}

export function toTimeline(events: AuditEvent[]): TimelineEntry[] {
  return events
    .map(toTimelineEntry)
    .filter((e): e is TimelineEntry => e !== null);
}
