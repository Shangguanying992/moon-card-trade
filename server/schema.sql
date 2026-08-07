-- Cloudflare D1 建表脚本（与 db-shim.js 中的 SCHEMA 保持一致）
CREATE TABLE IF NOT EXISTS players (
  server TEXT NOT NULL,
  uid TEXT NOT NULL,
  nickname TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  last_update_period TEXT NOT NULL,
  nickname_updated_at TEXT,
  completed_trades INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (server, uid)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  server TEXT NOT NULL,
  uid TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_counts (
  server TEXT NOT NULL,
  uid TEXT NOT NULL,
  card_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server, uid, card_id)
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  owner_server TEXT NOT NULL,
  owner_uid TEXT NOT NULL,
  offered_card INTEGER NOT NULL,
  want_mode TEXT NOT NULL,
  wanted_card INTEGER,
  expected_online TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  period TEXT NOT NULL,
  remind_poster INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_status_period ON posts(status, period);
CREATE INDEX IF NOT EXISTS idx_posts_owner ON posts(owner_server, owner_uid);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL,
  applicant_server TEXT NOT NULL,
  applicant_uid TEXT NOT NULL,
  provided_card INTEGER NOT NULL,
  message TEXT,
  expected_online TEXT,
  status TEXT NOT NULL DEFAULT 'locked',
  applicant_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apps_post ON applications(post_id);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reporter_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id, status);
