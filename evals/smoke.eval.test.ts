import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("GET /healthz returns ok", async () => {
    const res = await SELF.fetch("https://example.com/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
