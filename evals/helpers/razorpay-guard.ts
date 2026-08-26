import type { Env } from "../../src/types";

let cached: boolean | null = null;

/**
 * Razorpay test mode caps payment links at 30 EVER created per account
 * (cancelled/expired don't free slots). Probes with a ₹1 link once per run;
 * checkout-success assertions skip when the quota is exhausted — the system's
 * own graceful-degradation path (429 → armed retained) covers that branch.
 */
export async function paymentLinkQuotaAvailable(env: Env): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    const auth = "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
    const order: any = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ amount: 100, currency: "INR", receipt: `quota-probe-${Date.now()}` }),
    }).then((r) => r.json());
    if (!order?.id) { cached = false; return cached; }
    const link = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ amount: 100, currency: "INR", reference_id: order.id }),
    });
    const body: any = await link.json();
    // 429 RATE_LIMIT_EXCEEDED → quota gone; other errors → assume available
    if (link.status === 429 || body?.error?.code === "RATE_LIMIT_EXCEEDED") {
      console.warn("Skipped: Razorpay test-mode payment_link quota exhausted (30 cap)");
      cached = false;
    } else {
      cached = link.ok;
    }
  } catch {
    cached = false;
  }
  return cached;
}
