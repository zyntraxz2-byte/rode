'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, JPEG, futureDate } = require('./helpers');

let t, admin, alice, bob, staff, viewer;
before(async () => {
  t = await boot({ customer: { maxActiveBookings: 4 } });
  admin = await t.adminClient();
  alice = await t.makeUser(admin, { username: 'alice.c', name: 'Alice Customer', role: 'customer' });
  bob = await t.makeUser(admin, { username: 'bob.c', name: 'Bob Customer', role: 'customer' });
  staff = await t.makeUser(admin, { username: 'sam.staff', name: 'Sam Staff', role: 'staff' });
  viewer = await t.makeUser(admin, { username: 'vic.viewer', name: 'Vic Viewer', role: 'viewer' });
});
after(async () => { await t.close(); });

const book = (c, extra = {}) => c.post('/api/appts', { serviceId: 's1', date: futureDate(4), time: '10:00', ...extra });

test('customer state exposes only own bookings, the service menu, and no private figures', async () => {
  await book(alice.client);
  await book(bob.client, { time: '15:00' });
  const s = await alice.client.get('/api/state');
  assert.equal(s.status, 200);
  assert.equal(s.data.appts.length, 1);
  assert.equal(s.data.appts[0].client, 'Alice Customer');
  assert.deepEqual(s.data.txns, []);
  assert.equal(s.data.settings.opening, undefined);
  assert.ok(s.data.settings.services.length > 0);
  assert.ok(s.data.settings.staff.length > 0);
  // staff sees both
  assert.equal((await staff.client.get('/api/state')).data.appts.length, 2);
});

test('customer bookings take identity, price and duration from the server, ignoring spoofed fields', async () => {
  const r = await book(alice.client, { date: futureDate(6), client: 'Someone Else', price: 1, mins: 5, service: 'Hacked', status: 'done', sample: true, ownerId: bob.user.id });
  assert.equal(r.status, 201);
  const a = r.data.appt;
  assert.equal(a.client, 'Alice Customer');
  assert.equal(a.service, 'Classic manicure');
  assert.equal(a.price, 2500);
  assert.equal(a.mins, 45);
  assert.equal(a.status, 'booked');
  assert.equal(a.ownerId, alice.user.id);
  assert.equal(a.sample, false);
});

test('customers cannot use custom services or past times', async () => {
  assert.equal((await alice.client.post('/api/appts', { service: 'Custom', price: 10, mins: 30, date: futureDate(7), time: '10:00' })).status, 422);
  assert.equal((await alice.client.post('/api/appts', { serviceId: 's1', date: '2020-01-01', time: '10:00' })).status, 422);
  assert.equal((await alice.client.post('/api/appts', { serviceId: 'nope', date: futureDate(7), time: '10:00' })).status, 422);
});

test('double booking: customers get an opaque slot_taken; staff get details and can force', async () => {
  const date = futureDate(9);
  const first = await book(alice.client, { date, time: '11:00' });
  assert.equal(first.status, 201);
  const clash = await book(bob.client, { date, time: '11:30' });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.error.code, 'slot_taken');
  assert.ok(!JSON.stringify(clash.data).includes('Alice'));
  const sc = await staff.client.post('/api/appts', { client: 'Walk In', service: 'Gel polish', price: 3000, mins: 60, staff: 'Owner', date, time: '11:15' });
  assert.equal(sc.status, 409);
  assert.equal(sc.data.error.code, 'conflict');
  assert.equal(sc.data.error.conflict.client, 'Alice Customer');
  const forced = await staff.client.post('/api/appts', { client: 'Walk In', service: 'Gel polish', price: 3000, mins: 60, staff: 'Owner', date, time: '11:15', force: true });
  assert.equal(forced.status, 201);
  // customers can never force
  const cf = await book(bob.client, { date, time: '11:20', force: true });
  assert.equal(cf.status, 409);
  // back-to-back is fine (the forced walk-in above runs 11:15-12:15)
  assert.equal((await book(bob.client, { date, time: '12:15' })).status, 201);
});

test('customers are capped on upcoming bookings', async () => {
  const c = (await t.makeUser(admin, { username: 'capped.c', name: 'Cap Ped', role: 'customer' })).client;
  for (let i = 0; i < 4; i++) assert.equal((await book(c, { date: futureDate(20 + i) })).status, 201);
  const r = await book(c, { date: futureDate(40) });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'too_many_bookings');
});

