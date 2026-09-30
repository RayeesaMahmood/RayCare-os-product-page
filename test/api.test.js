'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../server/config.js');
const { createApp } = require('../server/app.js');

let server, base, ctx;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raycare-test-'));

test.before(async () => {
  const cfg = build({ DATA_DIR: dir, DEMO_MODE: 'false', JWT_SECRET: 'x'.repeat(40), NOTIFY_PROVIDER: 'none', PORT: '0' });
  ctx = createApp(cfg, { quiet: true });
  await new Promise(r => { server = ctx.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (method, url, body, token) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
};

let admin, desk;

test('fresh install reports setup needed', async () => {
  const r = await call('GET', '/api/setup/status');
  assert.equal(r.body.setupComplete, false);
  assert.equal((await call('GET', '/api/public/board')).status, 409);
});

test('setup wizard validates and creates the hospital and admin', async () => {
  const bad = await call('POST', '/api/setup', { hospital: { name: 'X' }, depts: [], admin: {} });
  assert.equal(bad.status, 400);
  const r = await call('POST', '/api/setup', {
    hospital: { name: 'Test General Hospital', city: 'Hyderabad', langs: ['en', 'te'] },
    depts: [{ id: 'GEN', room: 'OPD 1', doc: 'Dr. One' }, { id: 'CAR', room: 'OPD 2', doc: 'Dr. Two' }],
    wards: { ICU: 2, GW: 4, PW: 0 },
    admin: { name: 'Admin Person', email: 'admin@test.in', password: 'correct-horse' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  admin = r.body.token;
  assert.equal((await call('POST', '/api/setup', { hospital: { name: 'Again' } })).status, 409);
});

test('login rejects bad passwords and accepts good ones', async () => {
  assert.equal((await call('POST', '/api/auth/login', { email: 'admin@test.in', password: 'nope' })).status, 401);
  const r = await call('POST', '/api/auth/login', { email: 'admin@test.in', password: 'correct-horse' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'admin');
});

test('staff API requires a valid token', async () => {
  assert.equal((await call('GET', '/api/state')).status, 401);
  assert.equal((await call('GET', '/api/state', null, 'forged.token.here')).status, 401);
  const r = await call('GET', '/api/state', null, admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.state.hospital.name, 'Test General Hospital');
  assert.equal(r.body.state.beds.length, 6);
});

test('admin creates a desk account; desk cannot manage users', async () => {
  const c = await call('POST', '/api/users', { name: 'Desk One', email: 'desk@test.in', role: 'desk', password: 'desk-password' }, admin);
  assert.equal(c.status, 201);
  desk = (await call('POST', '/api/auth/login', { email: 'desk@test.in', password: 'desk-password' })).body.token;
  assert.equal((await call('GET', '/api/users', null, desk)).status, 403);
  assert.equal((await call('POST', '/api/commands/updateSettings', { name: 'Hacked' }, desk)).status, 403);
});

test('commands run, persist and survive a restart', async () => {
  const r = await call('POST', '/api/commands/registerPatient', { name: 'Anita Sharma', phone: '9876543210', dept: 'GEN', lang: 'te' }, desk);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.tok, 'G-101');
  const bad = await call('POST', '/api/commands/registerPatient', { name: '', dept: 'GEN' }, desk);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /Name/);
  const row = ctx.db.prepare('SELECT status FROM visits WHERE tok = ?').get('G-101');
  assert.equal(row.status, 'waiting');
  const reloaded = ctx.store.load(Date.now());
  assert.equal(Object.values(reloaded.visits).length, 1);
});

test('public board never exposes patient names', async () => {
  await call('POST', '/api/commands/callNext', { dept: 'GEN' }, desk);
  const r = await call('GET', '/api/public/board');
  assert.equal(r.status, 200);
  assert.equal(r.body.rows.find(x => x.id === 'GEN').serving, 'G-101');
  assert.ok(!JSON.stringify(r.body).includes('Anita'));
});

test('tracking links need the secret key', async () => {
  const st = (await call('GET', '/api/state', null, admin)).body.state;
  const v = Object.values(st.visits)[0];
  assert.equal((await call('GET', `/api/public/visit/${encodeURIComponent(v.id)}?k=wrong`)).status, 404);
  const ok = await call('GET', `/api/public/visit/${encodeURIComponent(v.id)}?k=${v.trackKey}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tok, 'G-101');
  assert.equal(ok.body.firstName, 'Anita');
});

test('QR self check-in validates phone and consent', async () => {
  assert.equal((await call('POST', '/api/public/checkin', { name: 'Walk In', phone: '123', dept: 'CAR', consent: true })).status, 400);
  assert.equal((await call('POST', '/api/public/checkin', { name: 'Walk In', phone: '9123456780', dept: 'CAR' })).status, 400);
  const r = await call('POST', '/api/public/checkin', { name: 'Walk In', phone: '9123456780', dept: 'CAR', consent: true, lang: 'en' });
  assert.equal(r.status, 201);
  assert.match(r.body.trackUrl, /^\/t\/\?v=/);
});

test('audit log and CSV export are admin-only and record actions', async () => {
  const a = await call('GET', '/api/audit', null, admin);
  assert.ok(a.body.entries.some(e => e.action === 'registerPatient'));
  assert.equal((await call('GET', '/api/export/visits.csv', null, desk)).status, 403);
  const csv = await call('GET', '/api/export/visits.csv', null, admin);
  assert.equal(csv.status, 200);
  assert.match(csv.body, /Anita Sharma/);
});

test('security headers are set', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'"));
});
