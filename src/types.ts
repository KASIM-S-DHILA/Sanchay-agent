export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTOR_INDEX: VectorizeIndex;
  ASSETS: Fetcher;
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  RAZORPAY_WEBHOOK_SECRET: string;
  GEMINI_API_KEY: string;
  // Merchant-configured order ceiling (paise), independent of whatever
  // budget a session/caller declares — see checkoutCart in api/logic.ts.
  // Optional; falls back to a hardcoded default if unset so the ceiling
  // always exists even without deployment-specific config.
  MERCHANT_MAX_ORDER_PAISE?: string;
  // Shared-secret gate for /admin/* and /api/audit — see
  // middleware/adminAuth.ts. Optional; if unset, those endpoints are
  // rejected entirely rather than left open.
  ADMIN_TOKEN?: string;
  // HS256 signing secret for auth JWTs (see middleware/auth.ts). Optional in
  // type only so local dev without the secret set still boots; getAuthUser/
  // signJWT fall back to a fixed dev string, which must NEVER be reachable
  // in prod — always set this via `wrangler secret put JWT_SIGNING_KEY`.
  JWT_SIGNING_KEY?: string;
  // Server-side secret for verifying Cloudflare Turnstile tokens on
  // /api/auth/otp — see api/auth.ts. If unset, Turnstile verification is
  // skipped (dev convenience); production must set this.
  TURNSTILE_SECRET_KEY?: string;
  // Resend API key for OTP sign-in emails (src/api/auth.ts sendOtpEmail).
  // Cloudflare Email Sending needs a paid zone plan, so Resend (free tier:
  // 3,000/month) is used instead — a plain HTTPS POST, no binding needed.
  // Optional in type only so local dev without the secret set still boots;
  // sendOtpEmail falls back to logging the code when unset.
  RESEND_API_KEY?: string;
}

export interface CartItem {
  productId: string;
  name: string;
  price: number; // paise
  quantity: number;
}

export interface ProductSearchResult {
  productId: string;
  name: string;
  description: string;
  price: number; // paise
  category: string;
  stock: number;
  image_url: string | null;
  score: number;
}

export interface Session {
  id: string;
  userId: string | null;
  status: string;
  budgetPaise: number | null;
  expiresAt: string;
  createdAt: string;
}

export interface UserPreferences {
  name: string | null;
  previousProducts: string[];
  purchaseHistory: string[];
  sessionCount: number;
  lastActive: string | null;
}

export interface ApiCallLogEntry {
  id: string;
  sessionId: string | null;
  endpoint: string;
  method: string;
  params: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  status: string;
  durationMs: number;
  createdAt: string;
}

// ---- API response shapes -------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface CartResponse {
  items: CartItem[];
  total: number; // paise
  count: number; // total quantity across line items
  budgetRemaining?: number | null; // paise, null if no budget
}

export interface CheckoutResponse {
  orderId: string;
  amount: number; // paise
  paymentUrl?: string;
  status: string;
}

export interface OrderResponse {
  orderId: string;
  status: string; // created | attempted | paid
  amount: number;
  items: CartItem[];
}

export interface SessionStartResponse {
  sessionId: string;
  userPreferences: UserPreferences | null;
}
