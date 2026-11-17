'use strict';
const express = require('express');
const { wrap } = require('../middleware');
const { ROLES, PRESETS, ALLOWED, ROLE_LABELS, SECTIONS } = require('../permissions');

function userRoutes({ services }) {
  const r = express.Router();

  r.get('/', (req, res) => {
    res.json({
      users: services.users.list(),
      meta: {
        sections: SECTIONS,
        roles: ROLES.map((id) => ({ id, label: ROLE_LABELS[id], preset: PRESETS[id], allowed: ALLOWED[id] })),
      },
    });
  });

  r.post('/', wrap(async (req, res) => res.status(201).json({ user: await services.users.create(req.body) })));
  r.patch('/:id', (req, res) => res.json({ user: services.users.update(req.params.id, req.body, req.user) }));
  r.post('/:id/password', wrap(async (req, res) => {
    const body = req.body || {};
    await services.users.setPassword(req.params.id, body.password, { mustChange: body.mustChange !== false, actor: req.user });
    res.status(204).end();
  }));
  r.delete('/:id', (req, res) => { services.users.remove(req.params.id, req.user); res.status(204).end(); });
  return r;
}

module.exports = { userRoutes };
