CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  created_at TEXT
);

-- One account per email. Without this, verifying the same email twice (e.g.
-- two browser tabs racing an OTP verify) could create two `users` rows for
-- the same person instead of finding-or-creating a single one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- One-time codes for email-based sign-in. code_hash is SHA-256 of the raw
-- 6-digit code — the raw code is never stored, so a DB read alone can't be
-- used to sign in as someone else. attempts caps guessing per minted code
-- (5 wrong tries invalidates it); consumed_at makes a code single-use.
CREATE TABLE IF NOT EXISTS otps (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'sign_in',
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email);

-- Fixed-window rate limiting, shared by otp send/verify, token mint, and
-- checkout. `key` encodes both the action and the caller (e.g.
-- "otp_send:ip:1.2.3.4" or "checkout:session:<id>") so different actions
-- never share a counter. One row per active window; a request past
-- window_start + window_seconds starts a fresh window instead of reading
-- this row, so expired windows don't need a cleanup job to stay correct.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  status TEXT,
  expires_at TEXT,
  created_at TEXT,
  budget_paise INTEGER
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  price INTEGER,
  category TEXT,
  stock INTEGER,
  image_url TEXT,
  embedding_id TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  razorpay_order_id TEXT,
  amount INTEGER,
  currency TEXT,
  status TEXT,
  items_json TEXT,
  payment_url TEXT,
  created_at TEXT,
  -- Set the instant reserved stock is released for this order (on
  -- payment.failed, or on expiry via reconcileExpiredOrders) — guards
  -- against releasing the same reservation twice. payment.failed marks the
  -- order 'attempted' (not 'cancelled', so a retry can reuse it) rather
  -- than 'cancelled', so without this flag a later expiry pass would see
  -- that still-'attempted' order and credit its stock back a second time.
  stock_released INTEGER DEFAULT 0,
  -- Set the instant this order's items are removed from cart_items (see
  -- clearPaidItemsFromCart / reconcilePaidOrders in api/logic.ts) — guards
  -- against reconcilePaidOrders re-clearing the SAME order's items forever.
  -- Without this, reconcilePaidOrders re-scanned every paid order on every
  -- single cart read with no memory of having already cleared it, so
  -- adding the SAME product again later (a completely normal repeat
  -- purchase) got silently deleted the instant that read's reconciliation
  -- pass ran — the add itself succeeded, but the very next cart read (the
  -- add's own response) wiped it, making it look like add_to_cart was
  -- simply broken.
  cart_cleared INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  action TEXT,
  intent TEXT,
  params_json TEXT,
  result_json TEXT,
  status TEXT,
  created_at TEXT
);

-- preferred_categories and budget_preference columns existed here
-- previously but had no writer anywhere in the codebase (always empty/
-- NULL) and were dropped as dead schema — see the removal note in
-- api/logic.ts's setBudget/getAccountProfile comments for what actually
-- serves those signals now.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  previous_products TEXT,
  purchase_history TEXT,
  session_count INTEGER DEFAULT 0,
  last_active TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS cart_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id);

-- Required for the atomic ON CONFLICT upsert in addToCart to be race-safe:
-- without this, concurrent adds for the same product each see "no existing
-- row" and insert duplicate rows instead of contending for one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_session_product ON cart_items(session_id, product_id);

CREATE TABLE IF NOT EXISTS api_call_log (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  params_json TEXT,
  response_json TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_log_session ON api_call_log(session_id);
CREATE INDEX IF NOT EXISTS idx_api_log_ts ON api_call_log(created_at);
-- handleAudit's query (WHERE session_id = ? ORDER BY created_at DESC LIMIT
-- ?) is polled every 3 seconds by every active session for as long as its
-- tab stays open — with only the single-column indexes above, SQLite can
-- use ONE of them for the WHERE filter but still has to sort every
-- matching row by created_at afterward, which for a long-lived session
-- (thousands of rows accumulated over an extended session) measured in
-- the ~900ms average / ~7.8s worst case on every single poll — a real,
-- observed production slowdown, not a theoretical one. This compound
-- index lets the same query satisfy the filter AND the ordering from the
-- index directly, with no separate sort step, regardless of how many rows
-- that session has accumulated.
CREATE INDEX IF NOT EXISTS idx_api_log_session_ts ON api_call_log(session_id, created_at DESC);

-- Idempotency replay store for cart/add (and future mutating endpoints).
-- A retry with the same (session_id, endpoint, idempotency_key) replays the
-- stored result instead of re-executing the mutation.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_unique
  ON idempotency_keys(session_id, endpoint, idempotency_key);

-- Persists the live voice call transcript (both shopper and agent turns) so
-- a conversation can be reviewed after the call ends or the page reloads —
-- separate from api_call_log, which audits commerce ACTIONS, not
-- conversational text.
CREATE TABLE IF NOT EXISTS voice_transcripts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user' | 'agent'
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_transcripts_session ON voice_transcripts(session_id);

-- Caches the most recent search_catalog results per session so add_to_cart
-- can resolve a product_id it doesn't recognize against what was actually
-- shown to the shopper a moment earlier, instead of only failing. Observed
-- live: the agent sent "TSHIRT-BLK-001" for a product actually named
-- "Black Classic Tee" (id "TEE-BLACK-001") -- a fabricated id that resolves
-- cleanly against the cached name. One row per session; each new search
-- overwrites the previous one, since only the most recent listing is a
-- plausible source for the next add.
CREATE TABLE IF NOT EXISTS search_result_cache (
  session_id TEXT PRIMARY KEY,
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Two-phase commit for cart mutations: propose_cart_change resolves what the
-- caller meant (product, quantity, add/remove) and previews the outcome
-- WITHOUT writing to cart_items. Nothing mutates until confirm_action is
-- called with the exact token this minted. This exists because a single-shot
-- add/remove call trusts the caller (model or dashboard misconfiguration) to
-- have constructed a correct request; a token round-trip means a mutation can
-- only happen for something we already resolved and reported back, and
-- audit rows for propose vs confirm make an abandoned/never-confirmed
-- proposal visible as its own outcome rather than indistinguishable from a
-- successful mutation.
CREATE TABLE IF NOT EXISTS pending_actions (
  token TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL, -- 'add' | 'remove'
  payload_json TEXT NOT NULL, -- resolved product_id/quantity/name, never the raw input
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_session ON pending_actions(session_id);

-- "Seen" products — a floating product-detail window that stayed open at
-- least MIN_DWELL_MS (see logViewedProduct in api/logic.ts) logs a row
-- here. Deliberately session_id-scoped, not user_id-scoped: exactly like
-- cart_items and orders, this makes sign-in migration free (see
-- migrateGuestSessionToUser in api/userMigration.ts, which only ever
-- repoints sessions.user_id — nothing here needs its own merge step,
-- unlike user_preferences's array-merge). getViewedProducts joins through
-- sessions.user_id at query time, the same pattern getPurchaseHistory uses
-- for orders.
--
-- One row per (session, product) — reopening something already seen this
-- session just bumps last_viewed_at rather than accumulating duplicate
-- rows, so "recently seen" reflects genuine recency, not repeat-view noise.
CREATE TABLE IF NOT EXISTS viewed_products (
  session_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  first_viewed_at TEXT NOT NULL,
  last_viewed_at TEXT NOT NULL,
  PRIMARY KEY (session_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_viewed_products_session ON viewed_products(session_id, last_viewed_at);
