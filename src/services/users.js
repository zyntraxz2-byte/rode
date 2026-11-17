'use strict';
const V = require('../validate');
const { invalid, conflict, notFound } = require('../errors');
const { newId } = require('../util');
const { hashPassword, passwordProblem } = require('../security');
const { ROLES, normaliseAccess, parseStoredAccess } = require('../permissions');

const USERNAME_RE = /^[a-z0-9][a-z0-9._@+-]{2,63}$/;

function rowToUser(r) {
  return {
    id: r.id,
    username: r.username,
    name: r.name,
    phone: r.phone,
    email: r.email || '',
    role: r.role,
    access: parseStoredAccess(r.role, r.access),
    active: !!r.active,
    mustChange: !!r.must_change,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastLoginAt: r.last_login_at,
  };
}

function normaliseUsername(v) {
  const u = V.str(v, 'username', { min: 1, max: 64 }).toLowerCase();
  if (!USERNAME_RE.test(u)) {
    throw invalid('Username must be 3-64 characters: letters, numbers and . _ @ + - (no spaces).', 'username');
  }
  return u;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Optional email: '' clears it. */
function normaliseEmail(v) {
  const e = V.str(v, 'email', { max: 120 }).toLowerCase();
  if (e && !EMAIL_RE.test(e)) throw invalid('Enter a valid email address.', 'email');
  return e;
}

function createUsersService({ db, sessions, logger }) {
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const byName = db.prepare('SELECT * FROM users WHERE username = ?');
  const activeAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?");

  const byEmail = db.prepare("SELECT * FROM users WHERE email != '' AND email = ? COLLATE NOCASE");

  const findRowByUsername = (username) => byName.get(String(username).toLowerCase());
  /** Account lookup for "forgot password": by username, or by the email on the account. */
  const findRowByIdentifier = (identifier) => {
    const s = String(identifier).trim().toLowerCase();
    return byName.get(s) || byEmail.get(s);
  };
  /** Where mail for this account goes: its email, or the username when that is itself an address. */
  const recipientFor = (row) => row.email || (EMAIL_RE.test(row.username) ? row.username : '');
  const findById = (id) => { const r = byId.get(id); return r ? rowToUser(r) : null; };
  const list = () => db.prepare('SELECT * FROM users ORDER BY role = \'admin\' DESC, name COLLATE NOCASE').all().map(rowToUser);

  async function create(input) {
    V.obj(input);
    const username = normaliseUsername(input.username);
    const name = V.str(input.name, 'name', { min: 1, max: 80 });
    const phone = V.str(input.phone, 'phone', { max: 30 });
    const email = normaliseEmail(input.email);
    const role = V.oneOf(input.role, ROLES, 'role');
    let access;
    try { access = normaliseAccess(role, input.access); } catch (e) { throw invalid(e.message, 'access'); }
    const problem = passwordProblem(input.password, { username, name });
    if (problem) throw invalid(problem, 'password');
    const mustChange = V.bool(input.mustChange, 'mustChange', true);
    const hash = await hashPassword(input.password);
    const now = Date.now();
    const id = newId();
    try {
      db.prepare(`INSERT INTO users(id, username, name, phone, email, role, access, password_hash, must_change, active, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(id, username, name, phone, email, role, JSON.stringify(access), hash, mustChange ? 1 : 0, now, now);
    } catch (e) {
      if (String(e.message).includes('users.email')) throw conflict('email_taken', 'That email is already used by another account.');
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw conflict('username_taken', 'That username is already in use.');
      throw e;
    }
    logger.info('user.created', { userId: id, role });
    return findById(id);
  }

  /** Admin edit of profile, role, access and active flag. `actor` is the admin making the change. */
  function update(id, input, actor) {
    V.obj(input);
    const row = byId.get(id);
    if (!row) throw notFound('User not found.');
    const next = {
      name: row.name, phone: row.phone, email: row.email || '', role: row.role, active: !!row.active,
      access: parseStoredAccess(row.role, row.access),
    };
    if ('name' in input) next.name = V.str(input.name, 'name', { min: 1, max: 80 });
    if ('phone' in input) next.phone = V.str(input.phone, 'phone', { max: 30 });
    if ('email' in input) next.email = normaliseEmail(input.email);
    if ('active' in input) next.active = V.bool(input.active, 'active');
    const roleChanged = 'role' in input && input.role !== row.role;
    if ('role' in input) next.role = V.oneOf(input.role, ROLES, 'role');
    try {
      if ('access' in input) next.access = normaliseAccess(next.role, input.access);
      else if (roleChanged) next.access = normaliseAccess(next.role, undefined);
      else next.access = normaliseAccess(next.role, next.access);
    } catch (e) { throw invalid(e.message, 'access'); }

    if (id === actor.id && (roleChanged || next.active === false)) {
      throw conflict('self_change', 'You cannot change your own role or deactivate yourself.');
    }
    const result = db.transaction(() => {
      const leavingAdmin = row.role === 'admin' && row.active && (next.role !== 'admin' || !next.active);
      if (leavingAdmin && activeAdmins.get(id).n === 0) throw conflict('last_admin', 'At least one active administrator is required.');
      try {
        db.prepare('UPDATE users SET name=?, phone=?, email=?, role=?, access=?, active=?, updated_at=? WHERE id=?')
          .run(next.name, next.phone, next.email, next.role, JSON.stringify(next.access), next.active ? 1 : 0, Date.now(), id);
      } catch (e) {
        if (String(e.message).includes('users.email')) throw conflict('email_taken', 'That email is already used by another account.');
        throw e;
      }
      return findById(id);
    })();
    if (!next.active) sessions.destroyAllForUser(id);
    logger.info('user.updated', { userId: id, by: actor.id });
    return result;
  }

  async function setPassword(id, password, { mustChange = true, actor } = {}) {
    const row = byId.get(id);
    if (!row) throw notFound('User not found.');
    const problem = passwordProblem(password, { username: row.username, name: row.name });
    if (problem) throw invalid(problem, 'password');
    const hash = await hashPassword(password);
    db.prepare('UPDATE users SET password_hash=?, must_change=?, updated_at=? WHERE id=?').run(hash, mustChange ? 1 : 0, Date.now(), id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(id);
    sessions.destroyAllForUser(id);
    logger.info('user.password_reset', { userId: id, by: actor && actor.id });
  }

  function remove(id, actor) {
    const row = byId.get(id);
    if (!row) throw notFound('User not found.');
    if (id === actor.id) throw conflict('self_change', 'You cannot delete your own account.');
    db.transaction(() => {
      if (row.role === 'admin' && row.active && activeAdmins.get(id).n === 0) {
        throw conflict('last_admin', 'At least one active administrator is required.');
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    })();
    logger.info('user.deleted', { userId: id, by: actor.id });
  }

  /** Create the first administrator when the database has no users. */
  async function ensureBootstrapAdmin(config) {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
    if (n > 0) return null;
    let password = config.admin.password;
    let generated = false;
    if (!password) { password = require('../security').generatePassword(16); generated = true; }
    const problem = passwordProblem(password, { username: config.admin.username });
    if (problem) throw new Error(`ADMIN_PASSWORD rejected: ${problem}`);
    const user = await create({
      username: config.admin.username, name: config.admin.name, role: 'admin', password, mustChange: generated,
    });
    if (generated) {
      // Printed once, on first start only. Change it immediately after signing in.
      process.stdout.write(`\n==== Rode first-run administrator ====\n  username: ${user.username}\n  password: ${password}\n  (you will be asked to change it at first sign-in)\n=======================================\n\n`);
    } else {
      logger.info('bootstrap.admin_created', { username: user.username });
    }
    return user;
  }

  return { create, update, setPassword, remove, list, findById, findRowByUsername, findRowByIdentifier, recipientFor, ensureBootstrapAdmin, rowToUser, normaliseUsername };
}

module.exports = { createUsersService, rowToUser, USERNAME_RE };
