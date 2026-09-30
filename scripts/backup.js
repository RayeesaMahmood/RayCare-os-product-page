#!/usr/bin/env node
'use strict';
/**
 * Online backup of the database (safe while the server is running).
 *   npm run backup                 → data/backups/raycare-YYYYMMDD-HHMM.db
 *   npm run backup -- /mnt/usb     → to another folder
 * Keeps the 30 most recent backups in the default folder.
 */
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { build } = require('../server/config.js');

const cfg = build();
if (!fs.existsSync(cfg.dbFile)) { console.error('No database found at ' + cfg.dbFile); process.exit(1); }
const dir = path.resolve(process.argv[2] || path.join(cfg.dataDir, 'backups'));
fs.mkdirSync(dir, { recursive: true });
const d = new Date(), p = n => String(n).padStart(2, '0');
const file = path.join(dir, `raycare-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.db`);
const db = new DatabaseSync(cfg.dbFile);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
console.log('Backup written to ' + file);
if (!process.argv[2]) {
  const old = fs.readdirSync(dir).filter(f => /^raycare-\d{8}-\d{4}\.db$/.test(f)).sort().reverse().slice(30);
  old.forEach(f => fs.rmSync(path.join(dir, f)));
  if (old.length) console.log(`Removed ${old.length} old backup(s).`);
}
