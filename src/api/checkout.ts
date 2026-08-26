import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { isUnsubstitutedPlaceholder, placeholderError } from "../middleware/placeholders";
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

  // Accept the order id from a JSON body as well as the URL path. Every other
  // voice tool is a plain POST with a JSON body; requiring this one to
  // template a path segment made it the odd one out in the tool editor and the
  // easiest of the seven to misconfigure.
  let bodyOrderId: unknown;
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      bodyOrderId = body.order_id ?? body.orderId;
    } catch { /* no body — fall back to the path */ }
  }

  const pathTail = url.pathname.split("/").pop() ?? "";
  const fromPath = pathTail === "order" ? "" : pathTail; // POST /api/order carries no id
  const orderId = String(bodyOrderId ?? fromPath ?? "").trim();

  if (isUnsubstitutedPlaceholder(orderId)) {
    return Response.json({ success: false, error: placeholderError("order id") }, { status: 400 });
  }
  if (!orderId) {
    return Response.json({ success: false, error: "order_id is required" }, { status: 400 });
  }

  const result = await getOrderStatus(env, session.id, orderId);
  return Response.json(result.body, { status: result.status });
}
