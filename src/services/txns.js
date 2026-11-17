'use strict';
const V = require('../validate');
const { forbidden, notFound } = require('../errors');
const { newId, isId, toMinor, fromMinor } = require('../util');
const { bumpRev } = require('../db');
const { perms } = require('../permissions');
const { METHODS } = require('./appts');

function toTxn(r) {
  const t = {
    id: r.id, type: r.type, date: r.date, amount: fromMinor(r.amount_minor), category: r.category,
    method: r.method, note: r.note, createdAt: r.created_at, sample: !!r.sample,
  };
  if (r.service) t.service = r.service;
  if (r.staff) t.staff = r.staff;
  if (r.appt_id) t.apptId = r.appt_id;
  return t;
}

function createTxnService({ db }) {
  function list(user) {
    if (!perms.canSeeTxns(user)) return [];
    return db.prepare('SELECT * FROM txns ORDER BY date DESC, created_at DESC').all().map(toTxn);
  }

  function create(user, input) {
    if (!perms.canWrite(user, 'money')) throw forbidden('You cannot add transactions.');
    V.obj(input);
    const type = V.oneOf(input.type, ['income', 'expense'], 'type');
    const date = V.date(input.date);
    const amount = V.money(input.amount, 'amount', { min: 0.01 });
    const category = V.str(input.category, 'category', { min: 1, max: 40 });
    const method = V.oneOf(input.method, METHODS, 'method');
    const note = V.str(input.note, 'note', { max: 120 });
    const id = newId();
    db.transaction(() => {
      db.prepare(`INSERT INTO txns(id, type, date, amount_minor, category, method, note, sample, created_by, created_at)
                  VALUES (?,?,?,?,?,?,?,0,?,?)`).run(id, type, date, toMinor(amount), category, method, note, user.id, Date.now());
      bumpRev(db);
    })();
    return toTxn(db.prepare('SELECT * FROM txns WHERE id = ?').get(id));
  }

  /** Deleting a payment also reopens the booking it settled. */
  function remove(user, id) {
    if (!perms.canWrite(user, 'money')) throw forbidden('You cannot delete transactions.');
    const t = isId(id) ? db.prepare('SELECT * FROM txns WHERE id = ?').get(id) : null;
    if (!t) throw notFound('Transaction not found.');
    db.transaction(() => {
      db.prepare('DELETE FROM txns WHERE id = ?').run(id);
      if (t.appt_id) {
        db.prepare("UPDATE appts SET status = 'booked', method = NULL, txn_id = NULL WHERE id = ? AND txn_id = ?").run(t.appt_id, id);
      }
      bumpRev(db);
    })();
  }

  return { list, create, remove, toTxn };
}

module.exports = { createTxnService };