test('customers cannot see, cancel, delete or pay other people\'s bookings or do staff things', async () => {
  const bobsId = (await bob.client.get('/api/state')).data.appts[0].id;
  assert.equal((await alice.client.post(`/api/appts/${bobsId}/status`, { status: 'cancelled' })).status, 404);
  assert.equal((await alice.client.del(`/api/appts/${bobsId}`)).status, 403); // no delete right at all
  const mine = (await alice.client.get('/api/state')).data.appts[0].id;
  assert.equal((await alice.client.del(`/api/appts/${mine}`)).status, 403);
  assert.equal((await alice.client.post(`/api/appts/${mine}/pay`, { method: 'cash' })).status, 403);
  assert.equal((await alice.client.post(`/api/appts/${mine}/status`, { status: 'noshow' })).status, 403);
  assert.equal((await alice.client.post(`/api/appts/${mine}/status`, { status: 'done' })).status, 422);
  assert.equal((await alice.client.post('/api/txns', { type: 'income', date: '2026-01-01', amount: 5, category: 'Tips', method: 'cash' })).status, 403);
  assert.equal((await alice.client.patch('/api/settings', { currency: 'USD' })).status, 403);
  assert.equal((await alice.client.post('/api/sample')).status, 403);
  assert.equal((await alice.client.post('/api/quick-parse', { text: 'x' })).status, 403);
  assert.equal((await alice.client.get('/api/users')).status, 403);
});

test('customers can cancel their own booking and it frees the slot', async () => {
  const date = futureDate(12);
  const r = await book(alice.client, { date, time: '09:00' });
  const id = r.data.appt.id;
  assert.equal((await alice.client.post(`/api/appts/${id}/status`, { status: 'cancelled' })).status, 200);
  assert.equal((await bob.client.post('/api/appts', { serviceId: 's1', date, time: '09:00' })).status, 201);
  // cancelled bookings cannot be re-opened by a customer
  assert.equal((await alice.client.post(`/api/appts/${id}/status`, { status: 'booked' })).status, 403);
});

test('view-only users can read but not write anything', async () => {
  const s = await viewer.client.get('/api/state');
  assert.equal(s.status, 200);
  assert.ok(s.data.appts.length > 0);
  assert.equal((await viewer.client.post('/api/appts', { client: 'x', service: 'y', price: 1, mins: 30, date: futureDate(2), time: '10:00' })).status, 403);
  assert.equal((await viewer.client.post('/api/txns', { type: 'income', date: '2026-01-01', amount: 5, category: 'Tips', method: 'cash' })).status, 403);
  assert.equal((await viewer.client.patch('/api/settings', { currency: 'USD' })).status, 403);
  assert.equal((await viewer.client.upload(JPEG)).status, 403);
});

test('payment flow is atomic: pay creates income, undo removes it, deleting the txn reopens the booking', async () => {
  const date = futureDate(1);
  const a = (await staff.client.post('/api/appts', { client: 'Pay Test', service: 'Gel polish', price: 3000.5, mins: 60, staff: 'Owner', date, time: '13:00' })).data.appt;
  const paid = await staff.client.post(`/api/appts/${a.id}/pay`, { method: 'card' });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.appt.status, 'done');
  let st = (await staff.client.get('/api/state')).data;
  const txn = st.txns.find((x) => x.apptId === a.id);
  assert.equal(txn.amount, 3000.5);
  assert.equal(txn.type, 'income');
  assert.equal(txn.method, 'card');
  assert.equal(txn.date <= date, true); // future bookings are recorded on their date or today, never later than the booking
  assert.equal((await staff.client.post(`/api/appts/${a.id}/pay`, { method: 'cash' })).status, 409); // no double payment
  assert.equal((await staff.client.post(`/api/appts/${a.id}/status`, { status: 'cancelled' })).status, 409); // paid
  assert.equal((await staff.client.post(`/api/appts/${a.id}/undo-pay`)).status, 200);
  st = (await staff.client.get('/api/state')).data;
  assert.equal(st.txns.find((x) => x.apptId === a.id), undefined);
  assert.equal(st.appts.find((x) => x.id === a.id).status, 'booked');

  await staff.client.post(`/api/appts/${a.id}/pay`, { method: 'bank' });
  const t2 = (await staff.client.get('/api/state')).data.txns.find((x) => x.apptId === a.id);
  assert.equal((await staff.client.del(`/api/txns/${t2.id}`)).status, 204);
  assert.equal((await staff.client.get('/api/state')).data.appts.find((x) => x.id === a.id).status, 'booked');

  await staff.client.post(`/api/appts/${a.id}/pay`, { method: 'cash' });
  assert.equal((await staff.client.del(`/api/appts/${a.id}`)).status, 204);
  st = (await staff.client.get('/api/state')).data;
  assert.equal(st.txns.find((x) => x.apptId === a.id), undefined);
});

test('no-show, cancel and rebook (with conflict protection)', async () => {
  const date = futureDate(2);
  const mk = (time) => staff.client.post('/api/appts', { client: 'RB', service: 'Gel polish', price: 100, mins: 60, staff: 'Owner', date, time });
  const a = (await mk('16:00')).data.appt;
  assert.equal((await staff.client.post(`/api/appts/${a.id}/status`, { status: 'noshow' })).status, 200);
  const b = (await mk('16:30')).data.appt; // free now that a is a no-show
  const rb = await staff.client.post(`/api/appts/${a.id}/status`, { status: 'booked' });
  assert.equal(rb.status, 409);
  assert.equal((await staff.client.post(`/api/appts/${a.id}/status`, { status: 'booked', force: true })).status, 200);
  assert.ok(b.id);
});

