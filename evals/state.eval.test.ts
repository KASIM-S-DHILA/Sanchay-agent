import type { Unstable_DevWorker } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev } from "wrangler";

function messageOnce(ws: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => ws.addEventListener("message", resolve, { once: true }));
}

function connectTimeout(): Promise<never> {
  return new Promise(
    (_, reject) => setTimeout(() => reject(new Error("WS connect timed out")), 15_000),
  );
}

describe("Sanchay Agent State", () => {
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    worker = await unstable_dev("src/index.ts", {
      config: "wrangler.jsonc",
      experimental: { disableExperimentalWarning: true },
    });
  }, 60_000);

  afterAll(async () => {
    await worker.stop();
  });

  it("healthz returns 200", async () => {
    const res = await worker.fetch("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  }, 30_000);

  // ponytail: undici rejects hand-rolled Upgrade requests, so drive a real
  // WebSocket handshake via Node's native client instead
  it("WebSocket connection to agent succeeds", async () => {
    // ponytail: Unstable_DevWorker exposes `address`, not `host`
    const ws = new WebSocket(
      `ws://${worker.address}:${worker.port}/agents/sanchay-agent/test-session`,
    );

    const firstMessage = new Promise<MessageEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS connect timed out")), 15_000);
      ws.addEventListener("open", () => clearTimeout(timer));
      ws.addEventListener("message", (m) => resolve(m));
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`WS error: ${e.message ?? "unknown"}`));
      });
    });

    // ponytail: SDK sends a cf_agent_identity frame first — wait for ours
    const event = await (async () => {
      for (;;) {
        const e = await Promise.race([messageOnce(ws), connectTimeout()]);
        const data = JSON.parse(String(e.data));
        if (!data.type.startsWith("cf_agent_")) return data;
      }
    })();
    ws.close();

    expect(event.type).toBe("connected");
    expect(event.sessionId).toBe("test-session");
    expect(event.cart).toEqual([]);
  });
});
