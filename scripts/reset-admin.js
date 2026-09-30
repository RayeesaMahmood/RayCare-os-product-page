#!/usr/bin/env node
'use strict';
/**
 * Reset (or create) an administrator account from the server console.
 *   npm run reset-admin -- admin@hospital.in "New Password"
 */
process.removeAllListeners('warning');
const { build } = require('../server/config.js');
const { open } = require('../server/db.js');
const { createUsers } = require('../server/users.js');

const [email, password] = process.argv.slice(2);
if (!email || !password) { console.error('Usage: npm run reset-admin -- <email> "<new password>"'); process.exit(1); }
const cfg = build();
const db = open(cfg.dbFile);
const users = createUsers(db);
try {
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (row) { users.update(row.id, { password, role: 'admin', active: true }); console.log(`Password reset for ${email}. The account is an active administrator.`); }
  else { users.create({ name: 'Administrator', email, role: 'admin', password }); console.log(`Created administrator ${email}.`); }
} catch (e) { console.error(e.message); process.exit(1); } finally { db.close(); }
