'use strict';
const { invalid } = require('./errors');

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function obj(v, field = 'body') {
  if (!isPlainObject(v)) throw invalid('Expected a JSON object.', field);
  return v;
}
/** Trimmed string, control chars removed. */
function str(v, field, { min = 0, max = 200, required = false } = {}) {
  if (v === undefined || v === null) {
    if (required || min > 0) throw invalid(`${field} is required.`, field);
    return '';
  }
  if (typeof v !== 'string') throw invalid(`${field} must be text.`, field);
  const s = v.replace(CTRL, '').trim();
  if (s.length < min || (required && !s)) throw invalid(`${field} is required.`, field);
  if (s.length > max) throw invalid(`${field} must be at most ${max} characters.`, field);
  return s;
}
function oneOf(v, allowed, field) {
  if (!allowed.includes(v)) throw invalid(`${field} must be one of: ${allowed.join(', ')}.`, field);
  return v;
}
function bool(v, field, def) {
  if (v === undefined) return def;
  if (typeof v !== 'boolean') throw invalid(`${field} must be true or false.`, field);
  return v;
}
function date(v, field = 'date') {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw invalid(`${field} must be YYYY-MM-DD.`, field);
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2100 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw invalid(`${field} is not a valid date.`, field);
  }
  return v;
}
function time(v, field = 'time') {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw invalid(`${field} must be HH:MM (24h).`, field);
  return v;
}
/** Money in major units with at most 2 decimals. */
function money(v, field, { min = 0, max = 1e9, allowNegative = false } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${field} must be a number.`, field);
  const r = Math.round(v * 100) / 100;
  if (Math.abs(r * 100 - v * 100) > 1e-6) throw invalid(`${field} can have at most 2 decimal places.`, field);
  if (!allowNegative && r < min) throw invalid(`${field} must be at least ${min}.`, field);
  if (Math.abs(r) > max) throw invalid(`${field} is too large.`, field);
  return r;
}
function int(v, field, { min = 0, max = 1e9 } = {}) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw invalid(`${field} must be a whole number between ${min} and ${max}.`, field);
  }
  return v;
}

module.exports = { obj, str, oneOf, bool, date, time, money, int, isPlainObject };
