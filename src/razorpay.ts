import type { Env } from "./types";
import { hmacSHA256 } from "./crypto";

const RZP_BASE = "https://api.razorpay.com/v1";

export interface RazorpayOrder {
  id: string;
  amount: number; // paise
  currency: string;
  status: string;
  receipt: string;
  short_url?: string; // payment link
}

function authHeader(env: Env): string {
  const creds = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  return `Basic ${creds}`;
}

async function rzpFetch(env: Env, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${RZP_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(env),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Razorpay ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function createOrder(env: Env, amountPaise: number, receipt: string): Promise<RazorpayOrder> {
  return rzpFetch(env, "/orders", {
    method: "POST",
    body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt }),
  });
}

export async function createPaymentLink(env: Env, orderId: string, customerEmail: string): Promise<string> {
  // Payment Links API needs the amount — fetch it from the order we just created
  const order = await rzpFetch(env, `/orders/${orderId}`);
  const link = await rzpFetch(env, "/payment_links", {
    method: "POST",
    body: JSON.stringify({
      amount: order.amount,
      currency: "INR",
      accept_partial: false,
      description: "Sanchay order",
      customer: { email: customerEmail },
      notify: { sms: false, email: true },
      reminder_enable: false,
      notes: { order_id: orderId },
    }),
  });
  return link.short_url;
}

export async function verifyPayment(
  env: Env,
  razorpayPaymentId: string,
  razorpayOrderId: string,
  razorpaySignature: string,
): Promise<boolean> {
  const expected = await hmacSHA256(`${razorpayOrderId}|${razorpayPaymentId}`, env.RAZORPAY_WEBHOOK_SECRET);
  return expected === razorpaySignature;
}

export async function capturePayment(env: Env, paymentId: string, amountPaise: number): Promise<boolean> {
  try {
    // Only needed for test-mode orders that aren't auto-captured
    await rzpFetch(env, `/payments/${paymentId}/capture`, {
      method: "POST",
      body: JSON.stringify({ amount: amountPaise, currency: "INR" }),
    });
    return true;
  } catch {
    return false;
  }
}
