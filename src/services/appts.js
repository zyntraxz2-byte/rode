'use strict';
const V = require('../validate');
const { invalid, forbidden, notFound, conflict } = require('../errors');
const { newId, isId, todayIn, minutesNowIn, addDays, toMin, toMinor, fromMinor } = require('../util');
const { bumpRev } = require('../db');
const { perms } = require('../permissions');

const METHODS = ['cash', 'card', 'bank'];
const MAX_INSPO = 12;
const MAX_HORIZON_DAYS = 366;

function createApptService({ db, config, settings, assets }) {
  const getRow = (id) => (isId(id) ? db.prepare('SELECT * FROM appts WHERE id = ?').get(id) : undefined);

  function toAppt(r, inspo) {
    const a = {
      id: r.id, date: r.date, time: r.time, mins: r.mins, client: r.client, phone: r.phone,
      service: r.service, staff: r.staff, price: fromMinor(r.price_minor), status: r.status,
      note: r.note, inspo: inspo || [], sample: !!r.sample, createdAt: r.created_at, ownerId: r.owner_id,
    };
    if (r.status === 'done') { a.method = r.method; a.txnId = r.txn_id; }
    return a;
  }

  function inspoMap(whereSql, params) {
    const m = new Map();
    const rows = db.prepare(`SELECT x.id, x.appt_id FROM assets x JOIN appts a ON a.id = x.appt_id ${whereSql} ORDER BY x.appt_id, x.position, x.created_at`).all(...params);
    for (const r of rows) { if (!m.has(r.appt_id)) m.set(r.appt_id, []); m.get(r.appt_id).push(r.id); }
    return m;
  }

  /** Appointments the user may see, in the shape the UI expects. */
  function list(user) {
    const scope = perms.apptScope(user);
    if (scope === 'none') return [];
    const where = scope === 'own' ? 'WHERE a.owner_id = ?' : '';
    const params = scope === 'own' ? [user.id] : [];
    const rows = db.prepare(`SELECT a.* FROM appts a ${where} ORDER BY a.date, a.time, a.created_at`).all(...params);
    const photos = perms.canSee(user, 'inspo') ? inspoMap(where, params) : new Map();
    return rows.map((r) => toAppt(r, photos.get(r.id)));
  }

  function findConflicts(date, staff, time, mins, excludeId = null) {
    const start = toMin(time);
    const end = start + mins;
    return db.prepare("SELECT * FROM appts WHERE date = ? AND staff = ? AND status IN ('booked','done') AND id != ?")
      .all(date, staff, excludeId || '').filter((r) => toMin(r.time) < end && start < toMin(r.time) + r.mins);
  }

  function conflictError(user, clash, { staffView }) {
    if (staffView) {
      return conflict('conflict', `${clash.staff} already has ${clash.client} at ${clash.time}.`,
        { conflict: { client: clash.client, time: clash.time, staff: clash.staff } });
    }
    return conflict('slot_taken', 'That time is no longer available. Please choose another time.');
  }

  function validateInspoIds(user, ids) {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > MAX_INSPO) throw invalid(`Attach at most ${MAX_INSPO} photos.`, 'inspo');
    if (!ids.length) return [];
    if (!(perms.canWrite(user, 'inspo') || perms.isOwn(user, 'inspo'))) throw forbidden('You cannot attach photos.');
    const seen = new Set();
    for (const id of ids) {
      if (!isId(id) || seen.has(id)) throw invalid('Invalid photo.', 'inspo');
      seen.add(id);
      const a = assets.row(id);
      if (!a || a.owner_id !== user.id || a.appt_id) throw invalid('One of the photos is no longer available. Add it again.', 'inspo');
    }
    return ids;
  }

  function create(user, input, { force = false } = {}) {
    V.obj(input);
    const cfg = settings.get();
    const staffView = perms.canWrite(user, 'book');
    if (!staffView && !perms.isOwn(user, 'book')) throw forbidden('You cannot make bookings.');

    const date = V.date(input.date);
    const time = V.time(input.time);
    const note = V.str(input.note, 'note', { max: 300 });
    const staff = V.str(input.staff || cfg.staff[0], 'staff', { min: 1, max: 40 });
    if (!cfg.staff.includes(staff)) throw invalid('Choose a team member from the list.', 'staff');
    const inspoIds = validateInspoIds(user, input.inspo);

    let client, phone, service, price, mins, owner = null;
    const menuItem = input.serviceId ? cfg.services.find((s) => s.id === input.serviceId) : null;
    if (staffView) {
      client = V.str(input.client, 'client', { min: 1, max: 80 });
      phone = V.str(input.phone, 'phone', { max: 30 });
      if (input.serviceId && !menuItem) throw invalid('That service is no longer on the menu.', 'serviceId');
      service = menuItem ? menuItem.name : V.str(input.service, 'service', { min: 1, max: 60 });
      price = input.price === undefined && menuItem ? menuItem.price : V.money(input.price, 'price');
      mins = input.mins === undefined && menuItem ? menuItem.mins : V.int(input.mins, 'mins', { min: 5, max: 1440 });
    } else {
      // Customers: identity, price and duration come from the server, never from the request.
      if (!menuItem) throw invalid('Choose a service from the menu.', 'serviceId');
      client = user.name;
      phone = input.phone === undefined || input.phone === '' ? user.phone : V.str(input.phone, 'phone', { max: 30 });
      service = menuItem.name; price = menuItem.price; mins = menuItem.mins; owner = user.id;
      const today = todayIn(config.timezone);
      if (date < today || (date === today && toMin(time) <= minutesNowIn(config.timezone))) throw invalid('Choose a time in the future.', 'time');
      if (date > addDays(today, MAX_HORIZON_DAYS)) throw invalid('That date is too far ahead.', 'date');
      const { n } = db.prepare("SELECT COUNT(*) AS n FROM appts WHERE owner_id = ? AND status = 'booked' AND date >= ?").get(user.id, today);
      if (n >= config.customer.maxActiveBookings) throw conflict('too_many_bookings', 'You have too many upcoming bookings. Cancel one first.');
    }

    return db.transaction(() => {
      const clashes = findConflicts(date, staff, time, mins);
      if (clashes.length && (!staffView || !force)) throw conflictError(user, clashes[0], { staffView });
      const id = newId();
      db.prepare(`INSERT INTO appts(id, date, time, mins, client, phone, service, staff, price_minor, status, note, sample, owner_id, created_by, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?, 'booked', ?, 0, ?, ?, ?)`)
        .run(id, date, time, mins, client, phone, service, staff, toMinor(price), note, owner, user.id, Date.now());
      inspoIds.forEach((aid, i) => db.prepare('UPDATE assets SET appt_id = ?, position = ? WHERE id = ?').run(id, i, aid));
      bumpRev(db);
      return toAppt(getRow(id), inspoIds);
    })();
  }

  /** Load an appointment the user is allowed to touch, hiding other people's records from customers. */
  function loadFor(user, id) {
    const r = getRow(id);
    if (!r) throw notFound('Booking not found.');
    if (perms.apptScope(user) === 'own' && r.owner_id !== user.id) throw notFound('Booking not found.');
    if (perms.apptScope(user) === 'none') throw notFound('Booking not found.');
    return r;
  }

  function setStatus(user, id, status, { force = false } = {}) {
    V.oneOf(status, ['booked', 'cancelled', 'noshow'], 'status');
    const a = loadFor(user, id);
    const staffView = perms.canWrite(user, 'book');
    if (!staffView) {
      const upcoming = a.date >= todayIn(config.timezone); // history of past visits is not the customer's to rewrite
      const ownCancel = perms.isOwn(user, 'book') && a.owner_id === user.id && status === 'cancelled' && a.status === 'booked' && upcoming;
      if (!ownCancel) throw forbidden('You can only cancel your own upcoming bookings.');
    }
    if (a.status === 'done') throw conflict('paid', 'This booking is paid. Undo the payment first.');
    if (a.status === status) return toAppt(a, null);
    return db.transaction(() => {
      if (status === 'booked') {
        const clashes = findConflicts(a.date, a.staff, a.time, a.mins, a.id);
        if (clashes.length && !force) throw conflictError(user, clashes[0], { staffView: true });
      }
      db.prepare('UPDATE appts SET status = ?, method = NULL, txn_id = NULL WHERE id = ?').run(status, id);
      bumpRev(db);
      return toAppt(getRow(id), null);
    })();
  }

  function pay(user, id, method) {
    if (!perms.canWrite(user, 'book') || !perms.canWrite(user, 'money')) throw forbidden('You cannot record payments.');
    V.oneOf(method, METHODS, 'method');
    const a = loadFor(user, id);
    if (a.status !== 'booked') throw conflict('not_payable', 'Only booked appointments can be marked paid.');
    const today = todayIn(config.timezone);
    return db.transaction(() => {
      const txnId = newId();
      db.prepare(`INSERT INTO txns(id, type, date, amount_minor, category, service, method, note, staff, appt_id, sample, created_by, created_at)
                  VALUES (?, 'income', ?, ?, 'Services', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(txnId, a.date < today ? a.date : today, a.price_minor, a.service, method, a.client, a.staff, a.id, a.sample, user.id, Date.now());
      db.prepare("UPDATE appts SET status = 'done', method = ?, txn_id = ? WHERE id = ?").run(method, txnId, id);
      bumpRev(db);
      return toAppt(getRow(id), null);
    })();
  }

  function undoPay(user, id) {
    if (!perms.canWrite(user, 'book') || !perms.canWrite(user, 'money')) throw forbidden('You cannot change payments.');
    const a = loadFor(user, id);
    if (a.status !== 'done') throw conflict('not_paid', 'This booking is not marked paid.');
    return db.transaction(() => {
      if (a.txn_id) db.prepare('DELETE FROM txns WHERE id = ?').run(a.txn_id);
      db.prepare("UPDATE appts SET status = 'booked', method = NULL, txn_id = NULL WHERE id = ?").run(id);
      bumpRev(db);
      return toAppt(getRow(id), null);
    })();
  }

  function remove(user, id) {
    if (!perms.canWrite(user, 'book')) throw forbidden('You cannot delete bookings.');
    const a = loadFor(user, id);
    const photoIds = db.prepare('SELECT id FROM assets WHERE appt_id = ?').all(id).map((r) => r.id);
    db.transaction(() => {
      if (a.txn_id) db.prepare('DELETE FROM txns WHERE id = ?').run(a.txn_id);
      db.prepare('DELETE FROM appts WHERE id = ?').run(id); // photo rows cascade
      bumpRev(db);
    })();
    assets.unlinkFiles(photoIds);
  }

  function canEditInspo(user, appt) {
    return perms.canWrite(user, 'inspo') || (perms.isOwn(user, 'inspo') && appt.owner_id === user.id);
  }

  function attachInspo(user, id, ids) {
    const a = loadFor(user, id);
    if (!canEditInspo(user, a)) throw forbidden('You cannot add photos to this booking.');
    if (!Array.isArray(ids) || !ids.length) throw invalid('No photos given.', 'assetIds');
    return db.transaction(() => {
      const existing = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE appt_id = ?').get(id).n;
      if (existing + ids.length > MAX_INSPO) throw invalid(`A booking can hold at most ${MAX_INSPO} photos.`, 'assetIds');
      const seen = new Set();
      ids.forEach((aid, i) => {
        if (!isId(aid) || seen.has(aid)) throw invalid('Invalid photo.', 'assetIds');
        seen.add(aid);
        const asset = assets.row(aid);
        if (!asset || asset.owner_id !== user.id || asset.appt_id) throw invalid('One of the photos is no longer available. Add it again.', 'assetIds');
        db.prepare('UPDATE assets SET appt_id = ?, position = ? WHERE id = ?').run(id, existing + i, aid);
      });
      bumpRev(db);
      return db.prepare('SELECT id FROM assets WHERE appt_id = ? ORDER BY position, created_at').all(id).map((r) => r.id);
    })();
  }

  function removeInspo(user, id, assetId) {
    const a = loadFor(user, id);
    if (!canEditInspo(user, a)) throw forbidden('You cannot remove photos from this booking.');
    const asset = assets.row(assetId);
    if (!asset || asset.appt_id !== id) throw notFound('Photo not found.');
    db.transaction(() => { db.prepare('DELETE FROM assets WHERE id = ?').run(assetId); bumpRev(db); })();
    assets.unlinkFiles([assetId]);
  }

  return { list, create, setStatus, pay, undoPay, remove, attachInspo, removeInspo, findConflicts, toAppt, getRow };
}

module.exports = { createApptService, METHODS };
