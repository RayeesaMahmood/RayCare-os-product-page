/*!
 * RayCare demo simulator — generates a realistic hospital day on top of the
 * engine. Used by the offline browser demo and by `npm run demo`.
 * It only ever talks to the engine through `dispatch`, exactly like staff do.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.RayCareSimulator = factory(root.RayCareEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
  'use strict';
  const MIN = E.MIN;
  const FIRST = ['Lakshmi', 'Arjun', 'Fatima', 'Ravi', 'Sneha', 'Imran', 'Priya', 'Vikram', 'Anjali', 'Kiran', 'Meena', 'Suresh', 'Ayesha', 'Rahul', 'Divya', 'Mohan', 'Nazia', 'Harish', 'Swathi', 'Gopal', 'Zoya', 'Venkat', 'Pooja', 'Abdul', 'Keerthi', 'Naveen', 'Rekha', 'Salim', 'Bhavya', 'Tarun', 'Hema', 'Faisal'];
  const LAST = ['Kumar', 'Reddy', 'Shaik', 'Rao', 'Naidu', 'Khan', 'Sharma', 'Varma', 'Iyer', 'Gupta', 'Patel', 'Das', 'Menon', 'Pillai', 'Joshi', 'Ali'];
  const COMMENTS = {
    5: ['Knew exactly when to walk in. No crowding.', 'The SMS in Telugu helped my mother a lot.', 'Waited in the canteen and came back on time.', 'Very smooth visit.'],
    4: ['Clear directions to the room.', 'Estimate was close. Good system.', 'Registration was quick.'],
    3: ['Estimate was a bit off but okay.', 'Consult took longer than shown.'],
    2: ['Waited longer than the estimate.', 'Too crowded near the cardiology room.'],
    1: ['Called while I was at the pharmacy.']
  };

  const DEMO_CONFIG = {
    hospital: { name: 'Sunrise Multispeciality', city: 'Hyderabad', langs: ['en', 'hi', 'te'], setupComplete: true },
    depts: [
      { id: 'GEN', room: 'OPD 1', doc: 'Dr. Pranav Reddy', floor: 'Ground floor, left of registration' },
      { id: 'PED', room: 'OPD 3', doc: 'Dr. Farah Khan', floor: 'Ground floor, follow the purple line' },
      { id: 'CAR', room: 'OPD 4', doc: 'Dr. Anil Rao', floor: 'Ground floor, follow the pink line' },
      { id: 'DER', room: 'OPD 5', doc: 'Dr. Kavya Iyer', floor: 'Ground floor, next to the lab' },
      { id: 'ORT', room: 'OPD 6', doc: 'Dr. Sunil Menon', floor: 'Ground floor, end of the corridor' }
    ],
    wards: [{ id: 'ICU', count: 8 }, { id: 'GW', count: 16 }, { id: 'PW', count: 10 }]
  };

  function createSimulator(engine, rng) {
    rng = rng || Math.random;
    const st = engine.state;
    const pick = a => a[Math.floor(rng() * a.length)];
    const name = () => pick(FIRST) + ' ' + pick(LAST);
    const phone = () => '9' + String(Math.floor(rng() * 1e9)).padStart(9, '0');
    const desk = { role: 'desk', name: 'Salma (Front desk)' };
    const nurse = { role: 'nurse', name: 'Joseph (ER nurse)' };
    const dur = {};
    const manual = new Set(); // rooms a human is driving in the demo
    const run = (cmd, p, actor, now) => { try { return engine.dispatch(cmd, p, actor, now); } catch (e) { return null; } };

    function step(now) {
      // Doctors finish and call.
      st.depts.forEach(d => {
        if (!d.open || manual.has(d.id)) return;
        const doc = { role: 'doctor', name: d.doc };
        const curId = st.serving[d.id], cur = curId && st.visits[curId];
        if (cur && cur.status === 'serving') {
          if (!dur[cur.id]) dur[cur.id] = E.pace(st, d.id, now) * (0.6 + rng() * 0.8);
          if (now - cur.start >= dur[cur.id] * MIN) {
            const outcome = d.id === 'ER' ? pick(['Discharged home', 'Admit', 'Imaging ordered', 'Discharged home']) : pick(['Prescription issued', 'Prescription issued', 'Lab tests ordered', 'Follow-up in 2 weeks', 'Imaging ordered', 'Discharged home', rng() < 0.08 ? 'Admit' : 'Prescription issued']);
            run('completeVisit', { dept: d.id, outcome, callNext: true }, d.id === 'ER' ? { role: 'doctor', name: 'ER team' } : doc, now);
            if (d.id !== 'ER' && rng() < 0.55) {
              const w = (cur.start - cur.arrived) / MIN;
              const stars = w < 20 ? pick([5, 5, 5, 4]) : w < 40 ? pick([4, 4, 5, 3]) : pick([3, 2, 4, 3]);
              run('submitFeedback', { id: cur.id, stars, text: pick(COMMENTS[stars]) }, { role: 'patient', name: 'Patient' }, now);
            }
          }
        } else if (E.waiting(st, d.id).length) run('callNext', { dept: d.id }, d.id === 'ER' ? nurse : doc, now);
      });
      // Walk-ins.
      const hr = new Date(now).getHours();
      const busy = (E.PROFILE[hr] || 0.2);
      if (rng() < 0.6 * busy + 0.03) {
        const W = { GEN: 2.3, PED: 1.9, CAR: 0.6, DER: 1.1, ORT: 1.3 };
        const weights = E.opdDepts(st).filter(d => d.open).map(d => [d.id, W[d.id] || 1.2]);
        const tot = weights.reduce((a, b) => a + b[1], 0); let r = rng() * tot, id = weights[0] && weights[0][0];
        for (const [k, w] of weights) { if ((r -= w) <= 0) { id = k; break; } }
        if (id && E.waiting(st, id).length < 14) run('registerPatient', { name: name(), phone: phone(), age: 2 + Math.floor(rng() * 75), sex: pick(['F', 'M']), dept: id, lang: pick(['en', 'en', 'hi', 'te']), priority: rng() < 0.1, source: pick(['Checked in by QR', 'Checked in at kiosk', 'Registered at desk']) }, desk, now);
      }
      // Emergency walk-ins and ambulances.
      if (rng() < 0.05 && E.waiting(st, 'ER').length < 5) {
        const c = pick(['fever', 'minor', 'abdo', 'trauma', 'chest', 'rx', 'fever']);
        run('triage', { name: name(), age: 5 + Math.floor(rng() * 70), complaint: c, spo2: 90 + Math.floor(rng() * 10), hr: 70 + Math.floor(rng() * 55), bp: 100 + Math.floor(rng() * 70), avpu: 'A', pain: Math.floor(rng() * 9) }, nurse, now);
      }
      if (rng() < 0.03 && E.inboundAmbulances(st).length < 2) {
        const c = pick([['Road traffic accident, 2 injured', 2], ['Chest pain, 64 M', 2], ['Unconscious, 51 F', 1], ['Fall from height, 30 M', 2], ['Breathing difficulty, 7 F', 2], ['Burns, 40 M', 2]]);
        run('ambulancePreAlert', { from: pick(['108 · Gachibowli', '108 · Kukatpally', 'Private · Madhapur', '108 · LB Nagar']), complaint: c[0], esi: c[1], etaMin: 6 + Math.floor(rng() * 10) }, { role: 'system', name: '108 dispatch' }, now);
      }
      // Appointments arriving near their slot.
      st.appts.forEach(a => { if (a.status === 'booked' && now >= a.t - 10 * MIN && now <= a.t + 10 * MIN && rng() < 0.35) run('checkInAppointment', { slotId: a.id }, desk, now); });
      // Wards.
      if (rng() < 0.2 && E.openBedReqs(st).length) run('assignBed', {}, nurse, now);
      if (rng() < 0.03) { const b = st.beds.filter(x => x.status === 'occupied'); if (b.length) run('dischargeBed', { bedId: pick(b).id }, nurse, now); }
      engine.tick(now);
    }

    /* Fill the day so far so the demo opens mid-shift. */
    function fastForward(from, to) {
      for (let t = from; t <= to; t += 2 * MIN) step(t);
    }
    return { step, fastForward, manual };
  }

  /* Build a ready-to-run demo hospital at `now`. */
  function createDemo(now, rng) {
    rng = rng || Math.random;
    const state = E.createState(DEMO_CONFIG);
    state.hospital.createdAt = now;
    const engine = E.createEngine(state, { rng });
    engine.ensureSlots(now);
    const pick = a => a[Math.floor(rng() * a.length)];
    // Wards start mostly full, as they would mid-morning.
    state.beds.forEach(b => {
      const r = rng();
      if (r < 0.72) { b.status = 'occupied'; b.name = pick(FIRST) + ' ' + pick(LAST); b.since = now - Math.floor(rng() * 72) * 60 * MIN; }
      else if (r < 0.8) { b.status = 'cleaning'; b.since = now - Math.floor(rng() * 15) * MIN; }
    });
    // About 60% of appointment slots are booked in advance.
    const desk = { role: 'desk', name: 'Online booking' };
    const early = E.atMinute(now, 7 * 60);
    state.appts.forEach(a => { if (rng() < 0.6) { try { engine.dispatch('bookAppointment', { slotId: a.id, name: pick(FIRST) + ' ' + pick(LAST), phone: '9' + String(Math.floor(rng() * 1e9)).padStart(9, '0') }, desk, early); } catch (e) { /* ignore */ } } });
    const sim = createSimulator(engine, rng);
    const start = E.atMinute(now, 8 * 60);
    if (now > start) sim.fastForward(start, now);
    // Keep the history but start the demo with a clean alert tray.
    state.alerts.forEach((a, i) => { if (i > 4) a.read = true; });
    engine.takeDelta(now);
    return { state, engine, sim };
  }

  return { createSimulator, createDemo, DEMO_CONFIG };
});
