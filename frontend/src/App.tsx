import { useAgent } from "agents/react";
import { useEffect, useRef, useState } from "react";
import { AuditTrail } from "./components/AuditTrail";
import type { AgentState } from "./types";

export default function App() {
  const [sessionId, setSessionId] = useState(
    () => `session-${crypto.randomUUID().slice(0, 8)}`,
  );
  const [showAudit, setShowAudit] = useState(true);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<{ role: string; content: string; paymentUrl?: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<AgentState>({
    agent: "sanchay-agent",
    name: sessionId,
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false),
    onStateUpdate: (state) => {
      // State updates from the agent (cart, etc.) — we'll use these in later phases
      console.log("State update:", state);
    },
    onMessage: (message) => {
      const data =
        typeof message.data === "string" ? JSON.parse(message.data) : message.data;
      if (data.type === "chat") {
        setMessages((prev) => [...prev, { role: "assistant", content: data.content }]);
        if (data.paymentUrl) {
          setMessages((prev) => [
            ...prev,
            { role: "system", content: "💳 Payment link ready:", paymentUrl: data.paymentUrl },
          ]);
        }
      }
      if (data.type === "connected") {
        setMessages((prev) => [
          ...prev,
          { role: "system", content: `Connected as session ${data.sessionId}` },
        ]);
      }
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = () => {
    if (!input.trim() || !connected) return;
    setMessages((prev) => [...prev, { role: "user", content: input }]);
    agent.send(JSON.stringify({ type: "chat", content: input }));
    setInput("");
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🛒 Sanchay — Agentic Commerce</h1>
        <p className="subtitle">
          Conversational in-app checkout · Razorpay test mode · Bounded &amp; audited money
          actions
        </p>
        <div className="meta">
          <label>Session: </label>
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className="buyer-input"
          />
          <button onClick={() => setShowAudit((s) => !s)} className="toggle-btn">
            {showAudit ? "Hide" : "Show"} Audit Trail
          </button>
        </div>
      </header>

      <div className="layout">
        <section className="chat-panel">
          <div className="messages" ref={scrollRef}>
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <div className="msg-role">
                  {m.role === "user" ? "🧑 You" : m.role === "assistant" ? "🤖 Agent" : "🔗 System"}
                </div>
                <div className="msg-text">
                  {m.paymentUrl ? (
                    <a href={m.paymentUrl} target="_blank" rel="noopener noreferrer" className="payment-link">
                      Pay Now →
                    </a>
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            ))}
            {!connected && <div className="msg system typing">🔗 Connecting…</div>}
          </div>

          <div className="composer">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Type a message…"
              className="composer-input"
              disabled={!connected}
            />
            <button onClick={send} disabled={!connected} className="send-btn">
              Send
            </button>
          </div>

          <div className="hints">
            <span>Try:</span>
            <button onClick={() => setInput("Show me the catalog")}>Browse catalog</button>
            <button onClick={() => setInput("I want a black tee in medium")}>Add to cart</button>
            <button onClick={() => setInput("Checkout my cart")}>Checkout</button>
          </div>
        </section>

        {showAudit && (
          <aside className="audit-panel">
            <AuditTrail />
          </aside>
        )}
      </div>
    </div>
  );
}
