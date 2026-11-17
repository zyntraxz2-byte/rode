#!/usr/bin/env node
'use strict';
/**
 * Create an administrator, or reset an existing user's password and promote them to admin.
 * Usage: node scripts/create-admin.js <username> [password]
 * With no password, a strong one is generated and printed once.
 * Use this if you are locked out (the server may be running; SQLite handles concurrent access).
 */
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { openDatabase } = require('../src/db');
const { createServices } = require('../src/services');
const { generatePassword } = require('../src/security');

(async () => {
  const [usernameArg, passwordArg] = process.argv.slice(2);
  if (!usernameArg) { console.error('Usage: node scripts/create-admin.js <username> [password]'); process.exit(2); }
  const config = loadConfig();
  const logger = createLogger('warn');
  const db = openDatabase(config.dataDir);
  const services = createServices({ db, config, logger });
  services.settings.ensureDefaults();
  const username = services.users.normaliseUsername(usernameArg);
  const password = passwordArg || generatePassword(16);
  const existing = services.users.findRowByUsername(username);
  if (existing) {
    db.prepare("UPDATE users SET role = 'admin', access = ?, active = 1, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(require('../src/permissions').PRESETS.admin), Date.now(), existing.id);
    await services.users.setPassword(existing.id, password, { mustChange: !passwordArg });
    console.log(`Updated "${username}" as administrator.`);
  } else {
    await services.users.create({ username, name: username, role: 'admin', password, mustChange: !passwordArg });
    console.log(`Created administrator "${username}".`);
  }
  if (!passwordArg) console.log(`Temporary password: ${password}`);
  db.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
