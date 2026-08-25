// Agent state — persisted per-session via this.setState()
export interface AgentState {
  cart: CartItem[];
  history: TurnRecord[];
  lastDiscussedProductId: string | null;
  pendingIntent: PendingIntent | null;
  confirmArmed: boolean;
  sessionMeta: { userId: string; expiresAt: string } | null;
}

export interface CartItem {
  productId: string;
  name: string;
  price: number; // paise
  quantity: number;
}

export interface TurnRecord {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  actions?: string[];
}

export interface PendingIntent {
  type: "confirm" | "cancel";
  budgetValue?: number;
  span?: string;
}

// Planner output (LLM call #1)
export interface TurnPlan {
  reply: string; // brief internal note, not shown to user
  actions: TurnAction[];
  requestConfirm: boolean;
  requestCancel: boolean;
  reasoning: string; // why the planner chose these actions
}

export type TurnAction =
  | { type: "search"; query: string }
  | { type: "add"; productId: string; quantity: number; replace?: boolean }
  | { type: "remove"; productId: string; quantity?: number }
  | { type: "no_action" };

// Executor results — fed to the narrator
export interface ExecutorResult {
  actions: ExecutedAction[];
  cart: CartItem[];
  cartTotal: number;
  errors: string[];
  stateChanges: {
    cart?: CartItem[];
    lastDiscussedProductId?: string | null;
    confirmArmed?: boolean;
  };
}

export interface ExecutedAction {
  type: string;
  productId?: string;
  productName?: string;
  quantity?: number;
  success: boolean;
  error?: string;
  price?: number;
  orderId?: string;
  paymentUrl?: string;
}

export interface ProductSearchResult {
  productId: string;
  name: string;
  description: string;
  price: number; // paise
  category: string;
  stock: number;
  score: number;
}

// Env type — matches wrangler.jsonc bindings
export interface Env {
  AI: Ai;
  DB: D1Database;
  VECTOR_INDEX: VectorizeIndex;
  SanchayAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  RAZORPAY_WEBHOOK_SECRET: string;
  JWT_SIGNING_KEY: string;
}
