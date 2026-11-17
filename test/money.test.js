'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, futureDate } = require('./helpers');
const { extractJson, sanitise } = require('../src/services/quickbook');
const { normaliseAccess, apptScopeCheck } = (() => ({ ...require('../src/permissions') }))();

let t, admin, staff;
before(async () => { t = await boot(); admin = await t.adminClient(); staff = await t.makeUser(admin, { username: 'ledger.staff', role: 'staff' }); });
after(async () => { await t.close(); });

test('transactions: create, list, delete; money is exact to 2dp', async () => {
  const r = await admin.post('/api/txns', { type: 'expense', date: '2026-03-01', amount: 1234.56, category: 'Rent', method: 'bank', note: 'March' });
  assert.equal(r.status, 201);
  assert.equal(r.data.txn.amount, 1234.56);
  const sum = [0.1, 0.2, 0.3].map((a) => admin.post('/api/txns', { type: 'income', date: '2026-03-02', amount: a, category: 'Tips', method: 'cash' }));
  const done = await Promise.all(sum);
  assert.deepEqual(done.map((d) => d.data.txn.amount), [0.1, 0.2, 0.3]);
  const list = (await admin.get('/api/state')).data.txns;
  assert.equal(list.length, 4);
  assert.equal((await admin.del(`/api/txns/${r.data.txn.id}`)).status, 204);
  assert.equal((await admin.del(`/api/txns/${r.data.txn.id}`)).status, 404);
});

test('transaction validation', async () => {
  const ok = { type: 'income', date: '2026-03-01', amount: 10, category: 'Tips', method: 'cash' };
  for (const bad of [
    { ...ok, amount: 0 }, { ...ok, amount: -5 }, { ...ok, amount: '10' }, { ...ok, amount: 1.005 }, { ...ok, amount: 1e12 },
    { ...ok, type: 'refund' }, { ...ok, method: 'crypto' }, { ...ok, date: 'yesterday' }, { ...ok, category: '' }, { ...ok, note: 'x'.repeat(121) },
  ]) assert.equal((await admin.post('/api/txns', bad)).status, 422, JSON.stringify(bad));
  assert.equal((await admin.post('/api/txns', [1, 2])).status, 422);
});

