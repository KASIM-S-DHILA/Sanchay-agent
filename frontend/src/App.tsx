import { useState, useCallback, useEffect, useRef } from "react";
import { AuditTrail } from "./components/AuditTrail";
import { useVoiceCall } from "./hooks/useVoiceCall";

// Test-mode Razorpay key — key ids are public (embedded in checkout flows)
const RAZORPAY_KEY_ID = "rzp_test_TTAxFYmg1Iipgl";

interface CartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

interface CartData {
  items: CartItem[];
  total: number;
  count: number;
  budgetRemaining?: number | null;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

declare global {
  interface Window {
    Razorpay: any;
  }
}

export default function App() {
  const [email, setEmail] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartData | null>(null);
  const [starting, setStarting] = useState(false);
  const openedOrdersRef = useRef<Set<string>>(new Set());
  const [lastOrder, setLastOrder] = useState<{ orderId: string; status: string } | null>(null);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(sessionId ? { "x-session-id": sessionId } : {}),
          ...(init?.headers ?? {}),
        },
      });
      return res.json();
    },
    [sessionId],
  );

  const startSession = async () => {
    setStarting(true);
    try {
      const data: any = await api("/api/session/start", {
        method: "POST",
        body: JSON.stringify({ user_email: email.trim() || null }),
      });
      if (data.success) setSessionId(data.data.sessionId);
      else alert(data.error ?? "Failed to start session");
    } finally {
      setStarting(false);
    }
  };

  // Razorpay modal trigger
  const openRazorpay = useCallback(
    (orderId: string, amountPaise: number) => {
      if (!window.Razorpay || !sessionId) return;
      const rzp = new window.Razorpay({
        key: RAZORPAY_KEY_ID,
        order_id: orderId,
        amount: amountPaise,
        currency: "INR",
        name: "Sanchay",
        handler: async () => {
          const res = await fetch(`/api/order/${orderId}`, {
            headers: { "x-session-id": sessionId },
          });
          const out: any = await res.json();
          if (out.success) setLastOrder({ orderId, status: out.data.status });
        },
      });
      rzp.open();
    },
    [sessionId],
  );

  // Cart polling @3s
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const load = async () => {
      const data: any = await api("/api/cart");
      if (!cancelled && data.success) setCart(data.data);
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [sessionId, api]);

  // Voice call hook
  const voice = useVoiceCall(openRazorpay);

  // Start session automatically when voice call needs it
  const startAndCall = async () => {
    if (!sessionId) await startSession();
    // sessionId state may not be set yet — wait a tick then call
    setTimeout(() => voice.startCall(), 300);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand-top">
            <h1>Sanchay<span> — Voice Counter</span></h1>
            <span className="eyebrow">Est. bazaar ledger • audited</span>
          </div>
          <p className="subtitle">Speak to fill a bill. Every add, remove and checkout is measured, bounded and stamped — watch your receipt build live.</p>
        </div>
        <div className="header-actions">
          {!sessionId ? (
            <div className="session-start">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com — optional, for history"
                className="buyer-input"
                aria-label="Email for session"
              />
              <button onClick={startSession} disabled={starting} className="send-btn">
                {starting ? "Starting…" : "Open counter"}
              </button>
            </div>
          ) : (
            <div className="meta">
              <span className="badge badge-ok">counter open</span>
              <code className="session-id">#{sessionId.slice(0, 8).toUpperCase()}</code>
              {email && <span className="meta-email">{email}</span>}
            </div>
          )}
          {sessionId && <span className="eyebrow" style={{ alignSelf: "flex-end" }}>{cart ? `${cart.count} items • ${rupees(cart.total)}` : "0 items"} • live bill</span>}
        </div>
      </header>

      <div className="layout">
        {/* Left: tape */}
        <section className="chat-panel">
          <div className="voice-container">
            <div className="voice-head">
              <h2>Counter tape</h2>
              <span className="ledger-no">Tape {sessionId ? sessionId.slice(0, 4).toUpperCase() : "— — —"} • 16 kHz</span>
            </div>

            {!sessionId ? (
              <p className="voice-hint">Open the counter to enable the mic. Try: <strong>“show me hoodies”</strong> → <strong>“add the gray one”</strong> → <strong>“checkout”</strong>.</p>
            ) : (
              <div className="voice-controls">
                {voice.callState === "idle" && (
                  <button onClick={() => startAndCall()} className="voice-btn">
                    <span aria-hidden>⬢</span> Start voice call
                  </button>
                )}
                {voice.callState === "connecting" && (
                  <button disabled className="voice-btn connecting">
                    Connecting tape…
                  </button>
                )}
                {voice.callState === "listening" && (
                  <div className="voice-status listening">
                    <span className="tape-meter" aria-hidden />
                    Listening — speak now
                    <button onClick={voice.stopCall} className="stop-btn">End</button>
                  </div>
                )}
                {voice.callState === "speaking" && (
                  <div className="voice-status speaking">
                    <span className="tape-meter" aria-hidden />
                    Sanchay replying…
                    <button onClick={voice.stopCall} className="stop-btn">End</button>
                  </div>
                )}
                {voice.error && <p className="voice-error" role="alert">{voice.error}</p>}

                {voice.transcripts.length > 0 ? (
                  <div className="transcripts" aria-live="polite">
                    {voice.transcripts.map((t, i) => (
                      <div key={i} className={`transcript ${t.role}`}>
                        {t.text}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="voice-hint">
                    {voice.callState === "idle" ? "Press Start voice call and allow the mic — the tape will type your words and Sanchay’s replies." : "Tape is empty. Say “show me hoodies” to begin."}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="cart-display">
            <div className="cart-head">
              <h2>Bill — live</h2>
              <span className="cart-meta">{cart ? `${cart.count} pcs` : "0 pcs"} • carbon copy</span>
            </div>
            {!cart || cart.items.length === 0 ? (
              <div className="cart-empty">
                Cart is empty. <strong>Say “show me hoodies”</strong> or “add the black tee” — line items appear here as you speak.
              </div>
            ) : (
              <>
                <ul className="cart-list">
                  {cart.items.map((item) => (
                    <li key={item.productId} className="cart-row">
                      <span className="cart-name">
                        <span className="cart-qty">{item.quantity}×</span> {item.name}
                      </span>
                      <span className="cart-price">{rupees(item.price * item.quantity)}</span>
                    </li>
                  ))}
                </ul>
                <div className="cart-total">
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", opacity: 0.8 }}>Total payable</span>
                  <span>
                    <strong>{rupees(cart.total)}</strong>
                    {typeof cart.budgetRemaining === "number" && (
                      <span className="budget-left"> · left {rupees(cart.budgetRemaining)}</span>
                    )}
                  </span>
                </div>
              </>
            )}
            {lastOrder ? (
              <div className="order-status">
                <span className="stamp">Paid — {lastOrder.status}</span>
                <code>{lastOrder.orderId.slice(0, 18)}…</code>
              </div>
            ) : (
              cart && cart.items.length > 0 && <span className="cart-meta">Say “checkout” when ready — Razorpay will open.</span>
            )}
          </div>
        </section>

        {/* Right: receipt ledger */}
        {sessionId && (
          <aside className="audit-panel">
            <AuditTrail sessionId={sessionId} onEvent={(e) => {
              if (e.endpoint !== "/api/checkout" || e.status !== "ok") return;
              const resp: any = e.response ?? {};
              const d = resp.data ?? resp;
              if (!d.orderId || !d.amount || openedOrdersRef.current.has(d.orderId)) return;
              openedOrdersRef.current.add(d.orderId);
              setLastOrder({ orderId: d.orderId, status: d.status });
              openRazorpay(d.orderId, d.amount);
            }} />
          </aside>
        )}
      </div>
    </div>
  );
}
