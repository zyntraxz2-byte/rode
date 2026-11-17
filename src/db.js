'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

/**
 * Ordered, append-only migrations. Never edit a shipped migration; add a new one.
 * Money is stored as integer minor units (x100) to avoid floating point drift.
 */
const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id              TEXT PRIMARY KEY,
        username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name            TEXT NOT NULL,
        phone           TEXT NOT NULL DEFAULT '',
        role            TEXT NOT NULL CHECK (role IN ('admin','staff','viewer','customer')),
        access          TEXT NOT NULL,
        password_hash   TEXT NOT NULL,
        must_change     INTEGER NOT NULL DEFAULT 0,
        active          INTEGER NOT NULL DEFAULT 1,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        last_login_at   INTEGER
      );

      CREATE TABLE sessions (
        id_hash       TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        ip            TEXT,
        user_agent    TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );

      CREATE TABLE meta (
        key    TEXT PRIMARY KEY,
        value  INTEGER NOT NULL
      );
      INSERT INTO meta(key, value) VALUES ('rev', 1);

      CREATE TABLE appts (
        id           TEXT PRIMARY KEY,
        date         TEXT NOT NULL,
        time         TEXT NOT NULL,
        mins         INTEGER NOT NULL CHECK (mins BETWEEN 5 AND 1440),
        client       TEXT NOT NULL,
        phone        TEXT NOT NULL DEFAULT '',
        service      TEXT NOT NULL,
        staff        TEXT NOT NULL,
        price_minor  INTEGER NOT NULL CHECK (price_minor >= 0),
        status       TEXT NOT NULL CHECK (status IN ('booked','done','cancelled','noshow')),
        method       TEXT CHECK (method IS NULL OR method IN ('cash','card','bank')),
        txn_id       TEXT,
        note         TEXT NOT NULL DEFAULT '',
        sample       INTEGER NOT NULL DEFAULT 0,
        owner_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_by   TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_appts_date ON appts(date, staff);
      CREATE INDEX idx_appts_owner ON appts(owner_id);

      CREATE TABLE txns (
        id            TEXT PRIMARY KEY,
        type          TEXT NOT NULL CHECK (type IN ('income','expense')),
        date          TEXT NOT NULL,
        amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
        category      TEXT NOT NULL DEFAULT '',
        service       TEXT,
        method        TEXT NOT NULL CHECK (method IN ('cash','card','bank')),
        note          TEXT NOT NULL DEFAULT '',
        staff         TEXT,
        appt_id       TEXT,
        sample        INTEGER NOT NULL DEFAULT 0,
        created_by    TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_txns_date ON txns(date);

      CREATE TABLE assets (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
        appt_id     TEXT REFERENCES appts(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL DEFAULT 0,
        mime        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_assets_appt ON assets(appt_id, position);
      CREATE INDEX idx_assets_owner ON assets(owner_id);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
      CREATE UNIQUE INDEX idx_users_email ON users(email COLLATE NOCASE) WHERE email != '';

      CREATE TABLE password_resets (
        token_hash  TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_password_resets_user ON password_resets(user_id);
    `,
  },
];

function openDatabase(dataDir, { filename = 'rode.db' } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = filename === ':memory:' ? ':memory:' : path.join(dataDir, filename);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
    })();
  }
}

/** Increment the global revision counter. Call inside the same transaction as the write. */
function bumpRev(db) {
  db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'").run();
}
function getRev(db) {
  return db.prepare("SELECT value FROM meta WHERE key = 'rev'").get().value;
}

module.exports = { openDatabase, bumpRev, getRev, MIGRATIONS };
