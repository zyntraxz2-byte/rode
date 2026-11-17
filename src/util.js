'use strict';
const crypto = require('node:crypto');

/** 12-char url-safe random id (72 bits). */
const newId = () => crypto.randomBytes(9).toString('base64url');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);

/** "YYYY-MM-DD" for now in an IANA timezone. */
function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
/** Minutes since midnight for now in an IANA timezone. */
function minutesNowIn(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** Constant-time string compare. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const toMinor = (major) => Math.round(Number(major) * 100);
const fromMinor = (minor) => minor / 100;

module.exports = { newId, isId, todayIn, minutesNowIn, addDays, toMin, safeEqual, toMinor, fromMinor };
