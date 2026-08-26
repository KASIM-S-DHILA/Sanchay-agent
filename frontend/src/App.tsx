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
        <h1>🛒 Sanchay — Voice Shopping</h1>
        <p className="subtitle">Talk to shop. Every action logged, bounded & audited.</p>
        {!sessionId ? (
          <div className="session-start">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com (optional)"
              className="buyer-input"
            />
            <button onClick={startSession} disabled={starting} className="send-btn">
              {starting ? "Starting…" : "Start shopping session"}
            </button>
          </div>
        ) : (
          <div className="meta">
            <span className="badge badge-ok">session active</span>
            <code className="session-id">{sessionId.slice(0, 13)}…</code>
            {email && <span> · {email}</span>}
          </div>
        )}
      </header>

      <div className="layout">
        {/* Left: voice + cart */}
        <section className="chat-panel">
          <div className="voice-container">
            <h2>🎤 Voice</h2>

            {!sessionId ? (
              <p>Start a session first to enable voice shopping.</p>
            ) : (
              <div className="voice-controls">
                {voice.callState === "idle" && (
                  <button onClick={() => startAndCall()} className="voice-btn">
                    🎤 Start Voice Call
                  </button>
                )}
                {voice.callState === "connecting" && (
                  <button disabled className="voice-btn connecting">
                    Connecting…
                  </button>
                )}
                {voice.callState === "listening" && (
                  <div className="voice-status listening">
                    <span className="pulse-dot red" /> Listening…{" "}
                    <button onClick={voice.stopCall} className="stop-btn">End</button>
                  </div>
                )}
                {voice.callState === "speaking" && (
                  <div className="voice-status speaking">
                    <span className="pulse-dot blue" /> Agent speaking…
                  </div>
                )}
                {voice.error && <p className="voice-error">{voice.error}</p>}

                {voice.transcripts.length > 0 && (
                  <div className="transcripts">
                    {voice.transcripts.map((t, i) => (
                      <div key={i} className={`transcript ${t.role}`}>
                        {t.role === "user" ? "🧑 " : "🤖 "}
                        {t.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="cart-display">
            <h2>🛍 Cart</h2>
            {!cart || cart.items.length === 0 ? (
              <p>Your cart is empty. Try saying "show me hoodies".</p>
            ) : (
              <>
                <ul>
                  {cart.items.map((item) => (
                    <li key={item.productId}>
                      {item.quantity} × {item.name} — {rupees(item.price * item.quantity)}
                    </li>
                  ))}
                </ul>
                <div className="cart-total">
                  Total: <strong>{rupees(cart.total)}</strong>
                  {typeof cart.budgetRemaining === "number" && (
                    <span className="budget-left">
                      {" "}· Budget left: {rupees(cart.budgetRemaining)}
                    </span>
                  )}
                </div>
              </>
            )}
            {lastOrder && (
              <div className="order-status">
                Order <code>{lastOrder.orderId.slice(0, 18)}…</code>:{" "}
                <strong>{lastOrder.status}</strong>
              </div>
            )}
          </div>
        </section>

        {/* Right: audit */}
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
