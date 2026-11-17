'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, futureDate } = require('./helpers');
const { todayIn } = require('../src/util');

test('PWA files are served with the right types and the CSP allows them', async () => {
  const t = await boot();
  try {
    const m = await fetch(t.base + '/manifest.webmanifest');
    assert.equal(m.status, 200);
    assert.match(m.headers.get('content-type'), /manifest\+json/);
    const manifest = await m.json();
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) assert.equal((await fetch(t.base + icon.src)).status, 200, icon.src);

    const sw = await fetch(t.base + '/sw.js');
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.equal(sw.headers.get('cache-control'), 'no-cache');
    const csp = sw.headers.get('content-security-policy');
    assert.match(csp, /manifest-src 'self'/);
    assert.match(csp, /worker-src 'self'/);
    assert.match(sw.headers.get('permissions-policy'), /microphone=\(self\)/);
    assert.equal((await fetch(t.base + '/offline.html')).status, 200);
  } finally { await t.close(); }
});

test('service worker never caches private routes', async () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(src, /startsWith\('\/api\/'\)/);
  assert.match(src, /startsWith\('\/_blob\/'\)/);
});

test('customers cannot cancel a booking that is already in the past', async () => {
  const t = await boot();
  try {
    const admin = await t.adminClient();
    const cust = await t.makeUser(admin, { username: 'kamal', role: 'customer' });
    const svc = (await cust.client.get('/api/state')).data.settings.services[0];
    const made = await cust.client.post('/api/appts', { serviceId: svc.id, date: futureDate(3), time: '10:00' });
    assert.equal(made.status, 201);
    // age the booking into the past directly (customers cannot book past times via the API)
    t.db.prepare('UPDATE appts SET date = ? WHERE id = ?').run('2020-01-01', made.data.appt.id);
    const r = await cust.client.post(`/api/appts/${made.data.appt.id}/status`, { status: 'cancelled' });
    assert.equal(r.status, 403);
    t.db.prepare('UPDATE appts SET date = ? WHERE id = ?').run(todayIn(t.config.timezone, new Date(Date.now() + 86400000 * 2)), made.data.appt.id);
    assert.equal((await cust.client.post(`/api/appts/${made.data.appt.id}/status`, { status: 'cancelled' })).status, 200);
  } finally { await t.close(); }
});

test('production config refuses SMTP without PUBLIC_URL', () => {
  const { loadConfig } = require('../src/config');
  assert.throws(() => loadConfig({ env: 'production', mail: { host: 'smtp.example.com', from: 'a@b.co' } }), /PUBLIC_URL/);
  assert.doesNotThrow(() => loadConfig({ env: 'production', publicUrl: 'https://rode.example', mail: { host: 'smtp.example.com', from: 'a@b.co' } }));
});
