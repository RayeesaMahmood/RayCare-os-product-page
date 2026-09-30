'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../shared/engine.js');
const Sim = require('../shared/simulator.js');

const NOW = E.atMinute(Date.UTC(2026, 8, 29, 5, 0), 10 * 60);
const desk = { role: 'desk', name: 'Desk' };
const doctor = { role: 'doctor', name: 'Doctor' };
const nurse = { role: 'nurse', name: 'Nurse' };

function fresh() {
  const st = E.createState({ hospital: { name: 'Test Hospital', setupComplete: true }, depts: [{ id: 'GEN', room: 'OPD 1', doc: 'Dr. A' }, { id: 'CAR', room: 'OPD 2', doc: 'Dr. B' }], wards: [{ id: 'ICU', count: 2 }, { id: 'GW', count: 2 }] });
  const eng = E.createEngine(st, { rng: () => 0.5 });
  return { st, eng };
}
const reg = (eng, name, extra = {}, t = NOW) => eng.dispatch('registerPatient', { name, dept: 'GEN', ...extra }, desk, t);

test('tokens are issued in order and restart each day', () => {
  const { eng } = fresh();
  assert.equal(reg(eng, 'A').tok, 'G-101');
  assert.equal(reg(eng, 'B').tok, 'G-102');
  assert.equal(reg(eng, 'C', {}, NOW + 86400000).tok, 'G-101');
});

test('priority patients go ahead of walk-ins but never ahead of emergencies', () => {
  const { st, eng } = fresh();
  reg(eng, 'Walk', {}, NOW);
  reg(eng, 'Senior', { priority: true }, NOW + 60000);
  const order = E.waiting(st, 'GEN').map(v => v.name);
  assert.deepEqual(order, ['Senior', 'Walk']);
});

test('ETA uses position and consult pace', () => {
  const { st, eng } = fresh();
  const a = reg(eng, 'A'); const b = reg(eng, 'B');
  assert.equal(E.eta(st, a.id, NOW).pos, 1);
  assert.equal(E.eta(st, b.id, NOW).mins, 6); // GEN template average is 6 minutes
  eng.dispatch('callNext', { dept: 'GEN' }, doctor, NOW);
  assert.equal(E.eta(st, b.id, NOW + 60000).mins, 5); // one minute into A's consult
});

test('a patient cannot be queued twice in the same department', () => {
  const { eng } = fresh();
  reg(eng, 'Ravi Kumar', { phone: '9876543210' });
  assert.throws(() => reg(eng, 'Ravi Kumar', { phone: '9876543210' }), e => e.code === 'duplicate');
});

test('returning patients are matched by phone and name', () => {
  const { st, eng } = fresh();
  const a = reg(eng, 'Ravi Kumar', { phone: '9876543210' });
  eng.dispatch('registerPatient', { name: 'Ravi Kumar', phone: '+91 98765 43210', dept: 'CAR' }, desk, NOW);
  assert.equal(Object.keys(st.patients).length, 1);
  assert.equal(st.patients[st.visits[a.id].pid].visits.length, 2);
});

test('roles are enforced', () => {
  const { eng } = fresh();
  assert.throws(() => eng.dispatch('updateSettings', { name: 'X' }, desk, NOW), e => e.code === 'forbidden');
  assert.throws(() => eng.dispatch('assignBed', {}, desk, NOW), e => e.code === 'forbidden');
});

test('input is validated', () => {
  const { eng } = fresh();
  assert.throws(() => reg(eng, ''), e => e.code === 'invalid');
  assert.throws(() => reg(eng, 'x'.repeat(200)), e => e.code === 'invalid');
  assert.throws(() => eng.dispatch('registerPatient', { name: 'A', dept: 'NOPE' }, desk, NOW), e => e.code === 'not_found');
});

test('triage suggests the right ESI level', () => {
  assert.equal(E.triage({ avpu: 'U' }).level, 1);
  assert.equal(E.triage({ complaint: 'minor', spo2: 85 }).level, 1);
  assert.equal(E.triage({ complaint: 'chest', spo2: 97, hr: 80 }).level, 2);
  assert.equal(E.triage({ complaint: 'abdo', spo2: 98, hr: 80, pain: 4 }).level, 3);
  assert.equal(E.triage({ complaint: 'fever', age: 30, spo2: 98, hr: 80 }).level, 4);
  assert.equal(E.triage({ complaint: 'rx', spo2: 99, hr: 70 }).level, 5);
});

