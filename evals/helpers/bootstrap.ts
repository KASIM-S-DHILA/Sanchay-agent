/**
 * D1 bootstrap for API evals — creates all tables fresh.
 * Eval environments start with an empty D1, so plain CREATE TABLE works.
 */
export async function bootstrapSchema(db: any): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT, status TEXT,
      expires_at TEXT, created_at TEXT, budget_paise INTEGER)`,
    `CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, session_id TEXT, razorpay_order_id TEXT,
      amount INTEGER, currency TEXT, status TEXT, items_json TEXT,
      payment_url TEXT, created_at TEXT, stock_released INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS cart_items (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, product_id TEXT NOT NULL,
      product_name TEXT NOT NULL, price INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1, added_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_session_product ON cart_items(session_id, product_id)`,
    `CREATE TABLE IF NOT EXISTS api_call_log (
      id TEXT PRIMARY KEY, session_id TEXT, endpoint TEXT NOT NULL,
      method TEXT NOT NULL, params_json TEXT, response_json TEXT,
      status TEXT NOT NULL, duration_ms INTEGER, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_api_log_session ON api_call_log(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_api_log_ts ON api_call_log(created_at)`,
    `CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY, name TEXT, preferred_categories TEXT,
      budget_preference INTEGER, previous_products TEXT, purchase_history TEXT,
      session_count INTEGER DEFAULT 0, last_active TEXT, updated_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT, email TEXT, created_at TEXT)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE TABLE IF NOT EXISTS otps (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'sign_in', attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email)`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS idempotency_keys (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, endpoint TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, status_code INTEGER NOT NULL,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_unique ON idempotency_keys(session_id, endpoint, idempotency_key)`,
    `CREATE TABLE IF NOT EXISTS voice_transcripts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      text TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_voice_transcripts_session ON voice_transcripts(session_id)`,
    `CREATE TABLE IF NOT EXISTS search_result_cache (
      session_id TEXT PRIMARY KEY, results_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS pending_actions (
      token TEXT PRIMARY KEY, session_id TEXT NOT NULL, action TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      consumed_at TEXT)`,
  ];
  for (const stmt of statements) {
    await db.prepare(stmt).run().catch(() => { });
  }
}
