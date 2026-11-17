'use strict';
const { newToken, sha256 } = require('../security');
const { rowToUser } = require('./users');

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

function createSessionService({ db, config }) {
  const idleMs = config.sessionIdleHours * HOUR;
  const maxMs = config.sessionMaxDays * DAY;

  function create(userId, { ip = null, userAgent = null } = {}) {
    const token = newToken();
    const now = Date.now();
    db.prepare('INSERT INTO sessions(id_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)')
      .run(sha256(token), userId, now, now + Math.min(idleMs, maxMs), now, ip, (userAgent || '').slice(0, 200));
    return token;
  }

  /** Returns { user, session } for a valid token, otherwise null. Slides the idle expiry forward. */
  function resolve(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const hash = sha256(token);
    const now = Date.now();
    const row = db.prepare(`
      SELECT s.created_at AS s_created, s.expires_at AS s_expires, s.last_seen_at AS s_seen, u.*
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND u.active = 1`).get(hash);
    if (!row) return null;
    if (row.s_expires <= now || row.s_created + maxMs <= now) {
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash);
      return null;
    }
    if (now - row.s_seen > 5 * 60 * 1000) {
      const expires = Math.min(now + idleMs, row.s_created + maxMs);
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').run(now, expires, hash);
    }
    return { user: rowToUser(row), hash };
  }

  const destroy = (token) => { if (token) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token)); };
  const destroyAllForUser = (userId, exceptHash = null) => {
    if (exceptHash) db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, exceptHash);
    else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  };
  const sweep = () => db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?').run(Date.now(), Date.now() - maxMs).changes;

  return { create, resolve, destroy, destroyAllForUser, sweep, maxAgeSeconds: Math.floor(maxMs / 1000) };
}

module.exports = { createSessionService };