test('settings: partial updates merge, validate and are shared with customers (without private figures)', async () => {
  const cust = await t.makeUser(admin, { username: 'menu.cust', role: 'customer' });
  const before = (await admin.get('/api/state')).data.settings;
  assert.equal(before.services.length, 6);
  const r = await admin.patch('/api/settings', { opening: { cash: 500, card: 0, bank: -20.5 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.settings.opening.bank, -20.5);
  assert.deepEqual(r.data.settings.staff, before.staff); // untouched keys survive

  const svc = [...before.services, { name: 'Chrome finish', price: 1800, mins: 30 }];
  const s2 = await admin.patch('/api/settings', { services: svc });
  assert.equal(s2.status, 200);
  const added = s2.data.settings.services.find((x) => x.name === 'Chrome finish');
  assert.match(added.id, /^[A-Za-z0-9_-]+$/); // server assigns an id when missing
  const custState = (await cust.client.get('/api/state')).data.settings;
  assert.ok(custState.services.find((x) => x.name === 'Chrome finish'));
  assert.equal(custState.opening, undefined);

  for (const bad of [
    { currency: 'XXX' }, { staff: [] }, { staff: ['A', 'a'] }, { staff: [''] }, { services: [{ name: '', price: 1, mins: 30 }] },
    { services: [{ name: 'x', price: -1, mins: 30 }] }, { services: [{ name: 'x', price: 1, mins: 2 }] },
    { services: [{ id: 'a', name: 'x', price: 1, mins: 30 }, { id: 'a', name: 'y', price: 1, mins: 30 }] },
    { services: [{ id: '<script>', name: 'x', price: 1, mins: 30 }] }, { evil: 1 }, { opening: { cash: 'a' } },
  ]) assert.equal((await admin.patch('/api/settings', bad)).status, 422, JSON.stringify(bad));
  assert.equal((await admin.patch('/api/settings', { currency: 'USD', staff: ['Owner', 'Dilani'] })).status, 200);
});

test('sample data: idempotent load, clear removes sample bookings, payments and photos only', async () => {
  const real = (await admin.post('/api/txns', { type: 'income', date: '2026-03-05', amount: 99, category: 'Retail', method: 'cash' })).data.txn;
  assert.equal((await admin.post('/api/sample')).status, 204);
  const first = (await admin.get('/api/state')).data;
  assert.ok(first.txns.some((x) => x.sample));
  assert.ok(first.appts.some((x) => x.sample));
  assert.equal((await admin.post('/api/sample')).status, 204);
  const second = (await admin.get('/api/state')).data;
  assert.equal(second.txns.length, first.txns.length);
  assert.equal(second.appts.length, first.appts.length);
  // pay a sample booking, then clear: its payment must go too
  const sampleAppt = second.appts.find((x) => x.sample);
  assert.equal((await admin.post(`/api/appts/${sampleAppt.id}/pay`, { method: 'cash' })).status, 200);
  assert.equal((await admin.del('/api/sample')).status, 204);
  const after = (await admin.get('/api/state')).data;
  assert.ok(!after.txns.some((x) => x.sample));
  assert.ok(!after.appts.some((x) => x.sample));
  assert.ok(after.txns.find((x) => x.id === real.id));
  assert.equal((await staff.client.post('/api/sample')).status, 403); // staff lack setup write
});

test('sync revision advances on every write and is stable on reads', async () => {
  const a = (await admin.get('/api/sync')).data.rev;
  assert.equal((await admin.get('/api/sync')).data.rev, a);
  await admin.post('/api/txns', { type: 'income', date: '2026-03-06', amount: 1, category: 'Tips', method: 'cash' });
  assert.ok((await admin.get('/api/sync')).data.rev > a);
});

test('quick book is disabled without an API key', async () => {
  assert.equal((await admin.get('/api/auth/me')).data.features.quickBook, false);
  assert.equal((await admin.post('/api/quick-parse', { text: 'Book Nimali tomorrow 3pm' })).status, 503);
});

test('quick book parses and sanitises model output (mocked upstream)', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    const text = 'Here you go:\n```json\n{"client":"Nimali","phone":null,"service":"Gel polish","date":"2026-12-01","time":"3:00","staff":"Dilani","mins":"60","price":-5,"note":"pink chrome"}\n```';
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }] }) };
  };
  const q = await boot({ anthropic: { apiKey: 'sk-test', model: 'test-model', baseUrl: 'http://upstream.invalid' } }, { fetchImpl });
  try {
    const a = await q.adminClient();
    assert.equal((await a.get('/api/auth/me')).data.features.quickBook, true);
    const r = await a.post('/api/quick-parse', { text: 'Book Nimali for a gel polish tomorrow at 3 pm with Dilani. She wants pink chrome.' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.parsed, { client: 'Nimali', phone: null, service: 'Gel polish', date: '2026-12-01', time: '03:00', staff: 'Dilani', mins: null, price: null, note: 'pink chrome' });
    assert.equal(seen.url, 'http://upstream.invalid/v1/messages');
    assert.equal(seen.init.headers['x-api-key'], 'sk-test');
    const body = JSON.parse(seen.init.body);
    assert.equal(body.model, 'test-model');
    assert.match(body.messages[0].content, /Gel polish/);
    assert.equal((await a.post('/api/quick-parse', { text: '' })).status, 422);
  } finally { await q.close(); }
});

test('quick book surfaces upstream failures cleanly', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const q = await boot({ anthropic: { apiKey: 'sk-test' } }, { fetchImpl });
  try {
    const a = await q.adminClient();
    const r = await a.post('/api/quick-parse', { text: 'Book Nimali' });
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r.data).includes('sk-test'));
  } finally { await q.close(); }
});

test('unit: model reply extraction and access normalisation', () => {
  assert.deepEqual(extractJson('noise {"a":1} tail'), { a: 1 });
  assert.equal(extractJson('no json'), null);
  assert.equal(extractJson('{bad'), null);
  assert.equal(sanitise([]), null);
  assert.equal(sanitise({ time: '25:00', date: '12/01' }).time, null);
  assert.throws(() => normaliseAccess('customer', { money: 'read' }));
  assert.deepEqual(normaliseAccess('admin', { money: 'none' }), normaliseAccess('admin'));
  assert.ok(apptScopeCheck === undefined);
  assert.ok(futureDate(1));
});
