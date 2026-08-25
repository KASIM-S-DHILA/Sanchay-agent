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
  created_at TEXT
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
