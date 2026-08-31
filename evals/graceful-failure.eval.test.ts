import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";
import { signIn } from "./helpers/auth";

let env: any;
const START = "https://test/api/session/start";

async function startSession(body: Record<string, unknown> = {}): Promise<string> {
  const res = await SELF.fetch(START, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  return json.data.sessionId;
}

async function addProduct(sessionId: string, productId: string, quantity = 1) {
  return (
    await SELF.fetch("https://test/api/cart/add", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ product_id: productId, quantity }),
    })
  ).json();
}

async function checkout(sessionId: string, token?: string) {
  const res = await SELF.fetch("https://test/api/checkout", {
    method: "POST",
    headers: { "x-session-id": sessionId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return res.json() as Promise<any>;
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Graceful failure: out-of-stock add", () => {
  it("add fails with Out of stock, audit logs the error", async () => {
    const sessionId = await startSession();
    // Zero the stock
    await env.DB.prepare("UPDATE products SET stock = 0 WHERE id = 'red-sports-tee'").run();

    const data: any = await addProduct(sessionId, "red-sports-tee");
    expect(data.success).toBe(false);
    expect(data.error).toBe("Out of stock");

    // Cart untouched
    const cartRes = await SELF.fetch("https://test/api/cart", {
      headers: { "x-session-id": sessionId },
    });
    const cartData: any = await cartRes.json();
    expect(cartData.data.items.length).toBe(0);

    // Audit trail shows the failed call
    const events = (await (
      await SELF.fetch(`https://test/api/audit?session_id=${sessionId}`, {
        headers: { "x-session-id": sessionId },
      })
    ).json() as any).data.events;
    const failedAdd = events.find((e: any) => e.endpoint === "/api/cart/add" && e.status === "error");
    expect(failedAdd).toBeDefined();

    // Restore
    await env.DB.prepare("UPDATE products SET stock = 50 WHERE id = 'red-sports-tee'").run();
  });
});

describe("Graceful failure: stock vanishes between add and checkout", () => {
  let sessionId: string;
  let token: string;

  beforeAll(async () => {
    sessionId = await startSession();
    token = await signIn(env, sessionId, "graceful-stock@example.com");
    await addProduct(sessionId, "yellow-wool-jumper"); // stock > 0 at add time
    await env.DB.prepare("UPDATE products SET stock = 0 WHERE id = 'yellow-wool-jumper'").run();
  });

  it("checkout re-validates stock, removes the item, and reports unavailability", async () => {
    const data: any = await checkout(sessionId, token);
    expect(data.success).toBe(false);
    expect(data.error).toContain("no longer available");

    // Item was removed from the cart by the checkout re-validation
    const cartRes = await SELF.fetch("https://test/api/cart", {
      headers: { "x-session-id": sessionId },
    });
    const cartData: any = await cartRes.json();
    expect(cartData.data.items.some((i: any) => i.productId === "yellow-wool-jumper")).toBe(false);

    // Audit shows the blocked checkout
    const events = (await (
      await SELF.fetch(`https://test/api/audit?session_id=${sessionId}`, {
        headers: { "x-session-id": sessionId },
      })
    ).json() as any).data.events;
    const failedCheckout = events.find(
      (e: any) => e.endpoint === "/api/checkout" && e.status === "error",
    );
    expect(failedCheckout).toBeDefined();
  });
});






