import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { checkoutCart, getOrderStatus } from "./logic";

export async function handleCheckout(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/checkout");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const result = await checkoutCart(env, session.id);
  return Response.json(result.body, { status: result.status });
}

export async function handleOrderStatus(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/order");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const orderId = url.pathname.split("/").pop() ?? "";
  if (!orderId) {
    return Response.json({ success: false, error: "order id is required" }, { status: 400 });
  }

  const result = await getOrderStatus(env, session.id, orderId);
  return Response.json(result.body, { status: result.status });
}
