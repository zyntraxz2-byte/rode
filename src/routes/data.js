'use strict';
const express = require('express');
const { wrap, rateLimit } = require('../middleware');
const { getRev } = require('../db');
const { perms } = require('../permissions');
const { forbidden } = require('../errors');
const { AttemptLimiter } = require('../security');

function dataRoutes({ db, services }) {
  const r = express.Router();
  const quickLimiter = new AttemptLimiter({ max: 15, windowMs: 60 * 1000 });
  const uploadLimiter = new AttemptLimiter({ max: 40, windowMs: 60 * 1000 });
  setInterval(() => { quickLimiter.sweep(); uploadLimiter.sweep(); }, 5 * 60 * 1000).unref();

  r.get('/sync', (req, res) => res.json({ rev: getRev(db), uv: req.user.updatedAt }));

  r.get('/state', (req, res) => {
    const cfg = services.settings.get();
    res.json({
      rev: getRev(db),
      settings: perms.canSeeFullSettings(req.user) ? cfg : services.settings.publicView(cfg),
      txns: services.txns.list(req.user),
      appts: services.appts.list(req.user),
    });
  });

  // transactions
  r.post('/txns', (req, res) => res.status(201).json({ txn: services.txns.create(req.user, req.body) }));
  r.delete('/txns/:id', (req, res) => { services.txns.remove(req.user, req.params.id); res.status(204).end(); });

  // appointments
  r.post('/appts', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    res.status(201).json({ appt: services.appts.create(req.user, body, { force: body.force === true }) });
  });
  r.post('/appts/:id/status', (req, res) => {
    const body = req.body || {};
    res.json({ appt: services.appts.setStatus(req.user, req.params.id, body.status, { force: body.force === true }) });
  });
  r.post('/appts/:id/pay', (req, res) => res.json({ appt: services.appts.pay(req.user, req.params.id, (req.body || {}).method) }));
  r.post('/appts/:id/undo-pay', (req, res) => res.json({ appt: services.appts.undoPay(req.user, req.params.id) }));
  r.delete('/appts/:id', (req, res) => { services.appts.remove(req.user, req.params.id); res.status(204).end(); });
  r.post('/appts/:id/inspo', (req, res) => res.json({ inspo: services.appts.attachInspo(req.user, req.params.id, (req.body || {}).assetIds) }));
  r.delete('/appts/:id/inspo/:assetId', (req, res) => { services.appts.removeInspo(req.user, req.params.id, req.params.assetId); res.status(204).end(); });

  // settings (partial update)
  r.patch('/settings', (req, res) => {
    if (!perms.canWrite(req.user, 'setup')) throw forbidden('You cannot change setup.');
    res.json({ settings: services.settings.patch(req.body) });
  });

  // sample data
  r.post('/sample', (req, res) => { services.sample.load(req.user); res.status(204).end(); });
  r.delete('/sample', (req, res) => { services.sample.clear(req.user); res.status(204).end(); });

  // quick book (optional, needs ANTHROPIC_API_KEY)
  r.post('/quick-parse', rateLimit(quickLimiter, (req) => `q:${req.user.id}`), wrap(async (req, res) => {
    if (!perms.canWrite(req.user, 'book')) throw forbidden('You cannot make bookings.');
    res.json({ parsed: await services.quickbook.parse((req.body || {}).text) });
  }));

  // photo uploads: raw image bytes in the body
  r.post('/assets', rateLimit(uploadLimiter, (req) => `up:${req.user.id}`), (req, res) => {
    res.status(201).json(services.assets.save(req.user, req.body));
  });
  r.delete('/assets/:id', (req, res) => { services.assets.discard(req.user, req.params.id); res.status(204).end(); });

  return r;
}

module.exports = { dataRoutes };