test('emergency queue is ordered by acuity, then arrival', () => {
  const { st, eng } = fresh();
  eng.dispatch('triage', { name: 'Minor', complaint: 'minor', spo2: 98, hr: 80 }, nurse, NOW);
  eng.dispatch('triage', { name: 'Chest', complaint: 'chest', spo2: 97, hr: 80 }, nurse, NOW + 60000);
  assert.deepEqual(E.waiting(st, 'ER').map(v => v.name), ['Chest', 'Minor']);
  assert.ok(st.alerts.some(a => a.title.includes('ESI 2')));
});

test('running late moves a patient back three places, twice at most', () => {
  const { st, eng } = fresh();
  const ids = ['A', 'B', 'C', 'D', 'E'].map((n, i) => reg(eng, n, {}, NOW + i * 1000).id);
  eng.dispatch('runningLate', { id: ids[0] }, { role: 'patient', name: 'P' }, NOW + 9000);
  assert.deepEqual(E.waiting(st, 'GEN').map(v => v.name), ['B', 'C', 'D', 'A', 'E']);
  eng.dispatch('runningLate', { id: ids[0] }, { role: 'patient', name: 'P' }, NOW + 9000);
  assert.throws(() => eng.dispatch('runningLate', { id: ids[0] }, { role: 'patient', name: 'P' }, NOW + 9000), e => e.code === 'limit');
});

test('admit creates a bed request that can be assigned and discharged', () => {
  const { st, eng } = fresh();
  reg(eng, 'A');
  eng.dispatch('callNext', { dept: 'GEN' }, doctor, NOW);
  eng.dispatch('completeVisit', { dept: 'GEN', outcome: 'Admit' }, doctor, NOW + 300000);
  assert.equal(E.openBedReqs(st).length, 1);
  const r = eng.dispatch('assignBed', {}, nurse, NOW + 400000);
  assert.equal(r.bed, 'A-01');
  eng.dispatch('dischargeBed', { bedId: 'A-01' }, nurse, NOW + 500000);
  assert.equal(st.beds.find(b => b.id === 'A-01').status, 'cleaning');
  eng.tick(NOW + 500000 + 21 * 60000);
  assert.equal(st.beds.find(b => b.id === 'A-01').status, 'free');
});

test('referral finishes the visit and queues the patient elsewhere with priority', () => {
  const { st, eng } = fresh();
  reg(eng, 'A'); reg(eng, 'Walk', { dept: 'CAR' });
  eng.dispatch('callNext', { dept: 'GEN' }, doctor, NOW);
  const r = eng.dispatch('completeVisit', { dept: 'GEN', referTo: 'CAR' }, doctor, NOW + 60000);
  assert.equal(r.referred, 'C-102');
  assert.equal(E.waiting(st, 'CAR')[0].name, 'A');
});

test('ambulance pre-alert turns into an ER visit on arrival', () => {
  const { st, eng } = fresh();
  eng.dispatch('ambulancePreAlert', { from: '108', complaint: 'RTA', esi: 2, etaMin: 5 }, nurse, NOW);
  eng.tick(NOW + 4 * 60000);
  assert.equal(E.waiting(st, 'ER').length, 0);
  eng.tick(NOW + 5 * 60000);
  assert.equal(E.waiting(st, 'ER').length, 1);
  assert.equal(E.inboundAmbulances(st).length, 0);
});

test('deltas rebuild the same state on a client', () => {
  const { st, eng } = fresh();
  const client = JSON.parse(JSON.stringify(st));
  eng.takeDelta(NOW);
  reg(eng, 'A'); reg(eng, 'B');
  eng.dispatch('callNext', { dept: 'GEN' }, doctor, NOW);
  E.applyDelta(client, eng.takeDelta(NOW));
  assert.deepEqual(Object.keys(client.visits).sort(), Object.keys(st.visits).sort());
  assert.equal(client.serving.GEN, st.serving.GEN);
  assert.equal(eng.takeDelta(NOW), null);
});

test('the demo simulator produces a busy, consistent morning', () => {
  const { state } = Sim.createDemo(NOW, (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })());
  const s = E.stats(state, NOW);
  assert.ok(s.served > 20, 'patients were seen');
  for (const d of state.depts) {
    const serving = Object.values(state.visits).filter(v => v.dept === d.id && v.status === 'serving');
    assert.ok(serving.length <= 1, `${d.id} has at most one patient in consult`);
  }
});
