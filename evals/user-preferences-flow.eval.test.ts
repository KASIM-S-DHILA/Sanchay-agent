import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { unstable_dev } from "wrangler";
import type { Unstable_DevWorker } from "wrangler";
import { execSync } from "node:child_process";

let worker: Unstable_DevWorker;

function queryD1(sql: string): any {
  try {
    const out = execSync(`npx wrangler d1 execute sanchay-db --local --command "${sql.replace(/"/g, '\\"')}" --json`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    const parsed = JSON.parse(out);
    // wrangler --json outputs an array with results
    if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
    return parsed;
  } catch (e: any) {
    console.warn("D1 query failed:", e.message?.slice(0, 200));
    return null;
  }
}

function connect(session: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${(worker as any).address}:${(worker as any).port}/agents/sanchay-agent/${session}`);
    ws.addEventListener("open", () => setTimeout(() => resolve(ws), 400));
    ws.addEventListener("error", () => reject(new Error("ws error")));
    setTimeout(() => reject(new Error("open timeout")), 15000);
  });
}

function chat(ws: WebSocket, content: string, timeout = 30000): Promise<any> {
  ws.send(JSON.stringify({ type: "chat", content }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`chat timeout: ${content}`)), timeout);
    const handler = (e: MessageEvent) => {
      try {
        const d = JSON.parse(String(e.data));
        if (d.type === "chat") {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(d);
        }
      } catch {}
    };
    ws.addEventListener("message", handler);
  });
}

beforeAll(async () => {
  worker = await unstable_dev("src/index.ts", {
    config: "wrangler.jsonc",
    experimental: { disableExperimentalWarning: true },
  });
  for (let i = 0; i < 30; i++) {
    try {
      const r = await worker.fetch("http://example.com/healthz");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("worker never became healthy");
}, 90000);

afterAll(async () => {
  await worker.stop();
  // Cleanup test users
  try {
    execSync(`npx wrangler d1 execute sanchay-db --local --command "DELETE FROM user_preferences WHERE user_id LIKE 'test-flow-%@example.com'" --json`, { stdio: "ignore" });
  } catch {}
});

describe("user-preferences flow (node, unstable_dev)", () => {
  const email = `test-flow-${Date.now()}@example.com`;
  const sid1 = `flow-sid-${Date.now()}`;

  it("full flow — init as new user → add product → verify D1 has previousProducts and preferredCategories", async () => {
    const ws = await connect(sid1);
    // Wait for init handshake
    await new Promise<void>((resolve) => {
      const h = (e: MessageEvent) => {
        const d = JSON.parse(String(e.data));
        if (d.type === "connected") {
          ws.removeEventListener("message", h);
          resolve();
        }
      };
      ws.addEventListener("message", h);
      ws.send(JSON.stringify({ type: "init", email }));
    });

    // Add product
    await chat(ws, "add the black tee");
    // Give time for async D1 writes (updateUserPreferences)
    await new Promise((r) => setTimeout(r, 1000));

    // Verify D1 via wrangler
    const rows = queryD1(`SELECT * FROM user_preferences WHERE user_id = '${email}'`);
    expect(rows).toBeTruthy();
    const row = Array.isArray(rows) ? rows[0] : rows;
    expect(row).toBeDefined();
    const prev = JSON.parse(row.previous_products || "[]");
    expect(prev).toContain("TEE-BLACK-001");
    const cats = JSON.parse(row.preferred_categories || "[]");
    expect(cats).toContain("Tees");

    ws.close();
  }, 60000);

  it("reconnect with same email → sessionCount incremented and previousProducts loaded", async () => {
    const sid2 = `${sid1}-2`;
    const ws = await connect(sid2);
    await new Promise<void>((resolve) => {
      const h = (e: MessageEvent) => {
        const d = JSON.parse(String(e.data));
        if (d.type === "connected") {
          ws.removeEventListener("message", h);
          resolve();
        }
      };
      ws.addEventListener("message", h);
      ws.send(JSON.stringify({ type: "init", email }));
    });

    // Check audit for returning user
    await new Promise((r) => setTimeout(r, 500));
    const res = await worker.fetch(`http://example.com/audit?sid=${encodeURIComponent(sid2)}`);
    const data: any = await res.json();
    const initEvent = data.events?.find((e: any) => e.action === "session.init");
    expect(initEvent).toBeDefined();
    expect(initEvent.reason).toContain("returning user");
    expect(initEvent.reason).toContain("session 2");

    // Verify D1 sessionCount
    const rows = queryD1(`SELECT session_count FROM user_preferences WHERE user_id = '${email}'`);
    const row = Array.isArray(rows) ? rows[0] : rows;
    expect(row?.session_count).toBeGreaterThanOrEqual(2);

    ws.close();
  }, 60000);
});
