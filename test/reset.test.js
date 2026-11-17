'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, ADMIN_PW } = require('./helpers');

function mailbox() {
  const sent = [];
  return { sent, sendMail: async (m) => { sent.push(m); return {}; } };
}
const tokenOf = (m) => /#reset=([\w-]+)/.exec(m.text)[1];
const tick = () => new Promise((r) => setTimeout(r, 30));

async function setup(extra = {}) {
  const box = mailbox();
  const t = await boot({ publicUrl: 'https://rode.example', ...extra }, { mailTransport: box });
  const admin = await t.adminClient();
  const made = await t.makeUser(admin, { username: 'nimali', role: 'staff' });
  await admin.patch('/api/users/' + made.user.id, { email: 'Nimali@Example.com' });
  return { t, box, admin, made };
}

test('forgot password mails a single-use link; reset signs out all sessions', async () => {
  const { t, box, made } = await setup({ mail: { host: 'x', from: 'Rode <no-reply@rode.example>' } });
  try {
    const anon = t.client();
    assert.equal((await anon.get('/api/auth/options')).data.passwordReset, true);
    const r = await anon.post('/api/auth/forgot', { identifier: 'nimali' });
    assert.equal(r.status, 202);
    await tick();
    assert.equal(box.sent.length, 1);
    assert.equal(box.sent[0].to, 'nimali@example.com');
    assert.match(box.sent[0].text, /^.*https:\/\/rode\.example\/#reset=/m);
    const token = tokenOf(box.sent[0]);

    const weak = await anon.post('/api/auth/reset', { token, password: 'short' });
    assert.equal(weak.status, 422);

    const ok = await anon.post('/api/auth/reset', { token, password: 'Brand-New-Passw0rd!' });
    assert.equal(ok.status, 204);
    assert.equal((await made.client.get('/api/auth/me')).status, 401, 'old session is revoked');
    assert.equal((await t.client().login('nimali', made.password)).status, 401);
    assert.equal((await t.client().login('nimali', 'Brand-New-Passw0rd!')).status, 200);

    const again = await anon.post('/api/auth/reset', { token, password: 'Another-Passw0rd!!' });
    assert.equal(again.status, 422, 'a link works once');
  } finally { await t.close(); }
});

test('forgot works by email, never reveals unknown accounts, and a newer link replaces the older one', async () => {
  const { t, box } = await setup();
  try {
    const anon = t.client();
    const unknown = await anon.post('/api/auth/forgot', { identifier: 'nobody@example.com' });
    assert.equal(unknown.status, 202);
    await tick();
    assert.equal(box.sent.length, 0);

    await anon.post('/api/auth/forgot', { identifier: 'NIMALI@example.com' });
    await tick();
    assert.equal(box.sent.length, 1);
    const first = tokenOf(box.sent[0]);

    t.services.passwordReset.request('nimali'); // second request (per-account cap is in the route, not the service)
    await tick();
    const second = tokenOf(box.sent[1]);
    assert.equal((await anon.post('/api/auth/reset', { token: first, password: 'Brand-New-Passw0rd!' })).status, 422);
    assert.equal((await anon.post('/api/auth/reset', { token: second, password: 'Brand-New-Passw0rd!' })).status, 204);
  } finally { await t.close(); }
});

test('expired and bogus tokens are rejected; inactive accounts get no mail; admin reset voids links', async () => {
  const { t, box, admin, made } = await setup();
  try {
    const anon = t.client();
    await anon.post('/api/auth/forgot', { identifier: 'nimali' });
    await tick();
    const token = tokenOf(box.sent[0]);

    t.db.prepare('UPDATE password_resets SET expires_at = ?').run(Date.now() - 1000);
    assert.equal((await anon.post('/api/auth/reset', { token, password: 'Brand-New-Passw0rd!' })).status, 422);
    assert.equal((await anon.post('/api/auth/reset', { token: 'x'.repeat(43), password: 'Brand-New-Passw0rd!' })).status, 422);

    await anon.post('/api/auth/forgot', { identifier: 'nimali' });
    await tick();
    const t2 = tokenOf(box.sent[1]);
    await admin.post('/api/users/' + made.user.id + '/password', { password: 'Admin-Set-Passw0rd!' });
    assert.equal((await anon.post('/api/auth/reset', { token: t2, password: 'Brand-New-Passw0rd!' })).status, 422);

    await admin.patch('/api/users/' + made.user.id, { active: false });
    await anon.post('/api/auth/forgot', { identifier: 'nimali' });
    await tick();
    assert.equal(box.sent.length, 2);
  } finally { await t.close(); }
});

test('username that is an email works as the recipient; email must be unique and valid', async () => {
  const { t, box, admin, made } = await setup();
  try {
    const u = await admin.post('/api/users', { username: 'sam@example.com', name: 'Sam', role: 'customer', password: 'Str0ng-Passw0rd!' });
    assert.equal(u.status, 201);
    await t.client().post('/api/auth/forgot', { identifier: 'sam@example.com' });
    await tick();
    assert.equal(box.sent[0].to, 'sam@example.com');

    const dup = await admin.patch('/api/users/' + u.data.user.id, { email: 'nimali@example.com' });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error.code, 'email_taken');
    assert.equal((await admin.patch('/api/users/' + made.user.id, { email: 'not-an-email' })).status, 422);
  } finally { await t.close(); }
});

test('forgot is rate limited per account without revealing it', async () => {
  const { t, box } = await setup();
  try {
    const anon = t.client();
    for (let i = 0; i < 5; i++) assert.equal((await anon.post('/api/auth/forgot', { identifier: 'nimali' })).status, 202);
    await tick();
    assert.equal(box.sent.length, 3);
  } finally { await t.close(); }
});

test('without SMTP in production the feature reports itself off', async () => {
  const t = await boot({ env: 'production' });
  try {
    assert.equal((await t.client().get('/api/auth/options')).data.passwordReset, false);
  } finally { await t.close(); }
});

void ADMIN_PW;
