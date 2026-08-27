import { useState, useCallback, useEffect, useRef } from "react";
import { ActivityLog } from "./components/ActivityLog";
import { Bill, type BillItem, type PaymentState } from "./components/Bill";
import { CrossSell, type CrossSellSuggestion } from "./components/CrossSell";
import { Shelf, type ShelfSource } from "./components/Shelf";
import type { CatalogProduct } from "./components/ProductCard";
import { VoiceDock } from "./components/VoiceDock";
import { useAuditFeed } from "./hooks/useAuditFeed";
import { useGeminiLive } from "./hooks/useGeminiLive";
import { RAZORPAY_KEY_ID, rupees } from "./config";

interface CartData {
  items: BillItem[];
  total: number;
  count: number;
  budgetRemaining?: number | null;
  youMightAlsoLike?: CrossSellSuggestion[];
}

interface Note {
  id: number;
  tone: "ok" | "warn" | "error";
  text: string;
}

declare global {
  interface Window {
    Razorpay: any;
  }
}

/** The catalog returns `id` when listing and `productId` when searching. */
function normalizeProducts(raw: any[]): CatalogProduct[] {
  return raw.map((p) => ({
    id: p.id ?? p.productId,
    name: p.name,
    price: p.price,
    price_display: p.price_display,
    category: p.category,
    stock: typeof p.stock === "number" ? p.stock : 1,
    image_url: p.image_url ?? null,
    description: p.description,
  }));
}

