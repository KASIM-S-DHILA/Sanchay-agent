/**
 * Idempotent D1 bootstrap for API evals — isolated test D1s start empty and
 * pre-existing local/remote DBs may lack newer columns. Every statement is
 * individually best-effort (ALTERs fail harmlessly when already applied).
 */
export async function bootstrapSchema(db: any): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT, status TEXT, expires_at TEXT,
      created_at TEXT, budget_paise INTEGER)`,
    `ALTER TABLE sessions ADD COLUMN budget_paise INTEGER`,
    `CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, session_id TEXT, razorpay_order_id TEXT,
      amount INTEGER, currency TEXT, status TEXT, items_json TEXT,
      payment_url TEXT, created_at TEXT)`,
    `ALTER TABLE orders ADD COLUMN payment_url TEXT`,
    `CREATE TABLE IF NOT EXISTS cart_items (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, product_id TEXT NOT NULL,
      product_name TEXT NOT NULL, price INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1, added_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id)`,
    `CREATE TABLE IF NOT EXISTS api_call_log (
      id TEXT PRIMARY KEY, session_id TEXT, endpoint TEXT NOT NULL,
      method TEXT NOT NULL, params_json TEXT, response_json TEXT,
      status TEXT NOT NULL, duration_ms INTEGER, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_api_log_session ON api_call_log(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_api_log_ts ON api_call_log(created_at)`,
    `CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY, preferred_categories TEXT,
      budget_preference INTEGER, previous_products TEXT, purchase_history TEXT,
      session_count INTEGER DEFAULT 0, last_active TEXT, updated_at TEXT)`,
  ];
  for (const stmt of statements) {
    await db.prepare(stmt).run().catch(() => {});
  }
}
