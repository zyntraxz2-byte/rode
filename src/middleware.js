'use strict';
const crypto = require('node:crypto');
const { HttpError, unauthorized, forbidden } = require('./errors');
const { isAdmin } = require('./permissions');

const COOKIE = 'rode_sid';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return out;
}

function requestContext(logger) {
  return (req, res, next) => {
    req.id = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', req.id);
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (req.path === '/healthz' && res.statusCode < 400) return;
      logger.info('http', {
        id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms * 10) / 10,
        user: req.user ? req.user.id : undefined, ip: req.ip,
      });
    });
    next();
  };
}

/**
 * CSRF defence for cookie auth: state-changing API calls must carry a custom header (which browsers will not
 * attach to cross-site form posts and which triggers a CORS preflight we never approve), and any Origin /
 * Sec-Fetch-Site metadata must say same-origin. SameSite=Lax on the cookie is the second layer.
 */
function csrfGuard(config) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'rode') return next(new HttpError(403, 'csrf', 'Missing request header.'));
    const site = req.get('sec-fetch-site');
    if (site && !['same-origin', 'none'].includes(site)) return next(new HttpError(403, 'csrf', 'Cross-site request blocked.'));
    const origin = req.get('origin');
    if (origin && origin !== 'null') {
      let host;
      try { host = new URL(origin).host; } catch { return next(new HttpError(403, 'csrf', 'Bad origin.')); }
      if (host !== req.get('host') && !config.allowedOrigins.includes(origin)) return next(new HttpError(403, 'csrf', 'Cross-origin request blocked.'));
    }
    next();
  };
}

function cookieOptions(config, req, maxAgeSeconds) {
  const secure = config.cookieSecure === 'true' ? true : config.cookieSecure === 'false' ? false : req.secure;
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: maxAgeSeconds * 1000 };
}

/** Attach req.user / req.sessionHash when a valid session cookie is present (does not reject). */
function sessionLoader(services) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const found = services.sessions.resolve(token);
    if (found) { req.user = found.user; req.sessionHash = found.hash; req.sessionToken = token; }
    next();
  };
}

const requireAuth = (req, res, next) => (req.user ? next() : next(unauthorized()));

/** Users flagged must_change may only reach the endpoints needed to change their password. */
function passwordGate(allowedPaths) {
  return (req, res, next) => {
    if (req.user && req.user.mustChange && !allowedPaths.includes(req.path)) {
      return next(new HttpError(403, 'password_change_required', 'Change your password to continue.'));
    }
    next();
  };
}

const requireAdmin = (req, res, next) => (req.user && isAdmin(req.user) ? next() : next(forbidden('Administrators only.')));

/** Per-key request budget (in-memory). */
function rateLimit(limiter, keyFn, message = 'Too many requests. Wait a moment and try again.') {
  return (req, res, next) => {
    const key = keyFn(req);
    const wait = limiter.blockedFor(key);
    if (wait > 0) { res.setHeader('Retry-After', String(wait)); return next(new HttpError(429, 'rate_limited', message)); }
    limiter.hit(key);
    next();
  };
}

function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    let status = 500;
    let body = { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' };
    if (err instanceof HttpError) {
      status = err.status;
      body = { code: err.code, message: err.message, ...(err.extra || {}) };
    } else if (err && err.type === 'entity.too.large') {
      status = 413; body = { code: 'too_large', message: 'That request is too large.' };
    } else if (err && err.type === 'entity.parse.failed') {
      status = 400; body = { code: 'bad_json', message: 'The request was not valid JSON.' };
    } else if (err && err.status >= 400 && err.status < 500) {
      status = err.status; body = { code: 'bad_request', message: 'Bad request.' };
    } else {
      logger.error('unhandled', { id: req.id, path: req.path, err: err && err.stack ? err.stack : String(err) });
    }
    res.status(status).json({ error: body });
  };
}

module.exports = {
  COOKIE, wrap, parseCookies, requestContext, csrfGuard, cookieOptions, sessionLoader, requireAuth, passwordGate,
  requireAdmin, rateLimit, errorHandler,
};
