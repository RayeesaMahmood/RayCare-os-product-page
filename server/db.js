'use strict';
/**
 * SQLite database using Node's built-in driver (node:sqlite). No native
 * modules to compile, no separate database server to run. The whole
 * hospital lives in one file that is easy to back up.
 */
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('admin','desk','doctor','nurse')),
        pass_hash TEXT NOT NULL, dept TEXT, active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, last_login INTEGER
      );
      CREATE TABLE patients (pid TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, abha TEXT, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX patients_phone ON patients(phone);
      CREATE INDEX patients_name ON patients(name COLLATE NOCASE);
      CREATE TABLE visits (id TEXT PRIMARY KEY, day TEXT NOT NULL, tok TEXT NOT NULL, dept TEXT NOT NULL, pid TEXT NOT NULL, status TEXT NOT NULL, arrived INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX visits_day ON visits(day);
      CREATE INDEX visits_pid ON visits(pid);
      CREATE INDEX visits_status ON visits(status);
      CREATE TABLE beds (id TEXT PRIMARY KEY, ward TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE bed_requests (id TEXT PRIMARY KEY, status TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE ambulances (id TEXT PRIMARY KEY, status TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE appointments (id TEXT PRIMARY KEY, day TEXT NOT NULL, dept TEXT NOT NULL, t INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX appointments_day ON appointments(day);
      CREATE TABLE feedback (id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, stars INTEGER NOT NULL, t INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE alerts (id TEXT PRIMARY KEY, t INTEGER NOT NULL, level TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, text TEXT NOT NULL);
      CREATE INDEX audit_t ON audit_log(t);
      CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, visit_id TEXT, channel TEXT NOT NULL, recipient TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, detail TEXT);
    `
  }
];

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER NOT NULL)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
    });
  }
  return db;
}

/* Run fn inside a transaction; roll back on any error. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ } throw e; }
}

module.exports = { open, tx, MIGRATIONS };
