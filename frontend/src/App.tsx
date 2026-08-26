import { useCallback, useEffect, useRef, useState } from "react";
import { AuditTrail } from "./components/AuditTrail";

// Test-mode Razorpay key — key ids are public (embedded in checkout flows)
const RAZORPAY_KEY_ID = "rzp_test_TTAxFYmg1Iipgl";

// Sarvam embed config — paste the dashboard-provided embed key before use
const SARVAM_CONFIG = {
  "org-id": "01a03bee-645e-7af9-9269-781d232fdd47",
  "workspace-id": "01a03bee-6465-785a-8a1d-56032e094e67",
  app_id: "Conversatio-2de22e7c-7bd0",
};

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

  // ---- API helpers --------------------------------------------------------

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

  // ---- Session start ------------------------------------------------------

  const startSession = async () => {
    setStarting(true);
    try {
      const data: any = await api("/api/session/start", {
        method: "POST",
        body: JSON.stringify({ user_email: email.trim() || null }),
      });
      if (data.success) {
        setSessionId(data.data.sessionId);
      } else {
        alert(data.error ?? "Failed to start session");
      }
    } finally {
      setStarting(false);
    }
  };

  // ---- Polling ------------------------------------------------------------

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    const loadCart = async () => {
      const data: any = await api("/api/cart");
      if (!cancelled && data.success) setCart(data.data);
    };
    loadCart();
    const timer = setInterval(loadCart, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, api]);

  // ---- Razorpay modal trigger ---------------------------------------------

  // Watches audit entries for a successful checkout and opens Checkout.js once
  const onAuditEvent = useCallback(
    (event: any) => {
      if (event.endpoint !== "/api/checkout" || event.status !== "ok") return;
      const resp = event.response ?? {};
      const data = resp.data ?? resp;
      const orderId = data.orderId;
      const amount = data.amount;
      const paymentUrl = data.paymentUrl;
      if (!orderId || !amount || openedOrdersRef.current.has(orderId)) return;

      openedOrdersRef.current.add(orderId);

      if (paymentUrl) {
        // Payment-link flow — surface as clickable entry
        setLastOrder({ orderId, status: "created" });
        return;
      }

      // Checkout.js modal flow
      if (window.Razorpay) {
        const rzp = new window.Razorpay({
          key: RAZORPAY_KEY_ID,
          order_id: orderId,
          amount,
          currency: "INR",
          name: "Sanchay",
          handler: async () => {
            const res = await fetch(`/api/order/${orderId}`, {
              headers: { "x-session-id": sessionId! },
            });
            const out: any = await res.json();
            if (out.success) setLastOrder({ orderId, status: out.data.status });
          },
        });
        rzp.open();
      }
    },
    [sessionId],
  );

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
            {email && <span>· {email}</span>}
          </div>
        )}
      </header>

      <div className="layout">
        {/* Left: voice + cart */}
        <section className="chat-panel">
          <div className="voice-container">
            <h2>🎤 Voice</h2>
            {sessionId ? (
              <div
                className="sarvam-widget-container"
                ref={(node) => {
                  if (!node || node.childElementCount > 0) return;
                  const widget = document.createElement("sarvam-widget");
                  widget.setAttribute("api-key", "YOUR_SARVAM_EMBED_KEY");
                  widget.setAttribute("app-id", SARVAM_CONFIG.app_id);
                  widget.setAttribute("org-id", SARVAM_CONFIG["org-id"]);
                  widget.setAttribute("workspace-id", SARVAM_CONFIG["workspace-id"]);
                  widget.setAttribute("user-id", email || "guest");
                  widget.setAttribute("button-text", "🎤 Start Voice Shopping");
                  widget.setAttribute("interaction-type", "call");
                  node.appendChild(widget);
                }}
              />
            ) : (
              <p>Start a session to enable voice shopping.</p>
            )}
          </div>

          <div className="cart-display">
            <h2>🛍 Cart</h2>
            {!cart || cart.items.length === 0 ? (
              <p>Your cart is empty. Try "show me hoodies".</p>
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
                    <span className="budget-left"> · Budget left: {rupees(cart.budgetRemaining)}</span>
                  )}
                </div>
              </>
            )}
            {lastOrder && (
              <div className="order-status">
                Order <code>{lastOrder.orderId.slice(0, 18)}…</code>: <strong>{lastOrder.status}</strong>
              </div>
            )}
          </div>
        </section>

        {/* Right: audit */}
        {sessionId && (
          <aside className="audit-panel">
            <AuditTrail sessionId={sessionId} onEvent={onAuditEvent} />
          </aside>
        )}
      </div>
    </div>
  );
}