export default function App() {
  const [email, setEmail] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartData | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [view, setView] = useState<"shop" | "bill">("shop");

  const [shelfQuery, setShelfQuery] = useState("");
  const [shelfSource, setShelfSource] = useState<ShelfSource>("default");
  const [shelfProducts, setShelfProducts] = useState<CatalogProduct[]>([]);
  const [shelfLoading, setShelfLoading] = useState(true);
  const [shelfError, setShelfError] = useState<string | null>(null);

  const [addingProductId, setAddingProductId] = useState<string | null>(null);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentState | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const noteSeq = useRef(0);
  const handledEventsRef = useRef<Set<string>>(new Set());
  // Queries this browser issued, so a catalog lookup we caused isn't mistaken
  // for one the agent caused when it comes back around on the audit feed.
  const ownQueriesRef = useRef<Map<string, number>>(new Map());
  const justAddedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const note = useCallback((text: string, tone: Note["tone"] = "warn") => {
    const id = ++noteSeq.current;
    setNotes((prev) => [...prev.slice(-2), { id, tone, text }]);
    setTimeout(() => setNotes((prev) => prev.filter((n) => n.id !== id)), 9000);
  }, []);

  const dismissNote = (id: number) => setNotes((prev) => prev.filter((n) => n.id !== id));

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const sid = sessionIdRef.current;
    const res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(sid ? { "x-session-id": sid } : {}),
        ...(init?.headers ?? {}),
      },
    });
    return res.json() as Promise<any>;
  }, []);

  // — Session ————————————————————————————————————————————————————————
  // One entry point. Anything that needs a counter opens one rather than
  // telling the shopper to go and press a different button first.
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const data = await api("/api/session/start", {
      method: "POST",
      body: JSON.stringify({ user_email: email.trim() || null }),
    });
    if (data?.success) {
      sessionIdRef.current = data.data.sessionId;
      setSessionId(data.data.sessionId);
      return data.data.sessionId;
    }
    note(data?.error ?? "Couldn't open a counter. Reload and try again.", "error");
    return null;
  }, [api, email, note]);

  // — Shelf ——————————————————————————————————————————————————————————
  const searchShelf = useCallback(
    async (query: string) => {
      setShelfLoading(true);
      setShelfError(null);
      ownQueriesRef.current.set(query, Date.now());
      try {
        const data = await api(`/api/catalog?q=${encodeURIComponent(query)}`);
        if (data?.success) {
          setShelfProducts(normalizeProducts(data.data?.products ?? []));
          setShelfQuery(query);
          setShelfSource(query ? "you" : "default");
        } else {
          setShelfError(data?.error ?? "The shelf didn't load");
        }
      } catch {
        setShelfError("The shelf didn't load");
      } finally {
        setShelfLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void searchShelf("");
    // Initial load only — later loads are user- or agent-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // — Cart ———————————————————————————————————————————————————————————
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const load = async () => {
      const data = await api("/api/cart");
      if (!cancelled && data?.success) setCart(data.data);
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, api]);

  const refreshCart = useCallback(async () => {
    const data = await api("/api/cart");
    if (data?.success) setCart(data.data);
  }, [api]);

  // — Payment ————————————————————————————————————————————————————————
  /** Razorpay's handler fires the moment the shopper finishes, but the order
   *  isn't `paid` until our webhook lands. Poll briefly rather than either
   *  claiming success early or leaving the bill in limbo. */
  const confirmPayment = useCallback(
    async (orderId: string) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const data = await api(`/api/order/${orderId}`);
        if (data?.success && data.data?.status === "paid") {
          setPayment({ orderId, amount: data.data.amount ?? 0, stage: "paid" });
          void refreshCart();
          note("Payment confirmed. The bill is settled.", "ok");
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      note(
        "Payment went through but confirmation is still coming back. The bill updates itself the moment it lands.",
        "warn",
      );
    },
    [api, note, refreshCart],
  );

  const openRazorpay = useCallback(
    (orderId: string, amountPaise: number) => {
      if (!window.Razorpay) {
        note("The payment window couldn't load. Check your connection and try again.", "error");
        return;
      }
      setPayment({ orderId, amount: amountPaise, stage: "pending" });
      const rzp = new window.Razorpay({
        key: RAZORPAY_KEY_ID,
        order_id: orderId,
        amount: amountPaise,
        currency: "INR",
        name: "Sanchay",
        description: "Voice counter bill",
        handler: () => {
          void confirmPayment(orderId);
        },
        modal: {
          // Closing the window is a normal thing to do, not an error. Say what
          // it means and leave a way back in.
          ondismiss: () => {
            setPayment((prev) =>
              prev && prev.orderId === orderId && prev.stage !== "paid"
                ? { ...prev, stage: "dismissed" }
                : prev,
            );
            note("Payment window closed. Nothing was charged — your bill is exactly as it was.", "warn");
          },
        },
      });
      rzp.open();
    },
    [confirmPayment, note],
  );

  const resumePayment = useCallback(() => {
    if (payment && payment.stage !== "paid") openRazorpay(payment.orderId, payment.amount);
  }, [payment, openRazorpay]);

  const handlePay = useCallback(async () => {
    const sid = await ensureSession();
    if (!sid) return;
    setCheckoutBusy(true);
    try {
      const data = await api("/api/checkout", { method: "POST" });
      if (data?.success && data.data?.orderId) {
        openRazorpay(data.data.orderId, data.data.amount);
      } else {
        // Every gate the Worker enforces — cap, stock, merchant ceiling —
        // arrives here as a sentence. Show it verbatim.
        note(data?.error ?? "Checkout didn't go through.", "warn");
        void refreshCart();
      }
    } finally {
      setCheckoutBusy(false);
    }
  }, [api, ensureSession, note, openRazorpay, refreshCart]);

  // — Voice — Gemini Live (ephemeral token + 16k→24k PCM + tool calling)
  const voice = useGeminiLive(sessionId, openRazorpay as any);

  // Gemini hook mints its own Sanchay session if needed — adopt it so cart/audit stay in sync
  useEffect(() => {
    const sid: string | null = (voice as any).sessionId ?? (voice as any).sanchaySessionId ?? null;
    if (sid && sid !== sessionId) {
      sessionIdRef.current = sid;
      setSessionId(sid);
    }
  }, [(voice as any).sessionId, (voice as any).sanchaySessionId, sessionId]);

  const startTalking = useCallback(async () => {
    const sid = await ensureSession();
    if (!sid) return;
    // Gemini hook ignores args but we keep signature for compat
    void (voice.startCall as any)(sid, email.trim() || undefined);
  }, [ensureSession, email, voice]);

  // — Adding ——————————————————————————————————————————————————————————
  const handleAddToCart = useCallback(
    async (productId: string) => {
      const sid = await ensureSession();
      if (!sid) return;
      setAddingProductId(productId);
      try {
        const data = await api("/api/cart/add", {
          method: "POST",
          body: JSON.stringify({ product_id: productId, quantity: 1 }),
        });
        if (data?.success) {
          setCart(data.data);
          setJustAddedId(productId);
          if (justAddedTimerRef.current) clearTimeout(justAddedTimerRef.current);
          justAddedTimerRef.current = setTimeout(() => setJustAddedId(null), 2600);
        } else {
          note(data?.error ?? "Couldn't add that to the bill.", "warn");
        }
      } finally {
        setAddingProductId(null);
      }
    },
    [api, ensureSession, note],
  );

  const handleSetBudget = useCallback(
    async (rupeeValue: number): Promise<boolean> => {
      const sid = await ensureSession();
      if (!sid) return false;
      const data = await api("/api/session/budget", {
        method: "POST",
        body: JSON.stringify({ budget: rupeeValue }),
      });
      if (data?.success) {
        note(`Cap set at ${rupees(data.data.budget)}. Nothing can push the bill past it.`, "ok");
        void refreshCart();
        return true;
      }
      note(data?.error ?? "Couldn't set that cap.", "warn");
      return false;
    },
    [api, ensureSession, note, refreshCart],
  );

  // — Audit feed: one poller, several consumers ————————————————————————
  const { events } = useAuditFeed(sessionId);

  useEffect(() => {
    for (const e of events) {
      if (handledEventsRef.current.has(e.id)) continue;
      handledEventsRef.current.add(e.id);

      const body: any = e.response ?? {};
      const data = body.data ?? body;

      // Checkout the agent started on our behalf — open the payment window.
      if (e.endpoint === "/api/checkout" && e.status === "ok" && data?.orderId && data?.amount) {
        setPayment((prev) => {
          if (prev && prev.orderId === data.orderId) return prev; // already handling this one
          openRazorpay(data.orderId, data.amount);
          return { orderId: data.orderId, amount: data.amount, stage: "pending" };
        });
        continue;
      }

      // A catalog lookup the AGENT ran — mirror it onto the shelf so the
      // screen answers the same question the shopper just asked out loud.
      if (e.endpoint === "/api/catalog" && e.status === "ok" && Array.isArray(data?.products)) {
        const query: string = typeof data.query === "string" ? data.query : "";
        const ourAt = ownQueriesRef.current.get(query);
        if (ourAt && Date.now() - ourAt < 10000) continue; // this one was ours
        setShelfProducts(normalizeProducts(data.products));
        setShelfQuery(query);
        setShelfSource("agent");
        setShelfLoading(false);
        setShelfError(null);
      }
    }
  }, [events, openRazorpay]);

  const items = cart?.items ?? [];
  const total = cart?.total ?? 0;
  const count = cart?.count ?? 0;
  const budgetRemaining = cart?.budgetRemaining ?? null;
  const cap = budgetRemaining === null ? null : total + budgetRemaining;

  return (
    <div className="counter">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="mark">
            <h1 className="mark-name">Sanchay</h1>
            <span className="mark-role">the counter that listens</span>
          </div>
          <div className="topbar-facts">
            <div className="fact">
              <span className="fact-label">Counter</span>
              <span className="fact-value">
                {sessionId ? sessionId.slice(0, 6).toUpperCase() : "not open"}
              </span>
            </div>
            <div className="fact">
              <span className="fact-label">On the bill</span>
              <span className="fact-value">
                {count} {count === 1 ? "piece" : "pieces"} · {rupees(total)}
              </span>
            </div>
            <div className="fact">
              <span className="fact-label">Cap</span>
              <span className={`fact-value ${cap !== null && budgetRemaining === 0 ? "is-over" : ""}`}>
                {cap === null ? "none set" : `${rupees(budgetRemaining ?? 0)} left`}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="workspace" data-view={view}>
        <div className="work">
          <VoiceDock
            callState={voice.callState}
            transcripts={voice.transcripts}
            error={voice.error}
            micLevel={voice.micLevel}
            agentLevel={voice.agentLevel}
            onStart={() => void startTalking()}
            onStop={voice.stopCall}
            onDismissError={voice.dismissError}
            onTry={(q) => void searchShelf(q)}
          />

          {/* Narrow screens only (see styles.css). Plain toggle buttons rather
              than a role="tab" set — a half-wired tab pattern reads worse to a
              screen reader than an honest pair of buttons. */}
          <div className="tabs">
            <button
              type="button"
              className={`tab ${view === "shop" ? "is-on" : ""}`}
              aria-pressed={view === "shop"}
              onClick={() => setView("shop")}
            >
              Shelf
            </button>
            <button
              type="button"
              className={`tab ${view === "bill" ? "is-on" : ""}`}
              aria-pressed={view === "bill"}
              onClick={() => setView("bill")}
            >
              Bill {count > 0 && `· ${rupees(total)}`}
            </button>
          </div>

          <div className="work-panels">
            <Shelf
              query={shelfQuery}
              source={shelfSource}
              products={shelfProducts}
              loading={shelfLoading}
              error={shelfError}
              onSearch={(q) => void searchShelf(q)}
              onAdd={(id) => void handleAddToCart(id)}
              addingId={addingProductId}
              justAddedId={justAddedId}
            />
            {items.length > 0 && (
              <CrossSell
                suggestions={cart?.youMightAlsoLike ?? []}
                onAdd={(id) => void handleAddToCart(id)}
                addingId={addingProductId}
                justAddedId={justAddedId}
              />
            )}
          </div>
        </div>

        <aside className="rail">
          <Bill
            sessionId={sessionId}
            items={items}
            total={total}
            count={count}
            budgetRemaining={budgetRemaining}
            payment={payment}
            busy={checkoutBusy}
            email={email}
            onEmailChange={setEmail}
            onSetBudget={handleSetBudget}
            onPay={() => void handlePay()}
            onResumePayment={resumePayment}
          />
          {sessionId && <ActivityLog events={events} />}
        </aside>
      </main>

      {notes.length > 0 && (
        <div className="notes" aria-live="polite">
          {notes.map((n) => (
            <div key={n.id} className={`note is-${n.tone}`} role={n.tone === "error" ? "alert" : undefined}>
              <span className="note-text">{n.text}</span>
              <button
                type="button"
                className="note-close"
                onClick={() => dismissNote(n.id)}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
