#!/usr/bin/env node
'use strict';
/**
 * Consistent online backup of the database (safe while the server runs) plus the uploads folder.
 * Usage: node scripts/backup.js [destDir]    (default: <DATA_DIR>/backups/<timestamp>)
 * Keeps the 14 most recent backups in the default location.
 */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config');

(async () => {
  const config = loadConfig();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(config.dataDir, 'backups');
  const dest = process.argv[2] ? root : path.join(root, stamp);
  fs.mkdirSync(dest, { recursive: true });
  const db = new Database(path.join(config.dataDir, 'rode.db'), { readonly: true, fileMustExist: true });
  await db.backup(path.join(dest, 'rode.db'));
  db.close();
  const uploads = path.join(config.dataDir, 'uploads');
  if (fs.existsSync(uploads)) fs.cpSync(uploads, path.join(dest, 'uploads'), { recursive: true });
  if (!process.argv[2]) {
    const all = fs.readdirSync(root).filter((n) => fs.statSync(path.join(root, n)).isDirectory()).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 14))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
  }
  console.log(`Backup written to ${dest}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
