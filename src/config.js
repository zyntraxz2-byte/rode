'use strict';
const path = require('node:path');

function int(name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: expected integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function trustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw); // number of proxy hops
  return raw; // e.g. "loopback" or a CIDR list
}

/** Build the config from an env-like object lookups at call time so tests can override process.env. */
function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    env: env.NODE_ENV || 'development',
    host: env.HOST || '0.0.0.0',
    port: int('PORT', 3000, { min: 0, max: 65535 }),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    trustProxy: trustProxy(),
    // 'auto' sets the Secure flag when the request arrived over HTTPS (needs TRUST_PROXY behind a proxy)
    cookieSecure: (env.COOKIE_SECURE || 'auto').toLowerCase(),
    sessionIdleHours: int('SESSION_IDLE_HOURS', 24 * 7, { min: 1, max: 24 * 90 }),
    sessionMaxDays: int('SESSION_MAX_DAYS', 30, { min: 1, max: 365 }),
    timezone: env.APP_TIMEZONE || 'Asia/Colombo',
    defaultCurrency: (env.DEFAULT_CURRENCY || 'LKR').toUpperCase(),
    maxUploadBytes: int('MAX_UPLOAD_MB', 8, { min: 1, max: 50 }) * 1024 * 1024,
    admin: {
      username: (env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
      name: env.ADMIN_NAME || 'Administrator',
      password: env.ADMIN_PASSWORD || '',
    },
    login: {
      maxFailures: int('LOGIN_MAX_FAILURES', 8, { min: 1 }),
      windowMinutes: int('LOGIN_WINDOW_MINUTES', 15, { min: 1 }),
      ipMaxAttempts: int('LOGIN_IP_MAX_ATTEMPTS', 40, { min: 1 }),
    },
    customer: {
      maxActiveBookings: int('CUSTOMER_MAX_ACTIVE_BOOKINGS', 20, { min: 1 }),
    },
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    },
    // Public base URL used in emailed links (never taken from the request Host header).
    publicUrl: (env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    mail: {
      host: env.SMTP_HOST || '',
      port: int('SMTP_PORT', 587, { min: 1, max: 65535 }),
      secure: bool('SMTP_SECURE', false), // true = implicit TLS (usually port 465); false = STARTTLS when offered
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || '',
      resetMinutes: int('RESET_TOKEN_MINUTES', 60, { min: 5, max: 24 * 60 }),
    },
    logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
    hsts: bool('ENABLE_HSTS', false),
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
  const merged = { ...cfg, ...overrides };
  for (const k of ['admin', 'login', 'customer', 'anthropic', 'mail']) merged[k] = { ...cfg[k], ...(overrides[k] || {}) };
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: merged.timezone });
  } catch {
    throw new Error(`Invalid APP_TIMEZONE: ${merged.timezone}`);
  }
  if (merged.publicUrl) {
    let u;
    try { u = new URL(merged.publicUrl); } catch { throw new Error(`Invalid PUBLIC_URL: ${merged.publicUrl}`); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('PUBLIC_URL must start with http:// or https://');
  }
  if (merged.env === 'production' && merged.mail.host && !merged.publicUrl) {
    throw new Error('PUBLIC_URL is required in production when SMTP_HOST is set (it is used for the links in password-reset emails).');
  }
  if (merged.mail.host && !merged.mail.from) throw new Error('MAIL_FROM is required when SMTP_HOST is set.');
  return merged;
}

module.exports = { loadConfig };
