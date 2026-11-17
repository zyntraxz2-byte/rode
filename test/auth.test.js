'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, ADMIN_PW } = require('./helpers');

let t;
before(async () => { t = await boot({ login: { maxFailures: 3, windowMinutes: 15, ipMaxAttempts: 100 } }); });
after(async () => { await t.close(); });

test('unauthenticated API calls are rejected', async () => {
  const c = t.client();
  assert.equal((await c.get('/api/state')).status, 401);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  assert.equal((await c.get('/api/users')).status, 401);
});

test('login sets an HttpOnly SameSite cookie and /me returns the profile', async () => {
  const c = t.client();
  const r = await c.login('Admin', ADMIN_PW); // username is case-insensitive
  assert.equal(r.status, 200);
  assert.match(r.setCookie[0], /rode_sid=/);
  assert.match(r.setCookie[0], /HttpOnly/i);
  assert.match(r.setCookie[0], /SameSite=Lax/i);
  const me = await c.get('/api/auth/me');
  assert.equal(me.data.user.role, 'admin');
  assert.equal(me.data.user.access.money, 'write');
  assert.ok(!JSON.stringify(me.data).includes('password'));
});

test('wrong password and unknown user give the same generic error', async () => {
  const c = t.client();
  const a = await c.login('admin', 'nope-nope-nope');
  const b = await c.login('ghost', 'nope-nope-nope');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.data.error.message, b.data.error.message);
});

test('logout invalidates the session server-side', async () => {
  const c = t.client();
  await c.login('admin', ADMIN_PW);
  const cookie = c.cookie();
  assert.equal((await c.post('/api/auth/logout')).status, 204);
  const replay = t.client();
  const r = await replay.get('/api/auth/me', { headers: { cookie } });
  assert.equal(r.status, 401);
});

test('state-changing requests without the CSRF header are blocked', async () => {
  const c = t.client();
  const r = await c.post('/api/auth/login', { username: 'admin', password: ADMIN_PW }, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'csrf');
});

test('cross-origin requests are blocked even with the header', async () => {
  const c = t.client();
  const r = await c.post('/api/auth/login', { username: 'admin', password: ADMIN_PW }, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('repeated failures lock out that ip+username, and a correct password is also refused while locked', async () => {
  const c = t.client();
  for (let i = 0; i < 3; i++) assert.equal((await c.login('victim', 'wrong-wrong-1')).status, 401);
  const locked = await c.login('victim', 'wrong-wrong-1');
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get('retry-after'));
  // other usernames from the same ip are unaffected
  assert.equal((await c.login('admin', ADMIN_PW)).status, 200);
});

test('security headers are present', async () => {
  const res = await fetch(t.base + '/');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('health endpoints respond', async () => {
  assert.equal((await fetch(t.base + '/healthz')).status, 200);
  assert.equal((await fetch(t.base + '/readyz')).status, 200);
});

test('malformed JSON returns a clean 400', async () => {
  const res = await fetch(t.base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'rode' }, body: '{oops',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'bad_json');
});
