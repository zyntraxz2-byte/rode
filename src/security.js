'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Hash a password with scrypt. Format: scrypt$N$r$p$salt$hash (base64). */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Burn the same CPU for unknown usernames so response time does not reveal which accounts exist.
let dummyHash;
async function dummyVerify(password) {
  dummyHash = dummyHash || (await hashPassword('dummy-password-for-timing'));
  await verifyPassword(password, dummyHash);
  return false;
}

const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678901', 'qwertyuiop', 'qwerty12345', 'letmein123',
  'welcome123', 'admin12345', 'iloveyou123', '0123456789', 'abcdefghij', 'changeme123', 'rode1234567', 'rode12345678',
]);

/** Returns an error message or null. */
function passwordProblem(password, { username = '', name = '' } = {}) {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < 10) return 'Password must be at least 10 characters.';
  if (password.length > 128) return 'Password must be at most 128 characters.';
  if (new Set(password).size < 5) return 'Password is too repetitive.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common.';
  if (username && lower.includes(String(username).toLowerCase()) && String(username).length >= 4) return 'Password must not contain the username.';
  if (name && name.length >= 4 && lower === name.toLowerCase()) return 'Password must not be the name.';
  return null;
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Generate a random, readable password (no look-alike characters) that satisfies the policy. */
function generatePassword(length = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  while (out.length < length) {
    const b = crypto.randomBytes(1)[0];
    if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length]; // rejection sampling: no modulo bias
  }
  return out;
}

/**
 * Fixed-window attempt limiter held in memory. Keys expire automatically.
 * Good enough for a single-process deployment; swap for Redis if you scale horizontally.
 */
class AttemptLimiter {
  constructor({ max, windowMs, now = Date.now }) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }
  _entry(key) {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= t) { e = { count: 0, reset: t + this.windowMs }; this.hits.set(key, e); }
    return e;
  }
  /** Seconds to wait if blocked, else 0. */
  blockedFor(key) {
    const e = this.hits.get(key);
    if (!e || e.reset <= this.now() || e.count < this.max) return 0;
    return Math.ceil((e.reset - this.now()) / 1000);
  }
  hit(key) { this._entry(key).count += 1; }
  reset(key) { this.hits.delete(key); }
  sweep() { const t = this.now(); for (const [k, e] of this.hits) if (e.reset <= t) this.hits.delete(k); }
}

module.exports = { hashPassword, verifyPassword, dummyVerify, passwordProblem, newToken, sha256, generatePassword, AttemptLimiter };
