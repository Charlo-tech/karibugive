-- Karibu Give SQLite schema
CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_number TEXT NOT NULL,
  cause_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','failed')),
  checkout_request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  synced_to_snowflake INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
CREATE INDEX IF NOT EXISTS idx_donations_cause ON donations(cause_id);
CREATE INDEX IF NOT EXISTS idx_donations_checkout ON donations(checkout_request_id);
CREATE INDEX IF NOT EXISTS idx_donations_synced ON donations(synced_to_snowflake);

-- Causes: charity causes managed via admin. Only 3 may be active (is_active=1) at a time.
CREATE TABLE IF NOT EXISTS causes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  target_amount INTEGER NOT NULL DEFAULT 300000,
  emoji TEXT NOT NULL DEFAULT '❤️',
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
