'use strict';
/**
 * HTTP layer: wires configuration, database, runtime and routes into an
 * Express app. `createApp()` is also used by the automated tests.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');

const E = require('../shared/engine.js');
const { open } = require('./db.js');
const { createStore } = require('./store.js');
const { createUsers } = require('./users.js');
const { createRuntime } = require('./runtime.js');
const { createNotifier } = require('./notify.js');
const { createCopilot } = require('./copilot.js');
const { signToken, verifyToken } = require('./auth.js');
const { securityHeaders, rateLimit, HttpError, errorHandler } = require('./security.js');

function createLogger(quiet) {
  const ts = () => new Date().toISOString();
  return {
    info: (...a) => { if (!quiet) console.log(ts(), 'INFO ', ...a); },
    warn: (...a) => { if (!quiet) console.warn(ts(), 'WARN ', ...a); },
    error: (...a) => console.error(ts(), 'ERROR', ...a)
  };
}

function createApp(cfg, { quiet = false } = {}) {
  const log = createLogger(quiet);
  if (cfg.demo) for (const f of [cfg.dbFile, cfg.dbFile + '-wal', cfg.dbFile + '-shm']) fs.rmSync(f, { force: true });
  const db = open(cfg.dbFile);
  const store = createStore(db);
  const users = createUsers(db);
  const notifier = createNotifier({ cfg, store, log });
  const runtime = createRuntime({ cfg, store, notifier, log });
  runtime.boot();
  const copilot = createCopilot({ cfg, runtime, log });

  if (cfg.demo && users.count() === 0) {
    [['Dr. Meera Iyer', 'admin@demo.local', 'admin'], ['Salma (Front desk)', 'desk@demo.local', 'desk'], ['Dr. Anil Rao', 'doctor@demo.local', 'doctor', 'CAR'], ['Joseph (ER nurse)', 'nurse@demo.local', 'nurse']]
      .forEach(([name, email, role, dept]) => users.create({ name, email, role, dept, password: 'demo1234' }));
  }

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '64kb' }));
  if (cfg.logRequests && !quiet) app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const t = Date.now();
    res.on('finish', () => log.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`));
    next();
  });

  /* ---------------- helpers ---------------- */
  const issue = u => signToken({ sub: u.id, role: u.role, name: u.name }, cfg.secret, cfg.tokenTtlHours * 3600);
  function authenticate(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.path.endsWith('/stream') ? req.query.access_token : null);
    const p = verifyToken(token, cfg.secret);
    if (!p) return next(new HttpError(401, 'unauthorized', 'Please sign in again'));
    const u = users.byId(p.sub);
    if (!u || !u.active) return next(new HttpError(401, 'unauthorized', 'This account is disabled'));
    req.user = users.pub(u);
    req.actor = { id: u.id, role: u.role, name: u.name };
    next();
  }
  const allow = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : next(new HttpError(403, 'forbidden', 'Your role cannot do this'));
  const needReady = (req, res, next) => runtime.ready ? next() : next(new HttpError(409, 'not_setup', 'Finish the setup wizard first'));
  const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  /* ---------------- health & setup ---------------- */
  app.get('/api/health', (req, res) => res.json({ ok: true, version: E.VERSION, ready: runtime.ready, demo: cfg.demo, now: runtime.clock.now(), clockRate: runtime.clock.rate }));

  app.get('/api/setup/status', (req, res) => res.json({ setupComplete: store.isSetup(), hasUsers: users.count() > 0, demo: cfg.demo, version: E.VERSION, templates: E.TEMPLATES, langs: E.LANGS }));

  app.post('/api/setup', rateLimit({ windowMs: 3600e3, max: 20, name: 'setup' }), (req, res, next) => {
    try {
      if (store.isSetup() || users.count() > 0) throw new HttpError(409, 'already_setup', 'This hospital is already set up');
      const b = req.body || {}, h = b.hospital || {}, a = b.admin || {};
      if (!h.name || String(h.name).trim().length < 2) throw new HttpError(400, 'invalid', 'Enter the hospital name');
      const depts = Array.isArray(b.depts) ? b.depts : [];
      if (!depts.length || depts.length > 20) throw new HttpError(400, 'invalid', 'Choose between 1 and 20 departments');
      const seen = new Set();
      const cleanDepts = depts.map((d, i) => {
        const id = String(d.id || '').toUpperCase();
        if (!/^[A-Z]{2,4}$/.test(id) || id === 'ER' || seen.has(id)) throw new HttpError(400, 'invalid', 'Each department needs a unique 2–4 letter code');
        seen.add(id);
        if (!E.TEMPLATES[id] && !d.name) throw new HttpError(400, 'invalid', `Name the ${id} department`);
        return { id, name: d.name ? String(d.name).slice(0, 60) : undefined, room: String(d.room || `OPD ${i + 1}`).slice(0, 30), doc: String(d.doc || 'Duty doctor').slice(0, 60), avg: d.avg ? Math.min(60, Math.max(2, Number(d.avg))) : undefined, floor: d.floor ? String(d.floor).slice(0, 80) : undefined };
      });
      const w = b.wards || {};
      const wards = ['ICU', 'GW', 'PW'].map(id => ({ id, count: Math.min(500, Math.max(0, Math.floor(Number(w[id]) || 0))) }));
      const langs = (Array.isArray(h.langs) ? h.langs : ['en']).filter(l => E.LANGS[l]);
      users.create({ name: a.name, email: a.email, role: 'admin', password: a.password }); // validates first; throws before state is written
      runtime.setup({ hospital: { name: String(h.name).trim().slice(0, 80), city: String(h.city || '').slice(0, 60), langs: langs.includes('en') ? langs : ['en', ...langs], publicCheckin: h.publicCheckin !== false }, depts: cleanDepts, wards });
      const u = users.authenticate(a.email, a.password);
      log.info(`Setup complete for ${h.name}`);
      res.status(201).json({ token: issue(u), user: u });
    } catch (e) { next(e); }
  });

  /* ---------------- auth ---------------- */
  app.post('/api/auth/login', rateLimit({ windowMs: 60e3, max: 10, name: 'login' }), (req, res, next) => {
    const u = users.authenticate(req.body && req.body.email, req.body && req.body.password);
    if (!u) return next(new HttpError(401, 'bad_credentials', 'Email or password is incorrect'));
    res.json({ token: issue(u), user: u });
  });
  app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }));

  /* ---------------- staff API ---------------- */
  const api = express.Router();
  api.use(authenticate, needReady);

  api.get('/state', (req, res) => {
    res.json({ state: runtime.engine.state, now: runtime.clock.now(), clockRate: runtime.clock.rate, user: req.user, features: { copilot: copilot.enabled, demo: cfg.demo, publicUrl: cfg.publicUrl } });
  });

  api.get('/stream', (req, res) => {
    const c = runtime.hub.addStaff(req, res);
    c.res.write(`event: hello\ndata: ${JSON.stringify({ v: runtime.engine.state.v, now: runtime.clock.now() })}\n\n`);
  });

  api.post('/commands/:name', (req, res, next) => {
    try {
      const { result, v } = runtime.exec(req.params.name, req.body || {}, req.actor);
      res.json({ ok: true, result, v, now: runtime.clock.now() });
    } catch (e) { next(e); }
  });

  api.get('/patients/search', (req, res) => {
    const qs = String(req.query.q || '').trim();
    if (qs.length < 2) return res.json({ patients: [] });
    res.json({ patients: store.searchPatients(qs.slice(0, 60)) });
  });
  api.get('/patients/:pid', (req, res, next) => {
    const p = runtime.engine.state.patients[req.params.pid];
    if (!p) return next(new HttpError(404, 'not_found', 'Patient not found'));
    res.json({ patient: p, visits: store.patientHistory(p.pid) });
  });

  api.get('/users', allow('admin'), (req, res) => res.json({ users: users.list() }));
  api.post('/users', allow('admin'), (req, res, next) => {
    try { const u = users.create(req.body || {}); store.writeAudit(req.actor, 'createUser', `Created ${u.role} account for ${u.name}`, runtime.clock.now()); res.status(201).json({ user: u }); } catch (e) { next(e); }
  });
  api.patch('/users/:id', allow('admin'), (req, res, next) => { try { const u = users.update(req.params.id, req.body || {}); store.writeAudit(req.actor, 'updateUser', `Updated account for ${u.name}`, runtime.clock.now()); res.json({ user: u }); } catch (e) { next(e); } });

  api.get('/audit', allow('admin'), (req, res) => res.json({ entries: store.auditPage(Math.min(500, Number(req.query.limit) || 100), Number(req.query.before) || null) }));

  api.get('/export/visits.csv', allow('admin'), (req, res) => {
    const today = E.dayKey(runtime.clock.now());
    const from = /^\d{8}$/.test(req.query.from) ? req.query.from : today, to = /^\d{8}$/.test(req.query.to) ? req.query.to : today;
    const st = runtime.engine.state;
    const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""') + '"' : s; };
    const rows = [['date', 'token', 'mrn', 'patient', 'department', 'priority', 'esi', 'arrived', 'called', 'finished', 'wait_min', 'consult_min', 'status', 'outcome', 'source']];
    for (const v of store.visitsBetween(from, to)) {
      const d = E.dept(st, v.dept);
      rows.push([v.day, v.tok, v.pid, v.name, d ? d.name : v.dept, v.pri ? 'yes' : '', v.esi || '', E.hhmm(v.arrived), v.start ? E.hhmm(v.start) : '', v.end ? E.hhmm(v.end) : '', v.start ? E.mins(v.arrived, v.start) : '', v.start && v.end ? E.mins(v.start, v.end) : '', v.status, v.outcome || '', v.src || '']);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="raycare-visits-${from}-${to}.csv"`);
    res.send('﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n'));
  });

  api.post('/copilot', rateLimit({ windowMs: 60e3, max: 20, name: 'copilot' }), async (req, res, next) => {
    if (!copilot.enabled) return next(new HttpError(501, 'copilot_off', 'Set ANTHROPIC_API_KEY to enable the AI Copilot'));
    const msgs = (Array.isArray(req.body && req.body.messages) ? req.body.messages : []).filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length <= 4000);
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return next(new HttpError(400, 'invalid', 'Send at least one user message'));
    try { res.json(await copilot.chat(msgs, req.actor)); } catch (e) { next(e.status ? new HttpError(e.status, 'copilot_error', e.message) : e); }
  });

  app.use('/api', (req, res, next) => (/^\/(state|stream|commands|patients|users|audit|export|copilot)/.test(req.path) ? api(req, res, next) : next()));

  /* ---------------- public API (no login) ---------------- */
  app.get('/api/public/info', needReady, (req, res) => {
    const st = runtime.engine.state;
    res.json({ hospital: { name: st.hospital.name, city: st.hospital.city, langs: st.hospital.langs, publicCheckin: st.hospital.publicCheckin }, depts: E.opdDepts(st).map(d => ({ id: d.id, name: d.name, room: d.room, open: d.open, color: d.color, wait: E.newWait(st, d.id, runtime.clock.now()) })) });
  });
  app.get('/api/public/board', needReady, (req, res) => res.json(E.board(runtime.engine.state, runtime.clock.now())));
  app.get('/api/public/stream', needReady, (req, res) => {
    const c = runtime.hub.addPublic(req, res);
    c.res.write(`event: board\ndata: ${JSON.stringify(E.board(runtime.engine.state, runtime.clock.now()))}\n\n`);
  });

  app.post('/api/public/checkin', needReady, rateLimit({ windowMs: 10 * 60e3, max: 6, name: 'checkin' }), (req, res, next) => {
    try {
      const st = runtime.engine.state;
      if (!st.hospital.publicCheckin) throw new HttpError(403, 'disabled', 'Self check-in is turned off. Please visit the registration desk.');
      const b = req.body || {};
      if (!/^\d{10}$/.test(String(b.phone || '').replace(/\D/g, '').slice(-10))) throw new HttpError(400, 'invalid', 'Enter a 10-digit mobile number');
      if (!b.consent) throw new HttpError(400, 'consent', 'Please agree to receive visit updates');
      const { result } = runtime.exec('registerPatient', { name: b.name, phone: b.phone, dept: b.dept, lang: b.lang, age: b.age, source: 'Checked in by QR' }, { role: 'system', name: 'QR self check-in' });
      res.status(201).json({ ...result, trackUrl: `/t/?v=${encodeURIComponent(result.id)}&k=${result.trackKey}` });
    } catch (e) { next(e); }
  });

  function visitFor(req) {
    const v = runtime.engine.state.visits[req.params.id];
    if (!v || !safeEq(req.query.k, v.trackKey)) throw new HttpError(404, 'not_found', 'This tracking link is not valid or has expired');
    return v;
  }
  app.get('/api/public/visit/:id', needReady, rateLimit({ windowMs: 60e3, max: 120, name: 'track' }), (req, res, next) => {
    try {
      const v = visitFor(req), st = runtime.engine.state, now = runtime.clock.now(), d = E.dept(st, v.dept), e = E.eta(st, v.id, now);
      const cur = st.serving[v.dept] && st.visits[st.serving[v.dept]];
      res.json({ hospital: st.hospital.name, langs: st.hospital.langs, tok: v.tok, firstName: v.name.split(' ')[0], dept: d.name, room: d.room, floor: d.floor, color: d.color, status: v.status, position: e.pos, etaMin: e.mins, nowServing: cur ? cur.tok : null, outcome: v.status === 'done' ? v.outcome : null, lang: v.lang, lateLeft: 2 - (v.lateCount || 0), rated: !!st.feedback.find(f => f.visitId === v.id), now });
    } catch (e) { next(e); }
  });
  app.post('/api/public/visit/:id/late', needReady, rateLimit({ windowMs: 60e3, max: 10, name: 'late' }), (req, res, next) => {
    try { const v = visitFor(req); res.json(runtime.exec('runningLate', { id: v.id }, { role: 'patient', name: 'Patient (' + v.tok + ')' }).result); } catch (e) { next(e); }
  });
  app.post('/api/public/visit/:id/feedback', needReady, rateLimit({ windowMs: 60e3, max: 10, name: 'fb' }), (req, res, next) => {
    try { const v = visitFor(req); res.json(runtime.exec('submitFeedback', { id: v.id, stars: req.body && req.body.stars, text: req.body && req.body.text }, { role: 'patient', name: 'Patient (' + v.tok + ')' }).result); } catch (e) { next(e); }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such API endpoint' } }));

  /* ---------------- static pages ---------------- */
  const noCacheHtml = { setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } };
  if (!cfg.serveWebsite) app.get(['/', '/index.html'], (req, res) => res.redirect(302, '/app/'));
  app.use('/shared', express.static(path.join(cfg.root, 'shared'), { maxAge: '1h' }));
  app.use(express.static(path.join(cfg.root, 'public'), { extensions: ['html'], ...noCacheHtml }));
  app.use((req, res) => res.status(404).sendFile(path.join(cfg.root, 'public', '404.html')));
  app.use(errorHandler(log));

  return { app, runtime, db, users, store, log, close() { runtime.stop(); db.close(); } };
}

module.exports = { createApp };
