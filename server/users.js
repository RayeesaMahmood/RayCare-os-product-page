'use strict';
/** Staff accounts. Patients never log in; they use signed tracking links. */
const crypto = require('node:crypto');
const { hashPassword, verifyPassword, passwordProblem } = require('./auth.js');
const { HttpError } = require('./security.js');

const ROLES = ['admin', 'desk', 'doctor', 'nurse'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createUsers(db) {
  const pub = u => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, dept: u.dept || null, active: !!u.active, createdAt: u.created_at, lastLogin: u.last_login || null });

  function validate({ name, email, role, password, dept }, partial = false) {
    if (!partial || name != null) { if (!name || String(name).trim().length < 2 || String(name).length > 80) throw new HttpError(400, 'invalid', 'Enter a name between 2 and 80 characters'); }
    if (!partial || email != null) { if (!EMAIL.test(String(email || ''))) throw new HttpError(400, 'invalid', 'Enter a valid email address'); }
    if (!partial || role != null) { if (!ROLES.includes(role)) throw new HttpError(400, 'invalid', 'Role must be admin, desk, doctor or nurse'); }
    if (!partial || password != null) { const p = passwordProblem(password); if (p) throw new HttpError(400, 'invalid', p); }
    if (dept != null && dept !== '' && !/^[A-Z]{2,4}$/.test(dept)) throw new HttpError(400, 'invalid', 'Unknown department');
  }

  return {
    count: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    list: () => db.prepare('SELECT * FROM users ORDER BY created_at').all().map(pub),
    byId: id => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
    create(u) {
      validate(u);
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(u.email)) throw new HttpError(409, 'duplicate', 'A user with that email already exists');
      const row = { id: 'U' + crypto.randomBytes(6).toString('hex'), name: String(u.name).trim(), email: String(u.email).trim().toLowerCase(), role: u.role, dept: u.dept || null };
      db.prepare('INSERT INTO users (id, name, email, role, pass_hash, dept, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
        .run(row.id, row.name, row.email, row.role, hashPassword(u.password), row.dept, Date.now());
      return pub(this.byId(row.id));
    },
    update(id, patch) {
      const u = this.byId(id); if (!u) throw new HttpError(404, 'not_found', 'User not found');
      validate(patch, true);
      if (patch.role && patch.role !== 'admin' && u.role === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n <= 1) throw new HttpError(409, 'last_admin', 'Keep at least one active administrator');
      if (patch.active === false && u.role === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n <= 1) throw new HttpError(409, 'last_admin', 'Keep at least one active administrator');
      db.prepare('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), dept = ?, active = COALESCE(?, active) WHERE id = ?')
        .run(patch.name ?? null, patch.role ?? null, patch.dept !== undefined ? (patch.dept || null) : u.dept, patch.active == null ? null : (patch.active ? 1 : 0), id);
      if (patch.password) db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(patch.password), id);
      return pub(this.byId(id));
    },
    authenticate(email, password) {
      const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
      // Always run a hash comparison so response time does not reveal which emails exist.
      const ok = verifyPassword(password || '', u ? u.pass_hash : 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
      if (!u || !ok || !u.active) return null;
      db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), u.id);
      return pub(u);
    },
    pub, ROLES
  };
}

module.exports = { createUsers };
