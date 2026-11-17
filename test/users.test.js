'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, ADMIN_PW } = require('./helpers');

let t, admin;
before(async () => { t = await boot(); admin = await t.adminClient(); });
after(async () => { await t.close(); });

test('admin can add a customer; first sign-in forces a password change', async () => {
  const create = await admin.post('/api/users', {
    username: 'nimali', name: 'Nimali Perera', phone: '0771234567', role: 'customer', password: 'Temp-Passw0rd!',
  });
  assert.equal(create.status, 201);
  assert.equal(create.data.user.role, 'customer');
  assert.deepEqual(create.data.user.access, { overview: 'none', book: 'own', inspo: 'own', money: 'none', setup: 'none' });
  assert.equal(create.data.user.mustChange, true);
  assert.ok(!('password_hash' in create.data.user));

  const c = t.client();
  assert.equal((await c.login('nimali', 'Temp-Passw0rd!')).status, 200);
  const blocked = await c.get('/api/state');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'password_change_required');
  assert.equal((await c.get('/api/auth/me')).data.user.mustChange, true);

  assert.equal((await c.post('/api/auth/password', { current: 'wrong', next: 'Another-Passw0rd!' })).status, 403);
  assert.equal((await c.post('/api/auth/password', { current: 'Temp-Passw0rd!', next: 'short' })).status, 422);
  assert.equal((await c.post('/api/auth/password', { current: 'Temp-Passw0rd!', next: 'nimali-nimali-1' })).status, 422); // contains username
  const ok = await c.post('/api/auth/password', { current: 'Temp-Passw0rd!', next: 'Brand-New-Passw0rd!' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.mustChange, false);
  assert.equal((await c.get('/api/state')).status, 200);

  const again = t.client();
  assert.equal((await again.login('nimali', 'Temp-Passw0rd!')).status, 401);
  assert.equal((await again.login('nimali', 'Brand-New-Passw0rd!')).status, 200);
});

test('username rules and duplicates', async () => {
  assert.equal((await admin.post('/api/users', { username: 'a b', name: 'x', role: 'staff', password: 'Str0ng-Passw0rd!' })).status, 422);
  assert.equal((await admin.post('/api/users', { username: 'ab', name: 'x', role: 'staff', password: 'Str0ng-Passw0rd!' })).status, 422);
  assert.equal((await admin.post('/api/users', { username: 'dup.user', name: 'x', role: 'staff', password: 'Str0ng-Passw0rd!' })).status, 201);
  const dup = await admin.post('/api/users', { username: 'DUP.user', name: 'y', role: 'staff', password: 'Str0ng-Passw0rd!' });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'username_taken');
});

test('weak passwords and bad roles are rejected', async () => {
  assert.equal((await admin.post('/api/users', { username: 'weak1', name: 'W', role: 'staff', password: 'short' })).status, 422);
  assert.equal((await admin.post('/api/users', { username: 'weak2', name: 'W', role: 'staff', password: 'password123' })).status, 422);
  assert.equal((await admin.post('/api/users', { username: 'weak3', name: 'W', role: 'owner', password: 'Str0ng-Passw0rd!' })).status, 422);
});

test('customer access cannot be widened beyond customer limits; staff access can be tuned', async () => {
  const bad = await admin.post('/api/users', { username: 'cust.bad', name: 'C', role: 'customer', password: 'Str0ng-Passw0rd!', access: { money: 'read' } });
  assert.equal(bad.status, 422);
  const bad2 = await admin.post('/api/users', { username: 'cust.bad2', name: 'C', role: 'customer', password: 'Str0ng-Passw0rd!', access: { book: 'write' } });
  assert.equal(bad2.status, 422);
  const narrow = await admin.post('/api/users', { username: 'cust.nophoto', name: 'C', role: 'customer', password: 'Str0ng-Passw0rd!', access: { inspo: 'none' } });
  assert.equal(narrow.status, 201);
  assert.equal(narrow.data.user.access.inspo, 'none');
  assert.equal(narrow.data.user.access.book, 'own');
  const staff = await admin.post('/api/users', { username: 'staff.nomoney', name: 'S', role: 'staff', password: 'Str0ng-Passw0rd!', access: { money: 'none', setup: 'none' } });
  assert.equal(staff.status, 201);
  const unknown = await admin.post('/api/users', { username: 'x.unknown', name: 'S', role: 'staff', password: 'Str0ng-Passw0rd!', access: { admin: 'write' } });
  assert.equal(unknown.status, 422);
  const viewerWrite = await admin.post('/api/users', { username: 'viewer.w', name: 'V', role: 'viewer', password: 'Str0ng-Passw0rd!', access: { money: 'write' } });
  assert.equal(viewerWrite.status, 422);
});

test('only administrators can manage users', async () => {
  const { client: staff } = await t.makeUser(admin, { username: 'plainstaff', role: 'staff' });
  const { client: cust } = await t.makeUser(admin, { username: 'plaincust', role: 'customer' });
  for (const c of [staff, cust]) {
    assert.equal((await c.get('/api/users')).status, 403);
    assert.equal((await c.post('/api/users', { username: 'sneaky', name: 'S', role: 'admin', password: 'Str0ng-Passw0rd!' })).status, 403);
  }
});

