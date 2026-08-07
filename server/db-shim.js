'use strict';
// D1 兼容的本地 SQLite 垫片：让同一套 app.js 逻辑既能跑在 node:sqlite（本地/测试），
// 也能直接对接 Cloudflare D1（prepare/bind/all/first/run）。
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
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
`;

class Statement {
  constructor(raw, sql, params = []) {
    this.raw = raw;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.raw, this.sql, params);
  }
  all() {
    // 与 Cloudflare D1 的返回形状保持一致：{ results: [...] }
    return { results: this.raw.prepare(this.sql).all(...this.params) };
  }
  first() {
    return this.raw.prepare(this.sql).get(...this.params);
  }
  run() {
    const r = this.raw.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid } };
  }
}

function createDb(location = ':memory:') {
  const raw = new DatabaseSync(location);
  raw.exec(SCHEMA);
  // 兼容旧库：补齐新列
  const cols = raw.prepare('PRAGMA table_info(players)').all();
  if (!cols.some((c) => c.name === 'nickname_updated_at')) {
    raw.exec('ALTER TABLE players ADD COLUMN nickname_updated_at TEXT');
  }
  return {
    raw,
    prepare(sql) {
      return new Statement(raw, sql);
    },
    batch(statements) {
      const results = [];
      raw.exec('BEGIN');
      try {
        for (const stmt of statements) {
          const r = raw.prepare(stmt.sql).run(...stmt.params);
          results.push({ meta: { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid } });
        }
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
      return results;
    },
  };
}

module.exports = { createDb, SCHEMA };
