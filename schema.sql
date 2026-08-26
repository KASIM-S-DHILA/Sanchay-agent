CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  created_at TEXT
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
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS intent_mandates (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  jwt TEXT,
  budget_value INTEGER,
  span TEXT,
  created_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS cart_mandates (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  jwt TEXT,
  cart_hash TEXT,
  created_at TEXT
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

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  type TEXT,
  payload_json TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  preferred_categories TEXT,
  budget_preference INTEGER,
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

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  preferred_categories TEXT,
  budget_preference INTEGER,
  previous_products TEXT,
  purchase_history TEXT,
  session_count INTEGER DEFAULT 0,
  last_active TEXT,
  updated_at TEXT
);
