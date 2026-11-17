'use strict';

/**
 * Access model
 * ------------
 * Every user has a role (a label with a preset) plus a per-section access level that an admin can tune.
 *
 *   none  no access
 *   own   only records the user created themselves (customers)
 *   read  see everything in the section
 *   write read + create/change/delete
 *
 * Admins are fixed at full access and are the only ones who can manage users.
 */
const SECTIONS = ['overview', 'book', 'inspo', 'money', 'setup'];
const ROLES = ['admin', 'staff', 'viewer', 'customer'];
const RANK = { none: 0, own: 1, read: 2, write: 3 };

const PRESETS = {
  admin: { overview: 'read', book: 'write', inspo: 'write', money: 'write', setup: 'write' },
  staff: { overview: 'read', book: 'write', inspo: 'write', money: 'write', setup: 'read' },
  viewer: { overview: 'read', book: 'read', inspo: 'read', money: 'read', setup: 'read' },
  customer: { overview: 'none', book: 'own', inspo: 'own', money: 'none', setup: 'none' },
};

/** Levels an admin may assign per role and section. */
const ALLOWED = {
  admin: Object.fromEntries(SECTIONS.map((s) => [s, [PRESETS.admin[s]]])),
  staff: {
    overview: ['none', 'read'],
    book: ['none', 'read', 'write'],
    inspo: ['none', 'read', 'write'],
    money: ['none', 'read', 'write'],
    setup: ['none', 'read', 'write'],
  },
  viewer: {
    overview: ['none', 'read'],
    book: ['none', 'read'],
    inspo: ['none', 'read'],
    money: ['none', 'read'],
    setup: ['none', 'read'],
  },
  customer: {
    overview: ['none'],
    book: ['none', 'own'],
    inspo: ['none', 'own'],
    money: ['none'],
    setup: ['none'],
  },
};

const ROLE_LABELS = { admin: 'Administrator', staff: 'Team member', viewer: 'View only', customer: 'Customer' };

/** Validate an access map for a role; returns the normalised map or throws a string reason. */
function normaliseAccess(role, access) {
  if (!ROLES.includes(role)) throw new Error('Unknown role.');
  if (role === 'admin') return { ...PRESETS.admin };
  if (access === undefined || access === null) return { ...PRESETS[role] };
  if (typeof access !== 'object' || Array.isArray(access)) throw new Error('access must be an object.');
  const out = { ...PRESETS[role] };
  for (const key of Object.keys(access)) {
    if (!SECTIONS.includes(key)) throw new Error(`Unknown section "${key}".`);
    const level = access[key];
    if (!ALLOWED[role][key].includes(level)) {
      throw new Error(`"${level}" is not allowed for ${key} on a ${ROLE_LABELS[role]} account.`);
    }
    out[key] = level;
  }
  return out;
}

/** Defensive parse of the stored access JSON, re-clamped to the role's allowed levels. */
function parseStoredAccess(role, json) {
  let raw;
  try { raw = JSON.parse(json); } catch { raw = null; }
  try { return normaliseAccess(role, raw); } catch { return { ...PRESETS[role] }; }
}

const level = (user, section) => RANK[user.access[section]] ?? 0;
const isAdmin = (user) => user.role === 'admin';

const perms = {
  level,
  /** read or write on everything in the section */
  canRead: (u, s) => level(u, s) >= RANK.read,
  canWrite: (u, s) => level(u, s) >= RANK.write,
  isOwn: (u, s) => level(u, s) === RANK.own,
  /** section visible at all (own counts) */
  canSee: (u, s) => level(u, s) >= RANK.own,
  /** which appointments the user may list: 'all' | 'own' | 'none' */
  apptScope(u) {
    if (['overview', 'book', 'inspo'].some((s) => level(u, s) >= RANK.read)) return 'all';
    if (['book', 'inspo'].some((s) => level(u, s) === RANK.own)) return 'own';
    return 'none';
  },
  canSeeTxns: (u) => level(u, 'money') >= RANK.read || level(u, 'overview') >= RANK.read,
  /** opening balances and other private settings */
  canSeeFullSettings: (u) => ['setup', 'money', 'overview'].some((s) => level(u, s) >= RANK.read),
};

module.exports = { SECTIONS, ROLES, PRESETS, ALLOWED, ROLE_LABELS, RANK, normaliseAccess, parseStoredAccess, perms, isAdmin };
