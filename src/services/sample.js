'use strict';
const { todayIn, addDays, toMinor } = require('../util');
const { bumpRev } = require('../db');
const { forbidden } = require('../errors');
const { perms } = require('../permissions');
const { defaultServices } = require('./settings');

function createSampleService({ db, config, settings, assets }) {
  const needs = (user) => {
    if (!(perms.canWrite(user, 'setup') && perms.canWrite(user, 'money') && perms.canWrite(user, 'book'))) {
      throw forbidden('Sample data needs full access to bookings, money and setup.');
    }
  };

  /** Idempotent: rows use fixed ids and INSERT OR IGNORE, so repeated loads never duplicate. */
  function load(user) {
    needs(user);
    const cfg = settings.get();
    const big = cfg.currency === 'LKR' || cfg.currency === 'INR';
    const A = (v) => (big ? v : Math.max(1, Math.round(v / 100)));
    const svcs = cfg.services.length ? cfg.services : defaultServices(cfg.currency);
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const t = todayIn(config.timezone);
    const now = Date.now();

    const insTxn = db.prepare(`INSERT OR IGNORE INTO txns(id, type, date, amount_minor, category, service, method, note, sample, created_by, created_at)
                               VALUES (?,?,?,?,?,?,?,?,1,?,?)`);
    const insAppt = db.prepare(`INSERT OR IGNORE INTO appts(id, date, time, mins, client, phone, service, staff, price_minor, status, note, sample, created_by, created_at)
                                VALUES (?,?,?,?,?, '', ?,?,?, 'booked', '', 1, ?, ?)`);
    db.transaction(() => {
      for (let i = 0; i <= 16; i++) {
        if (i % 5 === 4) continue;
        const s = svcs[Math.floor(rnd() * svcs.length)];
        const m = ['cash', 'card', 'bank'][Math.floor(rnd() * 3)];
        insTxn.run(`smp_i${i}`, 'income', addDays(t, -i), toMinor(s.price), 'Services', s.name, m, 'Sample client', user.id, now + i);
      }
      [[2, 'Supplies', 'Polish and gel restock', A(18000), 'card'], [4, 'Cleaning', 'Towels and sanitiser', A(3500), 'cash'],
        [6, 'Utilities', 'Electricity and water', A(9500), 'bank'], [9, 'Marketing', 'Social media promotion', A(6000), 'card'],
        [11, 'Rent', 'Studio rent', A(45000), 'bank'], [13, 'Wages', 'Weekly wages', A(30000), 'bank'],
        [15, 'Supplies', 'Files, buffers and cotton', A(4200), 'cash']]
        .forEach((e, i) => insTxn.run(`smp_e${i}`, 'expense', addDays(t, -e[0]), toMinor(e[3]), e[1], null, e[4], e[2], user.id, now + i));
      [[0, '10:00', 'A'], [0, '11:30', 'B'], [0, '14:00', 'C'], [1, '10:30', 'D'], [1, '15:00', 'E'], [2, '12:00', 'F']]
        .forEach((x, i) => {
          const s = svcs[i % svcs.length];
          insAppt.run(`smp_a${i}`, addDays(t, x[0]), x[1], s.mins, `Sample client ${x[2]}`, s.name, cfg.staff[0], toMinor(s.price), user.id, now + i);
        });
      bumpRev(db);
    })();
  }

  function clear(user) {
    needs(user);
    const photoIds = db.prepare('SELECT x.id FROM assets x JOIN appts a ON a.id = x.appt_id WHERE a.sample = 1').all().map((r) => r.id);
    const removed = db.transaction(() => {
      // Payments recorded against sample bookings are flagged sample too (see appts.pay), so both go.
      const a = db.prepare('DELETE FROM appts WHERE sample = 1').run().changes;
      const t = db.prepare('DELETE FROM txns WHERE sample = 1').run().changes;
      bumpRev(db);
      return a + t;
    })();
    assets.unlinkFiles(photoIds);
    return removed;
  }

  return { load, clear };
}

module.exports = { createSampleService };
