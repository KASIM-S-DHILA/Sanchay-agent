import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

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

async function checkout(sessionId: string) {
  const res = await SELF.fetch("https://test/api/checkout", {
    method: "POST",
    headers: { "x-session-id": sessionId },
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
    await env.DB.prepare("UPDATE products SET stock = 0 WHERE id = 'TEE-BLACK-001'").run();

    const data: any = await addProduct(sessionId, "TEE-BLACK-001");
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
      await SELF.fetch(`https://test/api/audit?session_id=${sessionId}`)
    ).json() as any).data.events;
    const failedAdd = events.find((e: any) => e.endpoint === "/api/cart/add" && e.status === "error");
    expect(failedAdd).toBeDefined();

    // Restore
    await env.DB.prepare("UPDATE products SET stock = 50 WHERE id = 'TEE-BLACK-001'").run();
  });
});

describe("Graceful failure: stock vanishes between add and checkout", () => {
  let sessionId: string;

  beforeAll(async () => {
    sessionId = await startSession();
    await addProduct(sessionId, "HOODIE-GRAY-001"); // stock > 0 at add time
    await env.DB.prepare("UPDATE products SET stock = 0 WHERE id = 'HOODIE-GRAY-001'").run();
  });

  it("checkout re-validates stock, removes the item, and reports unavailability", async () => {
    const data: any = await checkout(sessionId);
    expect(data.success).toBe(false);
    expect(data.error).toContain("no longer available");

    // Item was removed from the cart by the checkout re-validation
    const cartRes = await SELF.fetch("https://test/api/cart", {
      headers: { "x-session-id": sessionId },
    });
    const cartData: any = await cartRes.json();
    expect(cartData.data.items.some((i: any) => i.productId === "HOODIE-GRAY-001")).toBe(false);

    // Audit shows the blocked checkout
    const events = (await (
      await SELF.fetch(`https://test/api/audit?session_id=${sessionId}`)
    ).json() as any).data.events;
    const failedCheckout = events.find(
      (e: any) => e.endpoint === "/api/checkout" && e.status === "error",
    );
    expect(failedCheckout).toBeDefined();
  });
});






