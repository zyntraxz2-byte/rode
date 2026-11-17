'use strict';
const express = require('express');
const V = require('../validate');
const { HttpError, invalid, unauthorized } = require('../errors');
const { verifyPassword, dummyVerify, hashPassword, passwordProblem, AttemptLimiter } = require('../security');
const { wrap, COOKIE, cookieOptions, requireAuth } = require('../middleware');
const { ROLE_LABELS } = require('../permissions');

function meView(user, services) {
  return {
    user: {
      id: user.id, username: user.username, name: user.name, phone: user.phone, role: user.role,
      roleLabel: ROLE_LABELS[user.role], access: user.access, mustChange: user.mustChange, updatedAt: user.updatedAt,
    },
    features: { quickBook: services.quickbook.enabled() },
  };
}

function authRoutes({ config, db, services }) {
  const router = express.Router();
  const windowMs = config.login.windowMinutes * 60 * 1000;
  const ipLimiter = new AttemptLimiter({ max: config.login.ipMaxAttempts, windowMs });
  const pairLimiter = new AttemptLimiter({ max: config.login.maxFailures, windowMs });
  const pwLimiter = new AttemptLimiter({ max: 8, windowMs });
  const timer = setInterval(() => { ipLimiter.sweep(); pairLimiter.sweep(); pwLimiter.sweep(); }, 10 * 60 * 1000);
  timer.unref();

  router.post('/login', wrap(async (req, res) => {
    const body = V.obj(req.body);
    if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > 1024) {
      throw invalid('Enter your username and password.');
    }
    const username = body.username.trim().toLowerCase().slice(0, 64);
    const ipKey = `ip:${req.ip}`;
    const pairKey = `u:${req.ip}:${username}`;
    const wait = Math.max(ipLimiter.blockedFor(ipKey), pairLimiter.blockedFor(pairKey));
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      throw new HttpError(429, 'too_many_attempts', `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`);
    }
    const row = services.users.findRowByUsername(username);
    const ok = row ? await verifyPassword(body.password, row.password_hash) : await dummyVerify(body.password);
    if (!row || !row.active || !ok) {
      ipLimiter.hit(ipKey); pairLimiter.hit(pairKey);
      throw unauthorized('Incorrect username or password.', 'invalid_credentials');
    }
    pairLimiter.reset(pairKey);
    const token = services.sessions.create(row.id, { ip: req.ip, userAgent: req.get('user-agent') });
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), row.id);
    res.cookie(COOKIE, token, cookieOptions(config, req, services.sessions.maxAgeSeconds));
    res.json(meView(services.users.findById(row.id), services));
  }));

  // --- emailed password reset (public) ---
  const forgotIpLimiter = new AttemptLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
  const forgotIdLimiter = new AttemptLimiter({ max: 3, windowMs: 60 * 60 * 1000 });
  const resetLimiter = new AttemptLimiter({ max: 20, windowMs: 15 * 60 * 1000 });
  const t2 = setInterval(() => { forgotIpLimiter.sweep(); forgotIdLimiter.sweep(); resetLimiter.sweep(); services.passwordReset.sweep(); }, 10 * 60 * 1000);
  t2.unref();

  router.get('/options', (req, res) => {
    const m = services.mailer;
    res.json({ passwordReset: m.enabled() || m.devFallback() });
  });

  router.post('/forgot', wrap(async (req, res) => {
    const body = V.obj(req.body);
    if (typeof body.identifier !== 'string' || !body.identifier.trim() || body.identifier.length > 128) {
      throw invalid('Enter your username or email.', 'identifier');
    }
    const id = body.identifier.trim().toLowerCase();
    const ipKey = `f:${req.ip}`, idKey = `fid:${id}`;
    if (forgotIpLimiter.blockedFor(ipKey) > 0) throw new HttpError(429, 'too_many_attempts', 'Too many requests. Try again later.');
    forgotIpLimiter.hit(ipKey);
    // Per-account cap stops mail-bombing a victim; it silently skips so nothing is revealed.
    if (forgotIdLimiter.blockedFor(idKey) === 0) {
      forgotIdLimiter.hit(idKey);
      services.passwordReset.request(id);
    }
    res.status(202).json({ ok: true });
  }));

  router.post('/reset', wrap(async (req, res) => {
    const body = V.obj(req.body);
    const key = `r:${req.ip}`;
    if (resetLimiter.blockedFor(key) > 0) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again later.');
    if (typeof body.token !== 'string' || typeof body.password !== 'string') throw invalid('Enter a new password.', 'password');
    try {
      await services.passwordReset.complete(body.token, body.password);
    } catch (e) {
      if (e.extra && e.extra.field === 'token') resetLimiter.hit(key); // only bad tokens count
      throw e;
    }
    res.status(204).end();
  }));

  router.post('/logout', (req, res) => {
    services.sessions.destroy(req.sessionToken);
    res.clearCookie(COOKIE, { path: '/' });
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => res.json(meView(req.user, services)));

  router.post('/password', requireAuth, wrap(async (req, res) => {
    const body = V.obj(req.body);
    const key = `pw:${req.user.id}`;
    const wait = pwLimiter.blockedFor(key);
    if (wait > 0) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again later.');
    if (typeof body.current !== 'string' || typeof body.next !== 'string') throw invalid('Enter your current and new password.');
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(body.current, row.password_hash))) {
      pwLimiter.hit(key);
      throw new HttpError(403, 'wrong_password', 'Your current password is not correct.');
    }
    pwLimiter.reset(key);
    if (body.next === body.current) throw invalid('Choose a password you have not used just now.', 'next');
    const problem = passwordProblem(body.next, { username: row.username, name: row.name });
    if (problem) throw invalid(problem, 'next');
    const hash = await hashPassword(body.next);
    db.prepare('UPDATE users SET password_hash = ?, must_change = 0, updated_at = ? WHERE id = ?').run(hash, Date.now(), row.id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.id); // outstanding reset links die with the old password
    services.sessions.destroyAllForUser(row.id, req.sessionHash); // sign out every other device
    res.json(meView(services.users.findById(row.id), services));
  }));

  return router;
}

module.exports = { authRoutes, meView };
