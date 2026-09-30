'use strict';
/**
 * Store — moves engine state in and out of SQLite.
 *
 * The engine keeps today's working set in memory (fast, simple, no race
 * conditions: Node runs one command at a time). After every command the
 * runtime asks the engine for a delta of changed entities and this module
 * writes exactly those rows inside one transaction. History stays in the
 * database for records, search and CSV export.
 */
const E = require('../shared/engine.js');
const { tx } = require('./db.js');

const META_KEYS = ['hospital', 'depts', 'wardNames', 'counters', 'serving', 'recall', 'codeBlue', 'lastCalls'];
const clean = o => { const c = { ...o }; delete c._removed; return c; };
const J = JSON.stringify;

function createStore(db) {
  const q = {
    meta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    visit: db.prepare(`INSERT INTO visits (id, day, tok, dept, pid, status, arrived, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, dept = excluded.dept, data = excluded.data`),
    patient: db.prepare(`INSERT INTO patients (pid, name, phone, abha, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(pid) DO UPDATE SET name = excluded.name, phone = excluded.phone, abha = excluded.abha, data = excluded.data, updated_at = excluded.updated_at`),
    bed: db.prepare('INSERT INTO beds (id, ward, status, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data'),
    bedReq: db.prepare('INSERT INTO bed_requests (id, status, at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data'),
    amb: db.prepare('INSERT INTO ambulances (id, status, at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data'),
    appt: db.prepare('INSERT INTO appointments (id, day, dept, t, status, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data'),
    fb: db.prepare('INSERT INTO feedback (id, visit_id, stars, t, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET stars = excluded.stars, data = excluded.data'),
    alert: db.prepare('INSERT INTO alerts (id, t, level, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
    audit: db.prepare('INSERT INTO audit_log (t, actor, role, action, text) VALUES (?, ?, ?, ?, ?)')
  };

  function isSetup() {
    const r = db.prepare("SELECT value FROM meta WHERE key = 'hospital'").get();
    return !!(r && JSON.parse(r.value).setupComplete);
  }

  /* Rebuild the engine's working state for `now` from the database. */
  function load(now) {
    const st = E.createState({ depts: [], wards: [] });
    st.beds = []; st.depts = [];
    for (const r of db.prepare('SELECT key, value FROM meta').all()) if (META_KEYS.includes(r.key)) st[r.key] = JSON.parse(r.value);
    const today = E.dayKey(now);
    for (const r of db.prepare("SELECT data FROM visits WHERE day = ? OR status IN ('waiting','serving')").all(today)) { const v = JSON.parse(r.data); st.visits[v.id] = v; }
    for (const r of db.prepare('SELECT data FROM patients').all()) { const p = JSON.parse(r.data); st.patients[p.pid] = p; }
    st.beds = db.prepare('SELECT data FROM beds ORDER BY id').all().map(r => JSON.parse(r.data));
    st.bedReqs = db.prepare("SELECT data FROM bed_requests WHERE status = 'open' OR at > ? ORDER BY at DESC").all(now - 86400000).map(r => JSON.parse(r.data));
    st.ambulances = db.prepare("SELECT data FROM ambulances WHERE status = 'inbound' OR at > ? ORDER BY at DESC").all(now - 86400000).map(r => JSON.parse(r.data));
    st.appts = db.prepare('SELECT data FROM appointments WHERE day >= ? ORDER BY t').all(today).map(r => JSON.parse(r.data));
    st.feedback = db.prepare('SELECT data FROM feedback ORDER BY t DESC LIMIT 500').all().map(r => JSON.parse(r.data));
    st.alerts = db.prepare('SELECT data FROM alerts ORDER BY t DESC, id DESC LIMIT 80').all().map(r => JSON.parse(r.data));
    st.audit = db.prepare('SELECT t, actor AS who, role, action, text FROM audit_log ORDER BY id DESC LIMIT 200').all().map(r => ({ ...r }));
    return st;
  }

  function writeDelta(d) {
    if (!d) return;
    const now = Date.now();
    if (d.meta) for (const k of META_KEYS) if (k in d.meta) q.meta.run(k, J(d.meta[k] ?? null));
    for (const v of d.visits || []) { if (!v.day) continue; const c = clean(v); q.visit.run(c.id, c.day, c.tok, c.dept, c.pid, c.status, c.arrived, J(c)); }
    for (const p of d.patients || []) q.patient.run(p.pid, p.name, p.phone || null, p.abha || null, J(p), now);
    for (const b of d.beds || []) if (!b._removed) q.bed.run(b.id, b.ward, b.status, J(clean(b)));
    for (const r of d.bedReqs || []) if (!r._removed) q.bedReq.run(r.id, r.status, r.at, J(clean(r)));
    for (const a of d.ambulances || []) if (!a._removed) q.amb.run(a.id, a.status, a.at || 0, J(clean(a)));
    for (const a of d.appts || []) if (!a._removed) q.appt.run(a.id, a.day, a.dept, a.t, a.status, J(clean(a)));
    for (const f of d.feedback || []) if (!f._removed) q.fb.run(f.id, f.visitId, f.stars, f.t, J(clean(f)));
    for (const a of d.alerts || []) if (!a._removed) q.alert.run(a.id, a.t, a.level, J(clean(a)));
    for (const a of (d.audit || []).slice().reverse()) q.audit.run(a.t, a.who, a.role, a.action, a.text);
  }

  function persist(delta) { if (delta) tx(db, () => writeDelta(delta)); }

  /* Write a whole state (first-run setup and demo seeding). */
  function saveFull(st) {
    tx(db, () => writeDelta({
      meta: Object.fromEntries(META_KEYS.map(k => [k, st[k]])),
      visits: Object.values(st.visits), patients: Object.values(st.patients), beds: st.beds, bedReqs: st.bedReqs,
      ambulances: st.ambulances, appts: st.appts, feedback: st.feedback, alerts: st.alerts, audit: st.audit
    }));
  }

  /* ---- read models for history (beyond today's working set) ---- */
  function searchPatients(qs, limit = 25) {
    const like = '%' + qs.replace(/[%_]/g, '') + '%';
    const digits = qs.replace(/\D/g, '');
    const rows = db.prepare(`SELECT data FROM patients WHERE name LIKE ? COLLATE NOCASE OR pid LIKE ? ${digits.length >= 4 ? 'OR phone LIKE ? OR abha LIKE ?' : ''} ORDER BY updated_at DESC LIMIT ?`)
      .all(...(digits.length >= 4 ? [like, like, '%' + digits + '%', '%' + digits + '%', limit] : [like, like, limit]));
    return rows.map(r => JSON.parse(r.data));
  }
  function patientHistory(pid) {
    return db.prepare('SELECT data FROM visits WHERE pid = ? ORDER BY arrived DESC LIMIT 50').all(pid).map(r => JSON.parse(r.data));
  }
  function visitsBetween(fromDay, toDay) {
    return db.prepare('SELECT data FROM visits WHERE day BETWEEN ? AND ? ORDER BY arrived').all(fromDay, toDay).map(r => JSON.parse(r.data));
  }
  function auditPage(limit = 100, beforeId) {
    return beforeId
      ? db.prepare('SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit)
      : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  }
  function logNotification(n) {
    db.prepare('INSERT INTO notifications (t, visit_id, channel, recipient, kind, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(n.t, n.visitId || null, n.channel, n.recipient || null, n.kind, n.status, n.detail || null);
  }

  function writeAudit(actor, action, text, t) { q.audit.run(t, actor.name, actor.role, action, text); }

  return { writeAudit, isSetup, load, persist, saveFull, searchPatients, patientHistory, visitsBetween, auditPage, logNotification };
}

module.exports = { createStore };
