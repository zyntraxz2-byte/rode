'use strict';
const V = require('../validate');
const { invalid } = require('../errors');
const { isId, newId } = require('../util');
const { bumpRev } = require('../db');

const CURRENCIES = ['LKR', 'USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'AED'];

function defaultServices(currency) {
  const big = currency === 'LKR' || currency === 'INR';
  const prices = big ? [2500, 3000, 3500, 6500, 1500, 800] : [25, 30, 35, 65, 15, 8];
  const names = [['Classic manicure', 45], ['Classic pedicure', 60], ['Gel polish', 60], ['Acrylic full set', 120], ['Nail art (per set)', 30], ['Polish removal', 20]];
  return names.map((n, i) => ({ id: `s${i + 1}`, name: n[0], price: prices[i], mins: n[1] }));
}

function createSettingsService({ db, config }) {
  const getKey = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putKey = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  function ensureDefaults() {
    const currency = CURRENCIES.includes(config.defaultCurrency) ? config.defaultCurrency : 'USD';
    const defaults = {
      salon: 'Your nail studio',
      currency,
      staff: ['Owner'],
      services: defaultServices(currency),
      opening: { cash: 0, card: 0, bank: 0 },
    };
    db.transaction(() => {
      for (const [k, v] of Object.entries(defaults)) {
        if (!getKey.get(k)) putKey.run(k, JSON.stringify(v));
      }
    })();
  }

  function get() {
    const out = {};
    for (const k of ['salon', 'currency', 'staff', 'services', 'opening']) {
      const row = getKey.get(k);
      out[k] = row ? JSON.parse(row.value) : null;
    }
    return out;
  }

  /** What users without access to private figures may see. */
  function publicView(s) {
    return { salon: s.salon, currency: s.currency, staff: s.staff, services: s.services };
  }

  function validatePatch(patch) {
    V.obj(patch);
    const out = {};
    const allowed = ['salon', 'currency', 'staff', 'services', 'opening'];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw invalid(`Unknown setting "${k}".`, k);

    if ('salon' in patch) out.salon = V.str(patch.salon, 'salon', { min: 1, max: 80 });
    if ('currency' in patch) out.currency = V.oneOf(patch.currency, CURRENCIES, 'currency');
    if ('staff' in patch) {
      if (!Array.isArray(patch.staff)) throw invalid('staff must be a list.', 'staff');
      if (patch.staff.length < 1 || patch.staff.length > 50) throw invalid('Keep between 1 and 50 team members.', 'staff');
      const seen = new Set();
      out.staff = patch.staff.map((n, i) => {
        const name = V.str(n, `staff[${i}]`, { min: 1, max: 40 });
        if (seen.has(name.toLowerCase())) throw invalid(`Duplicate team member "${name}".`, 'staff');
        seen.add(name.toLowerCase());
        return name;
      });
    }
    if ('services' in patch) {
      if (!Array.isArray(patch.services) || patch.services.length > 100) throw invalid('services must be a list of at most 100 items.', 'services');
      const ids = new Set();
      out.services = patch.services.map((s, i) => {
        V.obj(s, `services[${i}]`);
        let id = s.id;
        if (id === undefined || id === null || id === '') id = `s${newId()}`;
        if (!isId(id)) throw invalid('Invalid service id.', `services[${i}].id`);
        if (ids.has(id)) throw invalid('Duplicate service id.', `services[${i}].id`);
        ids.add(id);
        return {
          id,
          name: V.str(s.name, `services[${i}].name`, { min: 1, max: 60 }),
          price: V.money(s.price, `services[${i}].price`),
          mins: V.int(s.mins, `services[${i}].mins`, { min: 5, max: 1440 }),
        };
      });
    }
    if ('opening' in patch) {
      const o = V.obj(patch.opening, 'opening');
      out.opening = {};
      for (const m of ['cash', 'card', 'bank']) {
        out.opening[m] = o[m] === undefined ? 0 : V.money(o[m], `opening.${m}`, { allowNegative: true, max: 1e12 });
      }
    }
    return out;
  }

  /** Merge a partial update (top-level keys replace). Returns the full settings. */
  function patch(input) {
    const clean = validatePatch(input);
    db.transaction(() => {
      for (const [k, v] of Object.entries(clean)) putKey.run(k, JSON.stringify(v));
      bumpRev(db);
    })();
    return get();
  }

  return { ensureDefaults, get, publicView, patch, defaultServices, CURRENCIES };
}

module.exports = { createSettingsService, CURRENCIES, defaultServices };
