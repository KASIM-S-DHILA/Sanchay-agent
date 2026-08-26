import type { Unstable_DevWorker } from "wrangler";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev } from "wrangler";

let worker: Unstable_DevWorker;

function connect(session: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://${worker.address}:${worker.port}/agents/sanchay-agent/${session}`,
    );
    ws.addEventListener("open", () => setTimeout(() => resolve(ws), 400));
    ws.addEventListener("error", () => reject(new Error("ws error")));
    setTimeout(() => reject(new Error("open timeout")), 15000);
  });
}

function sendChat(ws: WebSocket, text: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`WS timeout: ${text}`)), 30000);
    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.type === "chat") {
          clearTimeout(timeout);
          ws.removeEventListener("message", handler);
          resolve(data);
        }
      } catch {}
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ type: "chat", content: text }));
  });
}

async function audit(sid: string): Promise<any[]> {
  const res = await worker.fetch(`http://example.com/audit?sid=${encodeURIComponent(sid)}`);
  const data: any = await res.json();
  return data.events ?? [];
}

const DEV_VARS_PATH = ".dev.vars";

describe("Graceful failure: out-of-stock product", () => {
  const sid = `oos-${Date.now()}`;
  let ws: WebSocket;

  beforeAll(async () => {
    worker = await unstable_dev("src/index.ts", {
      config: "wrangler.jsonc",
      experimental: { disableExperimentalWarning: true },
    });
    for (let i = 0; i < 30; i++) {
      try {
        const r = await worker.fetch("http://example.com/healthz");
        if (r.status === 200) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    // Zero the stock
    execSync(
      `npx wrangler d1 execute sanchay-db --local --command "UPDATE products SET stock = 0 WHERE id = 'TEE-BLACK-001'" --json`,
      { stdio: "ignore" },
    );
    ws = await connect(sid);
    await new Promise<void>((resolve) => {
      const h = (e: MessageEvent) => {
        try {
          const d = JSON.parse(String(e.data));
          if (d.type === "connected") { ws.removeEventListener("message", h); resolve(); }
        } catch {}
      };
      ws.addEventListener("message", h);
      ws.send(JSON.stringify({ type: "init", email: "oos-test@example.com" }));
    });
  }, 90_000);

  afterAll(async () => {
    // Restore stock to 50
    try {
      execSync(
        `npx wrangler d1 execute sanchay-db --local --command "UPDATE products SET stock = 50 WHERE id = 'TEE-BLACK-001'" --json`,
        { stdio: "ignore" },
      );
    } catch {}
    ws?.close();
    await worker?.stop();
  });

  it("out-of-stock handled gracefully end-to-end", async () => {
    // 1+2. Executor returns failed action; narrator explains (not "added")
    const res = await sendChat(ws, "add the black tee");
    expect(res.content).not.toMatch(/i've added|i have added|added to your cart/i);
    expect(res.content).toMatch(/out of stock|unavailable|sorry/i);

    // 3. Claim-check passed — the failure claim matches the failure fact
    const events = await audit(sid);
    const claimFailures = events.filter((e) => e.action === "claim_check.failed");
    expect(claimFailures.length).toBe(0);
    expect(events.some((e) => e.action === "claim_check.passed")).toBe(true);

    // 4. Cart unchanged (no tee in it)
    expect(res.cart.some((c: any) => c.productId === "TEE-BLACK-001")).toBe(false);

    // 5. Audit trail shows the failed executor action
    const execEvent = events.find((e) => e.action === "executor.executed");
    expect(execEvent).toBeDefined();
    expect(execEvent.status).toBe("partial");
    expect(String(execEvent.reason)).toContain("add:false");
  });
});

// ponytail: local dev reads secrets from .dev.vars which overrides `vars`,
// so simulating bad Razorpay keys requires swapping that file. Gated behind
// RUN_GATEWAY_FAILURE=1 and run ALONE (`npx vitest run evals/graceful-failure`)
// so no concurrent pool reads the mutated file.
describe.skipIf(process.env.RUN_GATEWAY_FAILURE !== "1")(
  "Graceful failure: Razorpay gateway error",
  () => {
    const sid = `gw-fail-${Date.now()}`;
    let ws: WebSocket;
    let original: string;

    beforeAll(async () => {
      original = readFileSync(DEV_VARS_PATH, "utf8");
      const broken = `${original}\nRAZORPAY_KEY_ID=invalid_key_override\nRAZORPAY_KEY_SECRET=invalid_secret_override`;
      writeFileSync(DEV_VARS_PATH, broken);

      worker = await unstable_dev("src/index.ts", {
        config: "wrangler.jsonc",
        experimental: { disableExperimentalWarning: true },
      });
      for (let i = 0; i < 30; i++) {
        try {
          const r = await worker.fetch("http://example.com/healthz");
          if (r.status === 200) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
      ws = await connect(sid);
      await new Promise<void>((resolve) => {
        const h = (e: MessageEvent) => {
          try {
            const d = JSON.parse(String(e.data));
            if (d.type === "connected") { ws.removeEventListener("message", h); resolve(); }
          } catch {}
        };
        ws.addEventListener("message", h);
        ws.send(JSON.stringify({ type: "init", email: "gw-fail@example.com" }));
      });
      await sendChat(ws, "add the black tee");
      await sendChat(ws, "checkout");
    }, 120_000);

    afterAll(async () => {
      writeFileSync(DEV_VARS_PATH, original);
      ws?.close();
      await worker?.stop();
    });

    it("gateway failure → checkout_initiated:false, armed retained, audited", async () => {
      const res = await sendChat(ws, "yes");

      // 1. Executor returned a failed checkout
      const initiated = res.executor?.actions?.find((a: any) => a.type === "checkout_initiated");
      expect(initiated?.success).toBe(false);

      // 2. Narrator explains rather than claiming success
      expect(res.content).not.toMatch(/payment link is ready|here's your link/i);

      // 3. confirmArmed stays true (retryable)
      expect(res.executor?.stateChanges?.confirmArmed).toBe(true);

      // 4. Audit trail shows the failure
      const events = await audit(sid);
      const checkout = events.find((e) => e.action === "checkout.executed");
      expect(checkout?.status).toBe("failed");
    });
  },
);