test('a staff member without money access cannot take payment', async () => {
  const { client } = await t.makeUser(admin, { username: 'nomoney.staff', role: 'staff', access: { money: 'none' } });
  const a = (await client.post('/api/appts', { client: 'NM', service: 'Gel polish', price: 100, mins: 30, staff: 'Owner', date: futureDate(15), time: '10:00' })).data.appt;
  assert.equal((await client.post(`/api/appts/${a.id}/pay`, { method: 'cash' })).status, 403);
});

test('photos: upload, attach, per-user visibility, removal deletes the file', async () => {
  const up = await alice.client.upload(JPEG);
  assert.equal(up.status, 201);
  const photoId = up.data.id;
  const mine = (await alice.client.get('/api/state')).data.appts[0];
  const att = await alice.client.post(`/api/appts/${mine.id}/inspo`, { assetIds: [photoId] });
  assert.equal(att.status, 200);
  assert.deepEqual(att.data.inspo, [photoId]);

  const file = path.join(t.dataDir, 'uploads', photoId);
  assert.ok(fs.existsSync(file));
  const own = await alice.client.get(`/_blob/${photoId}`);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('content-type'), 'image/jpeg');
  assert.equal((await bob.client.get(`/_blob/${photoId}`)).status, 404);   // another customer
  assert.equal((await staff.client.get(`/_blob/${photoId}`)).status, 200); // staff with inspo access
  assert.equal((await t.client().get(`/_blob/${photoId}`)).status, 401);   // anonymous
  assert.equal((await alice.client.get('/_blob/..%2F..%2Fetc%2Fpasswd')).status, 404);

  // someone else's photo cannot be attached
  const bobPhoto = (await bob.client.upload(JPEG)).data.id;
  assert.equal((await alice.client.post(`/api/appts/${mine.id}/inspo`, { assetIds: [bobPhoto] })).status, 422);

  const state = (await staff.client.get('/api/state')).data.appts.find((a) => a.id === mine.id);
  assert.deepEqual(state.inspo, [photoId]);
  assert.equal((await alice.client.del(`/api/appts/${mine.id}/inspo/${photoId}`)).status, 204);
  assert.ok(!fs.existsSync(file));
  assert.equal((await alice.client.get(`/_blob/${photoId}`)).status, 404);
});

test('uploads validate the real file type and size', async () => {
  assert.equal((await alice.client.upload(Buffer.from('<svg onload=alert(1)></svg>'.padEnd(40, ' ')), 'image/jpeg')).status, 415);
  assert.equal((await alice.client.upload(Buffer.from('GIF89a' + 'x'.repeat(30)), 'image/gif')).status, 201);
  const big = Buffer.concat([JPEG, Buffer.alloc(9 * 1024 * 1024)]);
  assert.equal((await alice.client.upload(big)).status, 413);
  assert.equal((await alice.client.upload(Buffer.alloc(0))).status, 422);
});

test('a customer without photo access cannot upload', async () => {
  const c = await t.makeUser(admin, { username: 'nophoto.c', role: 'customer', access: { inspo: 'none' } });
  assert.equal((await c.client.upload(JPEG)).status, 403);
  const withPhotos = await c.client.post('/api/appts', { serviceId: 's1', date: futureDate(30), time: '10:00', inspo: ['abc'] });
  assert.equal(withPhotos.status, 403);
});

test('booking with photos in one step, and orphan uploads are swept', async () => {
  const up = (await alice.client.upload(JPEG)).data.id;
  const r = await book(alice.client, { date: futureDate(33), time: '10:00', inspo: [up] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.appt.inspo, [up]);
  const orphan = (await alice.client.upload(JPEG)).data.id;
  t.db.prepare('UPDATE assets SET created_at = ? WHERE id = ?').run(Date.now() - 25 * 3600 * 1000, orphan);
  assert.equal(t.services.assets.sweepOrphans(), 1);
  assert.ok(!fs.existsSync(path.join(t.dataDir, 'uploads', orphan)));
  assert.ok(fs.existsSync(path.join(t.dataDir, 'uploads', up)));
  // deleting the booking removes its photo file
  assert.equal((await staff.client.del(`/api/appts/${r.data.appt.id}`)).status, 204);
  assert.ok(!fs.existsSync(path.join(t.dataDir, 'uploads', up)));
});

test('validation errors on appointments', async () => {
  const base = { client: 'V', service: 'S', price: 10, mins: 30, staff: 'Owner', date: futureDate(2), time: '10:00' };
  const bad = [
    { ...base, date: '2026-02-30' }, { ...base, time: '25:00' }, { ...base, mins: 3 }, { ...base, mins: 30.5 },
    { ...base, price: -1 }, { ...base, price: '10' }, { ...base, staff: 'Nobody' }, { ...base, client: '' },
    { ...base, client: 'x'.repeat(81) }, { ...base, note: 'n'.repeat(301) },
  ];
  for (const b of bad) assert.equal((await staff.client.post('/api/appts', b)).status, 422, JSON.stringify(b).slice(0, 80));
});
