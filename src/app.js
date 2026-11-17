'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { createServices } = require('./services');
const { notFound, forbidden, unauthorized } = require('./errors');
const { getRev } = require('./db');
const { AttemptLimiter } = require('./security');
const mw = require('./middleware');
const { authRoutes } = require('./routes/auth');
const { dataRoutes } = require('./routes/data');
const { userRoutes } = require('./routes/users');

/** Build the Express app. Pure factory (no listening) so tests can run it in-process. */
function createApp({ config, db, logger, fetchImpl, mailTransport }) {
  const services = createServices({ db, config, logger, fetchImpl, mailTransport });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', 'strong');

  app.use(mw.requestContext(logger));
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // inline style attributes are used for chart bars
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    strictTransportSecurity: config.hsts ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'same-origin' },
  }));

  app.use((req, res, next) => { // microphone is used by Quick book's voice input; everything else stays off
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/readyz', (req, res) => {
    try { res.json({ ok: true, rev: getRev(db) }); } catch { res.status(503).json({ ok: false }); }
  });

  // Static frontend. Shell and scripts revalidate on each load so deployments take effect immediately.
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: 'index.html', etag: true, lastModified: true, dotfiles: 'ignore',
    setHeaders: (res, file) => {
      res.setHeader('Cache-Control', 'no-cache');
      if (file.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
      if (file.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    },
  }));

  const ipBudget = new AttemptLimiter({ max: 1500, windowMs: 60 * 1000 });
  setInterval(() => ipBudget.sweep(), 5 * 60 * 1000).unref();
  const gate = mw.passwordGate(['/auth/me', '/auth/password', '/auth/logout']);

  // Authenticated photo downloads (same access rules as the booking they belong to).
  app.get('/_blob/:id', mw.sessionLoader(services), (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.mustChange) return next(forbidden('Change your password to continue.'));
    const { file, mime } = services.assets.openForView(req.user, req.params.id);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    return res.sendFile(file, { dotfiles: 'allow', headers: { 'Content-Type': mime } }, (err) => { if (err && !res.headersSent) next(notFound()); });
  });

  const api = express.Router();
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  api.use(mw.rateLimit(ipBudget, (req) => `api:${req.ip}`));
  api.use(mw.csrfGuard(config));
  api.use(express.json({ limit: '100kb' }));
  api.use(express.raw({ type: ['image/*', 'application/octet-stream'], limit: config.maxUploadBytes }));
  api.use(mw.sessionLoader(services));
  api.use('/auth', authRoutes({ config, db, services }));
  api.use(mw.requireAuth);
  api.use(gate);
  api.use('/users', mw.requireAdmin, userRoutes({ services }));
  api.use(dataRoutes({ db, services }));
  api.use((req, res, next) => next(notFound('Unknown endpoint.')));
  app.use('/api', api);

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  app.use(mw.errorHandler(logger));
  return { app, services };
}

module.exports = { createApp };