test('admin list includes role metadata for the UI and never leaks hashes', async () => {
  const r = await admin.get('/api/users');
  assert.equal(r.status, 200);
  assert.ok(r.data.users.length >= 1);
  assert.ok(r.data.meta.roles.find((x) => x.id === 'customer'));
  assert.ok(!JSON.stringify(r.data).includes('scrypt$'));
});

test('role change resets access to the new preset; admin cannot demote or deactivate themself; last admin is protected', async () => {
  const { user } = await t.makeUser(admin, { username: 'promote.me', role: 'viewer' });
  const up = await admin.patch(`/api/users/${user.id}`, { role: 'staff' });
  assert.equal(up.data.user.access.book, 'write');
  const me = (await admin.get('/api/auth/me')).data.user;
  assert.equal((await admin.patch(`/api/users/${me.id}`, { role: 'staff' })).status, 409);
  assert.equal((await admin.patch(`/api/users/${me.id}`, { active: false })).status, 409);
  assert.equal((await admin.del(`/api/users/${me.id}`)).status, 409);

  // second admin can demote the first only while another active admin remains
  const second = await t.makeUser(admin, { username: 'admin.two', role: 'admin' });
  assert.equal((await second.client.patch(`/api/users/${me.id}`, { role: 'staff' })).status, 200);
  // now admin.two is the only admin; the demoted one (now staff) cannot manage anything
  assert.equal((await admin.get('/api/users')).status, 403);
  assert.equal((await second.client.del(`/api/users/${second.user.id}`)).status, 409);
  // restore for later tests
  assert.equal((await second.client.patch(`/api/users/${me.id}`, { role: 'admin' })).status, 200);
});

test('deactivating a user ends their sessions and blocks login; reactivating restores it', async () => {
  const { client: c, user, password } = await t.makeUser(admin, { username: 'to.deactivate', role: 'staff' });
  assert.equal((await c.get('/api/state')).status, 200);
  assert.equal((await admin.patch(`/api/users/${user.id}`, { active: false })).status, 200);
  assert.equal((await c.get('/api/state')).status, 401);
  assert.equal((await t.client().login('to.deactivate', password)).status, 401);
  assert.equal((await admin.patch(`/api/users/${user.id}`, { active: true })).status, 200);
  assert.equal((await t.client().login('to.deactivate', password)).status, 200);
});

test('admin password reset revokes sessions and forces a change', async () => {
  const { client: c, user } = await t.makeUser(admin, { username: 'to.reset', role: 'customer' });
  assert.equal((await admin.post(`/api/users/${user.id}/password`, { password: 'weak' })).status, 422);
  assert.equal((await admin.post(`/api/users/${user.id}/password`, { password: 'Reset-Passw0rd!' })).status, 204);
  assert.equal((await c.get('/api/state')).status, 401);
  const n = t.client();
  assert.equal((await n.login('to.reset', 'Reset-Passw0rd!')).status, 200);
  assert.equal((await n.get('/api/state')).data.error.code, 'password_change_required');
});

test('permission edits take effect on the very next request', async () => {
  const { client: c, user } = await t.makeUser(admin, { username: 'live.perms', role: 'staff' });
  assert.equal((await c.get('/api/state')).data.txns.length >= 0, true);
  const before = (await c.get('/api/sync')).data.uv;
  assert.equal((await admin.patch(`/api/users/${user.id}`, { access: { money: 'none', overview: 'none', setup: 'none' } })).status, 200);
  const state = await c.get('/api/state');
  assert.deepEqual(state.data.txns, []);
  assert.equal(state.data.settings.opening, undefined);
  assert.notEqual((await c.get('/api/sync')).data.uv, before);
  assert.equal((await c.post('/api/txns', { type: 'income', date: '2026-01-01', amount: 5, category: 'Tips', method: 'cash' })).status, 403);
});

test('deleting a customer keeps their booking history', async () => {
  const { client: c, user } = await t.makeUser(admin, { username: 'gone.soon', role: 'customer', name: 'Gone Soon' });
  const { futureDate } = require('./helpers');
  const b = await c.post('/api/appts', { serviceId: 's1', date: futureDate(5), time: '10:00' });
  assert.equal(b.status, 201);
  assert.equal((await admin.del(`/api/users/${user.id}`)).status, 204);
  const all = (await admin.get('/api/state')).data.appts;
  const kept = all.find((a) => a.id === b.data.appt.id);
  assert.ok(kept);
  assert.equal(kept.ownerId, null);
});

test('bootstrap admin is only created on an empty database', async () => {
  const before = (await admin.get('/api/users')).data.users.length;
  await t.services.users.ensureBootstrapAdmin(t.config);
  assert.equal((await admin.get('/api/users')).data.users.length, before);
  assert.ok(ADMIN_PW);
});
