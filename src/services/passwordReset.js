'use strict';
const { invalid } = require('../errors');
const { newToken, sha256, hashPassword, passwordProblem } = require('../security');

const MINUTE = 60 * 1000;

/**
 * Emailed password reset. Tokens are random, stored only as a SHA-256 hash, single use,
 * and expire after config.mail.resetMinutes. Only the newest token per account works.
 */
function createPasswordResetService({ db, config, logger, users, sessions, mailer }) {
  const ttlMs = config.mail.resetMinutes * MINUTE;

  function linkFor(token) {
    const base = config.publicUrl || `http://localhost:${config.port}`;
    return `${base}/#reset=${token}`; // fragment: never sent to the server, so not in access logs or Referer
  }

  function message(row, link) {
    const mins = config.mail.resetMinutes;
    const text = `Hi ${row.name},\n\nSomeone asked to reset the password for your Rode account (${row.username}).\n\n` +
      `Choose a new password here (valid for ${mins} minutes, works once):\n${link}\n\n` +
      'If you did not ask for this, ignore this email; your password stays the same.\n';
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<p>Hi ${esc(row.name)},</p><p>Someone asked to reset the password for your Rode account (<b>${esc(row.username)}</b>).</p>` +
      `<p><a href="${esc(link)}">Choose a new password</a><br>This link is valid for ${mins} minutes and works once.</p>` +
      '<p>If you did not ask for this, ignore this email; your password stays the same.</p>';
    return { subject: 'Reset your Rode password', text, html };
  }

  /**
   * Start a reset for a username or email. Always resolves without revealing whether the account exists.
   * Sending happens in the background so response time does not leak account existence either.
   */
  function request(identifier) {
    const row = users.findRowByIdentifier(identifier);
    if (!row || !row.active) return;
    const to = users.recipientFor(row);
    if (!to) { logger.warn('password_reset.no_email', { userId: row.id }); return; }
    if (!mailer.enabled() && !mailer.devFallback()) { logger.warn('password_reset.mail_not_configured', { userId: row.id }); return; }

    const token = newToken();
    const now = Date.now();
    db.transaction(() => {
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.id);
      db.prepare('INSERT INTO password_resets(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
        .run(sha256(token), row.id, now, now + ttlMs);
    })();
    mailer.send({ to, ...message(row, linkFor(token)) })
      .then((sent) => { if (sent) logger.info('password_reset.mail_sent', { userId: row.id }); })
      .catch((e) => logger.error('password_reset.mail_failed', { userId: row.id, error: e.message }));
  }

  /** Check a token without consuming it. Returns the user row or null. */
  function lookup(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const hit = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(token));
    if (!hit) return null;
    if (hit.expires_at <= Date.now()) {
      db.prepare('DELETE FROM password_resets WHERE token_hash = ?').run(hit.token_hash);
      return null;
    }
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(hit.user_id);
    return row && row.active ? row : null;
  }

  /** Set a new password with a valid token, then sign the account out everywhere. */
  async function complete(token, password) {
    const row = lookup(token);
    if (!row) throw invalid('This reset link is invalid or has expired. Request a new one.', 'token');
    const problem = passwordProblem(password, { username: row.username, name: row.name });
    if (problem) throw invalid(problem, 'password');
    const hash = await hashPassword(password);
    const used = db.transaction(() => {
      const gone = db.prepare('DELETE FROM password_resets WHERE token_hash = ?').run(sha256(token)).changes;
      if (!gone) return false; // raced with another use of the same link
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.id);
      db.prepare('UPDATE users SET password_hash = ?, must_change = 0, updated_at = ? WHERE id = ?').run(hash, Date.now(), row.id);
      return true;
    })();
    if (!used) throw invalid('This reset link is invalid or has expired. Request a new one.', 'token');
    sessions.destroyAllForUser(row.id);
    logger.info('password_reset.completed', { userId: row.id });
  }

  const sweep = () => db.prepare('DELETE FROM password_resets WHERE expires_at <= ?').run(Date.now()).changes;

  return { request, lookup, complete, sweep };
}

module.exports = { createPasswordResetService };
