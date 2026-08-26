import { describe, expect, it } from "vitest";

// Truth pass against the DEPLOYED worker.
// Set SANCHAY_BASE_URL=https://<your-worker>.workers.dev and run:
//   SANCHAY_BASE_URL=https://... npx vitest run evals/truth-pass.eval.test.ts
const baseUrl = process.env.SANCHAY_BASE_URL?.replace(/\/$/, "");

describe.skipIf(!baseUrl)("Truth pass: deployed system", () => {
  it("healthz responds", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("catalog.json returns products", async () => {
    const res = await fetch(`${baseUrl}/catalog.json`);
    const data: any = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("catalog search works", async () => {
    const res = await fetch(`${baseUrl}/catalog.json?q=hoodie`);
    const data: any = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("audit endpoint works", async () => {
    const res = await fetch(`${baseUrl}/audit?sid=truth-pass-probe`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data.events)).toBe(true);
    expect(data.sessionId).toBe("truth-pass-probe");
  });

  it("WebSocket + init handshake + chat works end-to-end", async () => {
    const wsUrl = `${baseUrl.replace("https", "wss").replace("http", "ws")}/agents/sanchay-agent/truth-pass-${Date.now()}`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS open timed out")), 20000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS error")); });
    });

    // init handshake
    ws.send(JSON.stringify({ type: "init", email: "truth-pass@example.com" }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connected timeout")), 20000);
      const h = (e: MessageEvent) => {
        try {
          const d = JSON.parse(String(e.data));
          if (d.type === "connected") { clearTimeout(timer); ws.removeEventListener("message", h); resolve(); }
        } catch {}
      };
      ws.addEventListener("message", h);
    });

    // Full turn — real Workers AI planner + narrator
    const reply = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("chat timeout")), 45000);
      const h = (e: MessageEvent) => {
        try {
          const d = JSON.parse(String(e.data));
          if (d.type === "chat") { clearTimeout(timer); ws.removeEventListener("message", h); resolve(d); }
        } catch {}
      };
      ws.addEventListener("message", h);
      ws.send(JSON.stringify({ type: "chat", content: "add the black tee" }));
    });

    expect(reply.content).toBeTruthy();
    expect(reply.cart.some((c: any) => c.productId === "TEE-BLACK-001")).toBe(true);
    ws.close();
  }, 60000);
});
