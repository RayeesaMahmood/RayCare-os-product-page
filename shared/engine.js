/*!
 * RayCare engine — the single source of truth for queue, triage, bed and
 * appointment logic. Pure JavaScript, no dependencies.
 *
 * The same file runs in two places:
 *   - on the server (Node.js), wrapped with persistence, auth and realtime
 *   - in the browser, for the offline demo mode
 *
 * Every change goes through `engine.dispatch(command, payload, actor, now)`.
 * The engine records what changed; `engine.takeDelta()` returns those
 * entities so the server can persist them and stream them to clients, and
 * `applyDelta(state, delta)` merges them into a client-side copy.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RayCareEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN = 60000;
  const VERSION = '2.0.0';

  /* ------------------------------------------------------------------ *
   * Reference data
   * ------------------------------------------------------------------ */
  const TEMPLATES = {
    GEN: { name: 'General Medicine', pre: 'G', avg: 6, color: '#3B6FF5' },
    PED: { name: 'Paediatrics', pre: 'P', avg: 7, color: '#8B5CF6' },
    CAR: { name: 'Cardiology', pre: 'C', avg: 11, color: '#E0457B' },
    DER: { name: 'Dermatology', pre: 'D', avg: 7, color: '#14A3A1' },
    ORT: { name: 'Orthopaedics', pre: 'O', avg: 8, color: '#E8910C' },
    ENT: { name: 'ENT', pre: 'N', avg: 7, color: '#0EA5E9' },
    GYN: { name: 'Obstetrics & Gynaecology', pre: 'W', avg: 10, color: '#DB2777' },
    OPH: { name: 'Ophthalmology', pre: 'Y', avg: 6, color: '#65A30D' },
    DEN: { name: 'Dental', pre: 'T', avg: 12, color: '#F97316' },
    NEU: { name: 'Neurology', pre: 'U', avg: 12, color: '#6366F1' }
  };
  const ER = { id: 'ER', name: 'Emergency', pre: 'E', avg: 14, color: '#E5484D', room: 'Resus bay', doc: 'On-call ER team', floor: 'East entrance, ambulance bay', open: true, rooms: 1 };
  const WARD_TYPES = { ICU: { name: 'ICU', prefix: 'I' }, GW: { name: 'General Ward', prefix: 'A' }, PW: { name: 'Paediatric Ward', prefix: 'P' } };
  const LANGS = { en: 'English', hi: 'हिन्दी', te: 'తెలుగు', ta: 'தமிழ்', kn: 'ಕನ್ನಡ', ur: 'اردو' };
  const OUTCOMES = ['Prescription issued', 'Lab tests ordered', 'Imaging ordered', 'Follow-up in 2 weeks', 'Discharged home', 'Admit'];
  const ESI_LABEL = { 1: 'Immediate', 2: 'Emergent', 3: 'Urgent', 4: 'Less urgent', 5: 'Non-urgent' };
  const COMPLAINTS = { chest: 'Chest pain', stroke: 'Stroke signs', breath: 'Breathing difficulty', trauma: 'Injury / accident', abdo: 'Abdominal pain', fever: 'Fever', minor: 'Minor cut or sprain', rx: 'Prescription refill' };
  /* Typical OPD arrival profile by hour (relative). Used for the forecast. */
  const PROFILE = { 8: 0.55, 9: 0.9, 10: 1, 11: 1, 12: 0.85, 13: 0.5, 14: 0.7, 15: 0.75, 16: 0.55, 17: 0.3 };
  const CLEANING_MIN = 20;
  const MAX_LATE = 2;

  /* Who may run which command. `system` is the server itself. */
  const COMMANDS = {
    registerPatient: ['admin', 'desk', 'system'],
    callNext: ['admin', 'desk', 'doctor', 'nurse', 'system'],
    callVisit: ['admin', 'desk', 'doctor', 'nurse'],
    completeVisit: ['admin', 'doctor', 'nurse', 'system'],
    markNoShow: ['admin', 'desk', 'doctor', 'nurse'],
    recall: ['admin', 'desk', 'doctor', 'nurse'],
    runningLate: ['admin', 'desk', 'patient', 'system'],
    triage: ['admin', 'nurse', 'doctor', 'system'],
    overrideEsi: ['admin', 'doctor'],
    ambulancePreAlert: ['admin', 'nurse', 'desk', 'system'],
    prepareBay: ['admin', 'nurse', 'doctor'],
    assignBed: ['admin', 'nurse'],
    dischargeBed: ['admin', 'nurse', 'doctor'],
    markBedReady: ['admin', 'nurse'],
    bookAppointment: ['admin', 'desk'],
    checkInAppointment: ['admin', 'desk'],
    submitFeedback: ['admin', 'desk', 'patient', 'system'],
    updateSettings: ['admin'],
    updateDepartment: ['admin'],
    addDepartment: ['admin'],
    codeBlue: ['admin', 'nurse', 'doctor', 'desk'],
    clearCodeBlue: ['admin', 'nurse', 'doctor'],
    ackAlerts: ['admin', 'desk', 'doctor', 'nurse'],
    markNotified: ['system']
  };
  const ROLES = { admin: 'Administrator', desk: 'Front desk', doctor: 'Doctor', nurse: 'Nurse', patient: 'Patient', system: 'System' };

  class EngineError extends Error {
    constructor(code, message) { super(message); this.name = 'EngineError'; this.code = code; }
  }
  const fail = (code, msg) => { throw new EngineError(code, msg); };

  /* ------------------------------------------------------------------ *
   * Time helpers (hospital local time)
   * ------------------------------------------------------------------ */
  const pad = n => String(n).padStart(2, '0');
  function dayKey(ms) { const d = new Date(ms); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function atMinute(ms, minuteOfDay) { return startOfDay(ms) + minuteOfDay * MIN; }
  function hourOf(ms) { return new Date(ms).getHours(); }
  function mins(from, to) { return Math.max(0, Math.round((to - from) / MIN)); }
  function hhmm(ms) { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function clock12(ms) { const d = new Date(ms); const h = d.getHours(); return (h % 12 || 12) + ':' + pad(d.getMinutes()) + (h >= 12 ? ' PM' : ' AM'); }

  /* ------------------------------------------------------------------ *
   * Validation helpers
   * ------------------------------------------------------------------ */
  function str(v, field, { min = 0, max = 120, required = false } = {}) {
    const s = v == null ? '' : String(v).trim().replace(/\s+/g, ' ');
    if (required && !s) fail('invalid', `${field} is required`);
    if (s.length < min) fail('invalid', `${field} is too short`);
    if (s.length > max) fail('invalid', `${field} is too long (max ${max})`);
    return s;
  }
  function num(v, field, { min = -Infinity, max = Infinity, fallback } = {}) {
    if ((v === '' || v == null) && fallback !== undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) fail('invalid', `${field} must be a number`);
    if (n < min || n > max) fail('invalid', `${field} must be between ${min} and ${max}`);
    return n;
  }
  const digits = p => String(p || '').replace(/\D/g, '');
  function maskPhone(p) { const d = digits(p); return d.length >= 10 ? d.slice(-10, -8) + 'xxxxx' + d.slice(-3) : ''; }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  function createState(cfg = {}) {
    const h = cfg.hospital || {};
    const depts = (cfg.depts || []).map((d, i) => {
      const t = TEMPLATES[d.id] || {};
      return {
        id: d.id, name: d.name || t.name || d.id, pre: d.pre || t.pre || d.id[0],
        avg: d.avg || t.avg || 8, color: d.color || t.color || '#3B6FF5',
        room: d.room || 'OPD ' + (i + 1), doc: d.doc || 'Duty doctor',
        floor: d.floor || 'Ground floor', open: d.open !== false, rooms: 1
      };
    });
    if (!depts.find(d => d.id === 'ER')) depts.push({ ...ER });
    const beds = [];
    (cfg.wards || [{ id: 'ICU', count: 8 }, { id: 'GW', count: 16 }, { id: 'PW', count: 10 }]).forEach(w => {
      const t = WARD_TYPES[w.id]; if (!t) return;
      for (let i = 1; i <= w.count; i++) beds.push({ id: t.prefix + '-' + pad(i), ward: w.id, status: 'free', pid: null, name: null, since: 0 });
    });
    return {
      schema: 1,
      hospital: {
        name: h.name || 'My Hospital', city: h.city || '', langs: h.langs || ['en', 'hi', 'te'],
        sla: { busy: 20, over: 45, ...(h.sla || {}) }, publicCheckin: h.publicCheckin !== false,
        setupComplete: !!h.setupComplete, createdAt: h.createdAt || 0
      },
      depts,
      wardNames: { ICU: 'ICU', GW: 'General Ward A', PW: 'Paediatric Ward', ...(cfg.wardNames || {}) },
      counters: { day: '', tok: {}, patient: 1000, req: 1, amb: 1, fb: 1, alert: 1 },
      serving: {},
      visits: {}, patients: {}, beds, bedReqs: [], ambulances: [], appts: [], feedback: [], alerts: [],
      audit: [], recall: null, codeBlue: null, lastCalls: [], v: 0
    };
  }

  /* ------------------------------------------------------------------ *
   * Selectors (pure reads)
   * ------------------------------------------------------------------ */
  const dept = (st, id) => st.depts.find(d => d.id === id);
  const opdDepts = st => st.depts.filter(d => d.id !== 'ER');
  const visitsList = st => Object.values(st.visits);
  const todayVisits = (st, now) => { const k = dayKey(now); return visitsList(st).filter(v => v.day === k); };

  /* Priority: ESI 1-2, ESI 3, priority flag, appointment, other ESI, walk-in. */
  function sortKey(v) { return v.esi && v.esi <= 2 ? v.esi : v.esi === 3 ? 3 : v.pri ? 4 : v.appt ? 5 : v.esi ? 6 + v.esi : 9; }
  function waiting(st, id) {
    return visitsList(st).filter(v => v.dept === id && v.status === 'waiting')
      .sort((a, b) => (sortKey(a) - sortKey(b)) || ((a.arrived + (a.lateOffset || 0)) - (b.arrived + (b.lateOffset || 0))));
  }
  /* Consult pace learns from today's real consults once there are 5 or more. */
  function pace(st, id, now) {
    const d = dept(st, id); if (!d) return 8;
    const k = dayKey(now);
    const durs = visitsList(st).filter(v => v.dept === id && v.day === k && v.status === 'done' && v.start && v.end && v.outcome !== 'No-show')
      .sort((a, b) => b.end - a.end).slice(0, 20).map(v => (v.end - v.start) / MIN).filter(x => x > 0.5 && x < 90);
    if (durs.length < 5) return d.avg;
    durs.sort((a, b) => a - b);
    const med = durs[Math.floor(durs.length / 2)];
    return Math.max(2, Math.round((med * 0.7 + d.avg * 0.3) * 10) / 10);
  }
  function remaining(st, id, now) {
    const c = st.serving[id] && st.visits[st.serving[id]];
    if (!c) return 0;
    return Math.max(1, Math.round(pace(st, id, now) - (now - c.start) / MIN));
  }
  function newWait(st, id, now) { return Math.round(remaining(st, id, now) + waiting(st, id).length * pace(st, id, now)); }
  function eta(st, visitId, now) {
    const v = st.visits[visitId]; if (!v || v.status !== 'waiting') return { pos: 0, mins: 0 };
    const list = waiting(st, v.dept), i = list.indexOf(v);
    return { pos: i + 1, mins: Math.round(remaining(st, v.dept, now) + i * pace(st, v.dept, now)) };
  }
  function slaStatus(st, m) { return m > st.hospital.sla.over ? 'over' : m > st.hospital.sla.busy ? 'busy' : 'ok'; }
  function occupancy(st, ward) {
    const b = st.beds.filter(x => !ward || x.ward === ward);
    return { total: b.length, occupied: b.filter(x => x.status === 'occupied').length, free: b.filter(x => x.status === 'free').length, cleaning: b.filter(x => x.status === 'cleaning').length };
  }
  const openBedReqs = st => st.bedReqs.filter(r => r.status === 'open');
  const inboundAmbulances = st => st.ambulances.filter(a => a.status === 'inbound');
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return Math.round(s[Math.floor(s.length / 2)]); };

  function stats(st, now) {
    const today = todayVisits(st, now);
    const started = today.filter(v => v.start);
    const waits = started.filter(v => v.dept !== 'ER').map(v => (v.start - v.arrived) / MIN);
    const done = today.filter(v => v.status === 'done');
    const hourly = {}, waitByHour = {}, waitByDept = {};
    done.forEach(v => { const h = hourOf(v.end); hourly[h] = (hourly[h] || 0) + 1; });
    started.forEach(v => {
      const h = hourOf(v.start), w = (v.start - v.arrived) / MIN;
      (waitByHour[h] = waitByHour[h] || []).push(w); (waitByDept[v.dept] = waitByDept[v.dept] || []).push(w);
    });
    const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;
    const fb = st.feedback.filter(f => dayKey(f.t) === dayKey(now));
    const appts = st.appts.filter(a => a.day === dayKey(now) && a.status !== 'open' && a.t < now);
    const noShows = appts.filter(a => a.status === 'noshow').length;
    const nowH = hourOf(now);
    let expectedSoFar = 0; for (let h = 8; h <= nowH; h++) expectedSoFar += PROFILE[h] || 0;
    const scale = expectedSoFar ? Math.max(8, today.filter(v => v.dept !== 'ER').length / expectedSoFar) : 30;
    const forecast = {}; for (let h = nowH + 1; h <= 17; h++) if (PROFILE[h]) forecast[h] = Math.round(PROFILE[h] * scale);
    return {
      served: done.length, arrivals: today.length, waitingNow: visitsList(st).filter(v => v.status === 'waiting' && v.dept !== 'ER').length,
      avgWait: avg(waits), medianWait: median(waits), slaCompliance: waits.length ? Math.round(waits.filter(w => w <= st.hospital.sla.over).length / waits.length * 100) : 100,
      hourly, forecast, waitByHour: Object.fromEntries(Object.entries(waitByHour).map(([h, a]) => [h, avg(a)])),
      waitByDept: Object.fromEntries(Object.entries(waitByDept).map(([d, a]) => [d, avg(a)])),
      pulse: fb.length ? Math.round(fb.reduce((a, f) => a + f.stars, 0) / fb.length * 100) / 100 : 0, ratings: fb.length,
      noShowRate: appts.length ? Math.round(noShows / appts.length * 100) : 0
    };
  }

  function suggestion(st, now) {
    const rows = opdDepts(st).filter(d => d.open).map(d => ({ d, m: newWait(st, d.id, now) }));
    if (rows.length < 2) return null;
    const hi = rows.reduce((a, b) => b.m > a.m ? b : a), lo = rows.reduce((a, b) => b.m < a.m ? b : a);
    if (hi.m - lo.m <= 15) return null;
    return { from: lo.d.id, to: hi.d.id, fromWait: lo.m, toWait: hi.m, expected: Math.round(hi.m / 2) };
  }

  /* Emergency Severity Index suggestion (simplified ESI v4 decision points). */
  function triage(i) {
    const c = i.complaint, spo = Number(i.spo2), hr = Number(i.hr), bp = Number(i.bp), pain = Number(i.pain) || 0, age = Number(i.age), av = i.avpu || 'A';
    const r = []; let level;
    if (av === 'P' || av === 'U') { level = 1; r.push('responds only to pain or not at all'); }
    else if (spo && spo < 88) { level = 1; r.push('SpO₂ below 88%'); }
    else if (bp && bp < 80) { level = 1; r.push('systolic BP below 80'); }
    else if (['chest', 'stroke', 'breath'].includes(c)) { level = 2; r.push('high-risk complaint'); }
    else if ((spo && spo < 92) || hr > 120 || (hr && hr < 50) || bp > 180) { level = 2; r.push('danger-zone vital signs'); }
    else if (pain >= 8) { level = 2; r.push('severe pain'); }
    else if (['trauma', 'abdo'].includes(c) || (c === 'fever' && (age > 65 || age < 2))) { level = 3; r.push('needs two or more resources'); }
    else if (c === 'fever' || c === 'minor') { level = 4; r.push('needs one resource'); }
    else { level = 5; r.push('no resources needed'); }
    return { level, label: ESI_LABEL[level], reasons: r };
  }

  /* Public, name-free projection for lobby screens. */
  function board(st, now) {
    return {
      hospital: st.hospital.name, now,
      rows: st.depts.filter(d => d.open).map(d => {
        const c = st.serving[d.id] && st.visits[st.serving[d.id]], n = waiting(st, d.id)[0];
        return { id: d.id, name: d.name, room: d.room, color: d.color, serving: c ? c.tok : null, next: n ? n.tok : null, wait: d.id === 'ER' ? null : newWait(st, d.id, now) };
      }),
      recall: st.recall, lastCalls: st.lastCalls.slice(0, 6), langs: st.hospital.langs
    };
  }

  /* Compact snapshot for the AI Copilot. */
  function snapshot(st, now) {
    const s = stats(st, now);
    return {
      time: clock12(now), hospital: st.hospital.name,
      departments: opdDepts(st).map(d => ({ id: d.id, name: d.name, doctor: d.doc, open: d.open, waiting: waiting(st, d.id).length, now_serving: st.serving[d.id] ? st.visits[st.serving[d.id]].tok : null, new_arrival_wait_min: newWait(st, d.id, now), status: slaStatus(st, newWait(st, d.id, now)) })),
      emergency: { in_resus: st.serving.ER ? st.visits[st.serving.ER].tok : null, waiting: waiting(st, 'ER').map(v => ({ token: v.tok, esi: v.esi, waited_min: mins(v.arrived, now) })) },
      ambulances_inbound: inboundAmbulances(st).map(a => ({ id: a.id, complaint: a.complaint, esi: a.esi, eta_min: mins(now, a.arriveAt), bay_prepared: a.prepared })),
      beds: Object.keys(WARD_TYPES).map(w => ({ ward: st.wardNames[w], ...occupancy(st, w) })).filter(b => b.total),
      pending_admissions: openBedReqs(st).map(r => ({ id: r.id, patient: r.name, needs: st.wardNames[r.ward], waiting_min: mins(r.at, now) })),
      today: { patients_seen: s.served, avg_wait_min: s.avgWait, median_wait_min: s.medianWait, sla_compliance_pct: s.slaCompliance, patient_pulse: s.pulse, no_show_rate_pct: s.noShowRate },
      forecast_next_hours: s.forecast, suggestion: suggestion(st, now)
    };
  }

  /* ------------------------------------------------------------------ *
   * Deltas
   * ------------------------------------------------------------------ */
  const LISTS = ['beds', 'bedReqs', 'ambulances', 'appts', 'feedback', 'alerts'];
  function applyDelta(st, d) {
    if (!d) return st;
    if (d.meta) Object.assign(st, d.meta);
    (d.visits || []).forEach(v => { if (v._removed) delete st.visits[v.id]; else st.visits[v.id] = v; });
    (d.patients || []).forEach(p => { st.patients[p.pid] = p; });
    LISTS.forEach(k => (d[k] || []).forEach(item => {
      const i = st[k].findIndex(x => x.id === item.id);
      if (item._removed) { if (i >= 0) st[k].splice(i, 1); } else if (i >= 0) st[k][i] = item; else st[k].unshift(item);
    }));
    if (d.audit && d.audit.length) st.audit = d.audit.concat(st.audit).slice(0, 200);
    if (d.v != null) st.v = d.v;
    return st;
  }

  /* ------------------------------------------------------------------ *
   * Engine
   * ------------------------------------------------------------------ */
  function createEngine(state, opts = {}) {
    const st = state;
    const rng = opts.rng || Math.random;
    const genKey = opts.genKey || (() => Math.floor(rng() * 36 ** 8).toString(36).padStart(8, '0'));
    let dirty = freshDirty();
    const breach = {};
    function freshDirty() { return { meta: false, visits: new Set(), patients: new Set(), audit: [], ...Object.fromEntries(LISTS.map(k => [k, new Set()])) }; }
    const touch = (k, id) => dirty[k].add(id);
    const touchMeta = () => { dirty.meta = true; };

    function audit(actor, action, text, now) {
      const e = { t: now, who: actor.name || ROLES[actor.role] || 'Unknown', role: actor.role, action, text };
      st.audit.unshift(e); if (st.audit.length > 200) st.audit.pop();
      dirty.audit.push(e);
    }
    function alert(level, title, body, view, now) {
      const a = { id: 'AL' + (st.counters.alert++), t: now, level, title, body, view, read: false };
      st.alerts.unshift(a); if (st.alerts.length > 80) { const old = st.alerts.pop(); touch('alerts', old.id); old._removed = true; }
      touch('alerts', a.id); touchMeta(); return a;
    }
    function ensureDay(now) {
      const k = dayKey(now);
      if (st.counters.day === k) return;
      st.counters.day = k; st.counters.tok = {};
      // Yesterday's unfinished visits close as no-shows and leave memory once persisted.
      visitsList(st).forEach(v => {
        if (v.day !== k) { if (v.status === 'waiting' || v.status === 'serving') { v.status = 'noshow'; v.outcome = v.outcome || 'Closed at day end'; } v._removed = true; touch('visits', v.id); }
      });
      st.serving = {}; st.lastCalls = []; st.recall = null;
      ensureSlots(now); touchMeta();
    }
    function ensureSlots(now) {
      const k = dayKey(now);
      opdDepts(st).forEach(d => {
        for (let m = 9 * 60; m < 13 * 60; m += 15) {
          const id = k + '-' + d.id + '-' + pad(Math.floor(m / 60)) + pad(m % 60);
          if (!st.appts.find(a => a.id === id)) { const a = { id, day: k, dept: d.id, t: atMinute(now, m), status: 'open', name: null, phone: null, visitId: null }; st.appts.push(a); touch('appts', a.id); }
        }
      });
      // keep only today and later in memory
      st.appts = st.appts.filter(a => a.day >= k);
    }
    function findOrCreatePatient(p, now) {
      const ph = digits(p.phone), ab = digits(p.abha);
      let pt = null;
      if (ab.length >= 14) pt = Object.values(st.patients).find(x => digits(x.abha) === ab);
      if (!pt && ph.length >= 10) pt = Object.values(st.patients).find(x => digits(x.phone).slice(-10) === ph.slice(-10) && x.name.toLowerCase() === p.name.toLowerCase());
      if (!pt) { const pid = 'RC' + (++st.counters.patient); pt = { pid, name: p.name, phone: '', abha: '', age: null, sex: '', createdAt: now, visits: [] }; st.patients[pid] = pt; touchMeta(); }
      if (p.phone) pt.phone = String(p.phone).slice(0, 20);
      if (p.abha) pt.abha = String(p.abha).slice(0, 20);
      if (p.age != null && p.age !== '') pt.age = p.age;
      if (p.sex) pt.sex = p.sex;
      touch('patients', pt.pid); return pt;
    }
    function freeSeat() {
      const taken = new Set(visitsList(st).filter(v => v.status === 'waiting' && v.seat != null).map(v => v.seat));
      const free = []; for (let i = 0; i < 120; i++) if (!taken.has(i)) free.push(i);
      return free.length ? free[Math.floor(rng() * free.length)] : null;
    }
    function newVisit(d, pt, o, now) {
      ensureDay(now);
      st.counters.tok[d.id] = (st.counters.tok[d.id] || 100) + 1;
      const tok = d.pre + '-' + st.counters.tok[d.id];
      const v = {
        id: st.counters.day + '-' + tok, day: st.counters.day, tok, dept: d.id, pid: pt.pid, name: pt.name,
        esi: o.esi || null, pri: !!o.pri, appt: !!o.appt, lang: o.lang || 'en', src: o.src || 'Registered at desk',
        arrived: now, status: 'waiting', start: null, end: null, outcome: null, lateOffset: 0, lateCount: 0,
        seat: d.id === 'ER' ? null : freeSeat(), trackKey: genKey(), notified: {}, events: [{ t: now, x: o.src || 'Registered at desk' }]
      };
      st.visits[v.id] = v; pt.visits = (pt.visits || []).concat(v.id).slice(-50);
      touch('visits', v.id); touch('patients', pt.pid); touchMeta();
      return v;
    }
    function finish(v, outcome, now, actor) {
      v.status = 'done'; v.end = now; v.outcome = outcome; v.events.push({ t: now, x: outcome });
      touch('visits', v.id);
      if (outcome === 'Admit' || (v.dept === 'ER' && v.esi && v.esi <= 2)) requestBed(v, now, actor);
    }
    function serve(id, specific, outcome, now, actor) {
      const d = dept(st, id);
      const curId = st.serving[id], cur = curId && st.visits[curId];
      if (cur && cur.status === 'serving') finish(cur, outcome || 'Consult complete', now, actor);
      const nx = specific || waiting(st, id)[0];
      if (nx) {
        nx.status = 'serving'; nx.start = now; nx.seat = null; nx.events.push({ t: now, x: 'Called to ' + d.room });
        st.serving[id] = nx.id; touch('visits', nx.id);
        st.lastCalls.unshift({ tok: nx.tok, room: d.room, dept: id, t: now, lang: nx.lang }); st.lastCalls = st.lastCalls.slice(0, 8);
      } else st.serving[id] = null;
      touchMeta();
      return nx || null;
    }
    function requestBed(v, now) {
      if (st.bedReqs.find(r => r.visitId === v.id && r.status === 'open')) return;
      const pt = st.patients[v.pid];
      const ward = v.esi === 1 ? 'ICU' : ((pt && pt.age != null && pt.age < 14) || v.dept === 'PED') ? 'PW' : 'GW';
      const r = { id: 'BR-' + (st.counters.req++), visitId: v.id, tok: v.tok, pid: v.pid, name: v.name, ward, from: dept(st, v.dept).name, esi: v.esi, at: now, status: 'open', bed: null };
      st.bedReqs.unshift(r); touch('bedReqs', r.id); touchMeta();
      alert('warn', 'Bed requested', `${v.name} (${v.tok}) needs a ${st.wardNames[ward]} bed.`, 'beds', now);
    }
    function visitOr404(id) { const v = st.visits[id]; if (!v) fail('not_found', 'Visit not found'); return v; }
    function deptOr404(id) { const d = dept(st, id); if (!d) fail('not_found', 'Department not found'); return d; }
    const langOk = l => (st.hospital.langs.includes(l) ? l : 'en');

    const handlers = {
      registerPatient(p, actor, now) {
        const name = str(p.name, 'Name', { required: true, max: 80 });
        const d = deptOr404(p.dept);
        if (d.id === 'ER') fail('invalid', 'Use triage for emergency patients');
        if (!d.open) fail('closed', `${d.name} is closed right now`);
        const pt = findOrCreatePatient({ name, phone: str(p.phone, 'Phone', { max: 20 }), abha: str(p.abha, 'ABHA', { max: 20 }), age: p.age === '' || p.age == null ? null : num(p.age, 'Age', { min: 0, max: 125 }), sex: str(p.sex, 'Sex', { max: 10 }) }, now);
        if (visitsList(st).some(v => v.pid === pt.pid && v.dept === d.id && (v.status === 'waiting' || v.status === 'serving'))) fail('duplicate', `${name} is already in the ${d.name} queue`);
        const v = newVisit(d, pt, { pri: !!p.priority, appt: !!p.appt, lang: langOk(p.lang), src: str(p.source, 'Source', { max: 60 }) || 'Registered at desk' }, now);
        const e = eta(st, v.id, now);
        audit(actor, 'registerPatient', `Registered ${name} as ${v.tok} in ${d.name}`, now);
        return { id: v.id, tok: v.tok, trackKey: v.trackKey, position: e.pos, etaMin: e.mins, room: d.room };
      },
      callNext(p, actor, now) {
        const d = deptOr404(p.dept);
        const v = serve(d.id, null, p.outcome, now, actor);
        audit(actor, 'callNext', v ? `Called ${v.tok} to ${d.room}` : `Called next in ${d.name}: queue empty`, now);
        return { called: v ? v.tok : null, id: v ? v.id : null, room: d.room };
      },
      callVisit(p, actor, now) {
        const v = visitOr404(p.id);
        if (v.status !== 'waiting') fail('invalid', `${v.tok} is not waiting`);
        serve(v.dept, v, null, now, actor);
        audit(actor, 'callVisit', `Called ${v.tok} out of order`, now);
        return { called: v.tok };
      },
      completeVisit(p, actor, now) {
        const d = deptOr404(p.dept);
        const cur = st.serving[d.id] && st.visits[st.serving[d.id]];
        if (!cur || cur.status !== 'serving') fail('invalid', 'No patient in consult');
        let outcome = p.outcome;
        let referred = null;
        if (p.referTo) {
          const to = deptOr404(p.referTo); if (to.id === 'ER' || to.id === d.id) fail('invalid', 'Choose another OPD department');
          outcome = 'Referred to ' + to.name;
          const pt = st.patients[cur.pid];
          referred = newVisit(to, pt, { pri: true, lang: cur.lang, src: 'Referred from ' + d.name }, now);
        } else if (!OUTCOMES.includes(outcome) && outcome !== 'Consult complete') fail('invalid', 'Unknown outcome');
        finish(cur, outcome, now, actor); st.serving[d.id] = null; touchMeta();
        audit(actor, 'completeVisit', `${cur.tok}: ${outcome}${referred ? ' as ' + referred.tok : ''}`, now);
        let next = null;
        if (p.callNext) { next = serve(d.id, null, null, now, actor); if (next) audit(actor, 'callNext', `Called ${next.tok} to ${d.room}`, now); }
        return { completed: cur.tok, outcome, referred: referred && referred.tok, next: next && next.tok };
      },
      markNoShow(p, actor, now) {
        const v = visitOr404(p.id);
        if (v.status !== 'waiting') fail('invalid', `${v.tok} is not waiting`);
        v.status = 'noshow'; v.outcome = 'No-show'; v.end = now; v.seat = null; v.events.push({ t: now, x: 'Marked no-show' });
        touch('visits', v.id); audit(actor, 'markNoShow', `Marked ${v.tok} as no-show`, now);
        return { tok: v.tok };
      },
      recall(p, actor, now) {
        const d = deptOr404(p.dept);
        const v = st.serving[d.id] && st.visits[st.serving[d.id]];
        if (!v) fail('invalid', 'No one to recall');
        st.recall = { dept: d.id, tok: v.tok, room: d.room, lang: v.lang, t: now }; touchMeta();
        audit(actor, 'recall', `Recalled ${v.tok} to ${d.room}`, now);
        return { tok: v.tok };
      },
      runningLate(p, actor, now) {
        const v = visitOr404(p.id);
        if (v.status !== 'waiting') fail('invalid', 'Only waiting patients can use this');
        if (v.lateCount >= MAX_LATE) fail('limit', 'Running late can be used twice per visit');
        const list = waiting(st, v.dept), i = list.indexOf(v), target = list[Math.min(list.length - 1, i + 3)];
        if (target && target !== v) v.lateOffset = (target.arrived + (target.lateOffset || 0)) - v.arrived + 1000;
        v.lateCount++; v.events.push({ t: now, x: 'Running late: moved back 3 places' }); touch('visits', v.id);
        audit(actor, 'runningLate', `${v.tok} is running late`, now);
        return eta(st, v.id, now);
      },
      triage(p, actor, now) {
        const name = str(p.name, 'Name', { max: 80 }) || 'Unknown patient';
        if (p.complaint && !COMPLAINTS[p.complaint]) fail('invalid', 'Unknown complaint');
        const t = triage(p);
        const pt = findOrCreatePatient({ name, age: p.age === '' || p.age == null ? null : num(p.age, 'Age', { min: 0, max: 125 }), sex: str(p.sex, 'Sex', { max: 10 }) }, now);
        const v = newVisit(dept(st, 'ER'), pt, { esi: t.level, lang: langOk(p.lang), src: p.source || `Triaged ESI ${t.level} (${COMPLAINTS[p.complaint] || 'unspecified'})` }, now);
        v.triage = { complaint: p.complaint || null, spo2: p.spo2 || null, hr: p.hr || null, bp: p.bp || null, avpu: p.avpu || 'A', pain: p.pain || 0, reasons: t.reasons };
        if (t.level <= 2) alert('crit', `ESI ${t.level} in Emergency`, `${v.tok} ${name}: ${t.reasons.join(', ')}.`, 'er', now);
        audit(actor, 'triage', `Triaged ${v.tok} at ESI ${t.level}`, now);
        return { id: v.id, tok: v.tok, level: t.level, reasons: t.reasons };
      },
      overrideEsi(p, actor, now) {
        const v = visitOr404(p.id); if (v.dept !== 'ER') fail('invalid', 'Only emergency visits have ESI');
        const esi = num(p.esi, 'ESI', { min: 1, max: 5 }); const reason = str(p.reason, 'Reason', { required: true, max: 200 });
        const old = v.esi; v.esi = esi; v.events.push({ t: now, x: `ESI changed ${old} → ${esi}: ${reason}` }); touch('visits', v.id);
        audit(actor, 'overrideEsi', `${v.tok} ESI ${old} → ${esi} (${reason})`, now);
        return { tok: v.tok, esi };
      },
      ambulancePreAlert(p, actor, now) {
        const a = { id: 'AMB-' + (st.counters.amb++), from: str(p.from, 'From', { required: true, max: 60 }), complaint: str(p.complaint, 'Complaint', { required: true, max: 120 }), esi: num(p.esi, 'ESI', { min: 1, max: 5 }), arriveAt: now + num(p.etaMin, 'ETA', { min: 1, max: 240 }) * MIN, prepared: false, status: 'inbound', at: now };
        st.ambulances.unshift(a); touch('ambulances', a.id); touchMeta();
        alert('crit', 'Ambulance inbound', `${a.id}: ${a.complaint}. ETA ${mins(now, a.arriveAt)} min.`, 'er', now);
        audit(actor, 'ambulancePreAlert', `${a.id} pre-alert from ${a.from}`, now);
        return { id: a.id };
      },
      prepareBay(p, actor, now) {
        const a = st.ambulances.find(x => x.id === p.id && x.status === 'inbound'); if (!a) fail('not_found', 'Ambulance not found');
        a.prepared = true; touch('ambulances', a.id); audit(actor, 'prepareBay', `Resus bay prepared for ${a.id}`, now);
        return { id: a.id };
      },
      assignBed(p, actor, now) {
        const r = p.reqId ? st.bedReqs.find(x => x.id === p.reqId && x.status === 'open') : openBedReqs(st).slice(-1)[0];
        if (!r) fail('not_found', 'No pending admission');
        let b;
        if (p.bedId) { b = st.beds.find(x => x.id === p.bedId); if (!b || b.status !== 'free') fail('invalid', 'That bed is not free'); }
        else b = st.beds.find(x => x.ward === r.ward && x.status === 'free') || st.beds.find(x => x.ward === 'GW' && x.status === 'free');
        if (!b) fail('no_bed', `No free ${st.wardNames[r.ward]} bed`);
        b.status = 'occupied'; b.pid = r.pid; b.name = r.name; b.since = now; touch('beds', b.id);
        r.status = 'assigned'; r.bed = b.id; touch('bedReqs', r.id);
        const v = st.visits[r.visitId]; if (v) { v.events.push({ t: now, x: `Admitted to ${b.id}, ${st.wardNames[b.ward]}` }); touch('visits', v.id); }
        audit(actor, 'assignBed', `Assigned ${b.id} to ${r.name}`, now);
        return { bed: b.id, ward: st.wardNames[b.ward], patient: r.name };
      },
      dischargeBed(p, actor, now) {
        const b = st.beds.find(x => x.id === p.bedId); if (!b || b.status !== 'occupied') fail('invalid', 'Bed is not occupied');
        const who = b.name; b.status = 'cleaning'; b.since = now; b.name = null; b.pid = null; touch('beds', b.id);
        audit(actor, 'dischargeBed', `Discharged ${who || 'patient'} from ${b.id}`, now);
        return { bed: b.id };
      },
      markBedReady(p, actor, now) {
        const b = st.beds.find(x => x.id === p.bedId); if (!b || b.status !== 'cleaning') fail('invalid', 'Bed is not being cleaned');
        b.status = 'free'; b.since = now; touch('beds', b.id); audit(actor, 'markBedReady', `${b.id} cleaned and ready`, now);
        return { bed: b.id };
      },
      bookAppointment(p, actor, now) {
        const a = st.appts.find(x => x.id === p.slotId); if (!a) fail('not_found', 'Slot not found');
        if (a.status !== 'open') fail('invalid', 'Slot is already taken');
        if (a.t + 15 * MIN < now) fail('invalid', 'Slot is in the past');
        a.name = str(p.name, 'Name', { required: true, max: 80 }); a.phone = str(p.phone, 'Phone', { max: 20 }); a.status = 'booked'; touch('appts', a.id);
        audit(actor, 'bookAppointment', `Booked ${a.name} with ${dept(st, a.dept).doc} at ${hhmm(a.t)}`, now);
        return { slotId: a.id };
      },
      checkInAppointment(p, actor, now) {
        const a = st.appts.find(x => x.id === p.slotId); if (!a || a.status !== 'booked') fail('invalid', 'Appointment is not booked');
        const r = handlers.registerPatient({ name: a.name, phone: a.phone, dept: a.dept, appt: true, source: 'Checked in for ' + hhmm(a.t) + ' appointment' }, actor, now);
        a.status = 'checked'; a.visitId = r.id; touch('appts', a.id);
        return r;
      },
      submitFeedback(p, actor, now) {
        const v = visitOr404(p.id); if (v.status !== 'done') fail('invalid', 'Feedback opens after the visit');
        const stars = num(p.stars, 'Stars', { min: 1, max: 5 });
        let f = st.feedback.find(x => x.visitId === v.id);
        if (f) { f.stars = stars; f.text = str(p.text, 'Comment', { max: 300 }) || f.text; }
        else { f = { id: 'FB' + (st.counters.fb++), visitId: v.id, tok: v.tok, dept: v.dept, stars, text: str(p.text, 'Comment', { max: 300 }), t: now }; st.feedback.unshift(f); if (st.feedback.length > 500) st.feedback.pop(); touchMeta(); }
        touch('feedback', f.id);
        return { stars };
      },
      updateSettings(p, actor, now) {
        const h = st.hospital;
        if (p.name != null) h.name = str(p.name, 'Hospital name', { required: true, max: 80 });
        if (p.city != null) h.city = str(p.city, 'City', { max: 60 });
        if (p.sla) { const busy = num(p.sla.busy, 'Busy threshold', { min: 5, max: 120 }), over = num(p.sla.over, 'SLA threshold', { min: 10, max: 240 }); if (over <= busy) fail('invalid', 'SLA threshold must be above the busy threshold'); h.sla = { busy, over }; }
        if (p.langs) { const l = p.langs.filter(x => LANGS[x]); if (!l.includes('en')) l.unshift('en'); h.langs = l; }
        if (p.publicCheckin != null) h.publicCheckin = !!p.publicCheckin;
        touchMeta(); audit(actor, 'updateSettings', 'Updated hospital settings', now);
        return { hospital: h };
      },
      updateDepartment(p, actor, now) {
        const d = deptOr404(p.id);
        if (p.avg != null) d.avg = num(p.avg, 'Average consult', { min: 2, max: 60 });
        if (p.open != null) { if (d.id === 'ER' && !p.open) fail('invalid', 'Emergency cannot be closed'); d.open = !!p.open; }
        if (p.doc != null) d.doc = str(p.doc, 'Doctor', { required: true, max: 60 });
        if (p.room != null) d.room = str(p.room, 'Room', { required: true, max: 30 });
        touchMeta(); audit(actor, 'updateDepartment', `Updated ${d.name}`, now);
        return { dept: d };
      },
      addDepartment(p, actor, now) {
        const id = str(p.id, 'Code', { required: true, max: 4 }).toUpperCase();
        if (dept(st, id)) fail('duplicate', 'Department already exists');
        const t = TEMPLATES[id] || {};
        const name = str(p.name || t.name, 'Name', { required: true, max: 60 });
        const used = new Set(st.depts.map(d => d.pre));
        let pre = (p.pre || t.pre || name[0]).toUpperCase(); if (used.has(pre)) pre = 'ABCDFHJKLMQRSVXZ'.split('').find(c => !used.has(c));
        const d = { id, name, pre, avg: num(p.avg || t.avg || 8, 'Average consult', { min: 2, max: 60 }), color: t.color || '#64748B', room: str(p.room, 'Room', { required: true, max: 30 }), doc: str(p.doc, 'Doctor', { required: true, max: 60 }), floor: str(p.floor, 'Directions', { max: 80 }) || 'Ground floor', open: true, rooms: 1 };
        st.depts.splice(st.depts.length - 1, 0, d); ensureSlots(now); touchMeta();
        audit(actor, 'addDepartment', `Added ${name}`, now);
        return { dept: d };
      },
      codeBlue(p, actor, now) {
        st.codeBlue = { location: str(p.location, 'Location', { max: 60 }) || 'Emergency', t: now, by: actor.name }; touchMeta();
        alert('crit', 'Code Blue', `Code Blue at ${st.codeBlue.location}.`, 'er', now);
        audit(actor, 'codeBlue', `Code Blue called at ${st.codeBlue.location}`, now);
        return st.codeBlue;
      },
      clearCodeBlue(p, actor, now) {
        if (!st.codeBlue) return { cleared: false };
        st.codeBlue = null; touchMeta(); audit(actor, 'clearCodeBlue', 'Code Blue cleared', now);
        return { cleared: true };
      },
      ackAlerts(p) {
        st.alerts.forEach(a => { if (!a.read && (!p.id || a.id === p.id)) { a.read = true; touch('alerts', a.id); } });
        return { ok: true };
      },
      markNotified(p) {
        const v = visitOr404(p.id); v.notified = { ...(v.notified || {}), [p.kind]: true }; touch('visits', v.id); return { ok: true };
      }
    };

    function dispatch(name, payload, actor, now) {
      const h = handlers[name];
      if (!h || !COMMANDS[name]) fail('unknown_command', `Unknown command: ${name}`);
      actor = actor || { role: 'system', name: 'System' };
      if (!COMMANDS[name].includes(actor.role)) fail('forbidden', `${ROLES[actor.role] || actor.role} cannot ${name}`);
      if (typeof now !== 'number') now = Date.now();
      ensureDay(now);
      return h(payload || {}, actor, now);
    }

    /* Time-based maintenance. Call every few seconds. */
    function tick(now) {
      ensureDay(now);
      const sys = { role: 'system', name: 'System' };
      inboundAmbulances(st).filter(a => a.arriveAt <= now).forEach(a => {
        a.status = 'arrived'; touch('ambulances', a.id);
        const pt = findOrCreatePatient({ name: 'Unknown (' + a.id + ')' }, now);
        const v = newVisit(dept(st, 'ER'), pt, { esi: a.esi, src: 'Arrived by ' + a.id + ' from ' + a.from }, now);
        alert('crit', `${a.id} arrived`, `${v.tok} placed at ESI ${a.esi}.`, 'er', now);
        audit(sys, 'ambulanceArrived', `${a.id} arrived as ${v.tok}`, now);
      });
      st.beds.forEach(b => { if (b.status === 'cleaning' && now - b.since >= CLEANING_MIN * MIN) { b.status = 'free'; b.since = now; touch('beds', b.id); } });
      st.appts.forEach(a => { if (a.status === 'booked' && now > a.t + 20 * MIN) { a.status = 'noshow'; touch('appts', a.id); } });
      opdDepts(st).forEach(d => {
        if (!d.open) return;
        const w = newWait(st, d.id, now);
        if (w > st.hospital.sla.over && !breach[d.id]) { breach[d.id] = true; alert('warn', `${d.name} over SLA`, `New arrivals now wait about ${w} min. Consider opening a second room.`, 'overview', now); }
        else if (w < st.hospital.sla.busy) breach[d.id] = false;
      });
      if (st.recall && now - st.recall.t > 2 * MIN) { st.recall = null; touchMeta(); }
      return hasChanges();
    }

    function hasChanges() { return dirty.meta || dirty.audit.length || dirty.visits.size || dirty.patients.size || LISTS.some(k => dirty[k].size); }
    function takeDelta(now) {
      if (!hasChanges()) return null;
      st.v++;
      const d = { v: st.v, now };
      if (dirty.meta) d.meta = { hospital: st.hospital, depts: st.depts, counters: st.counters, serving: st.serving, recall: st.recall, codeBlue: st.codeBlue, lastCalls: st.lastCalls, wardNames: st.wardNames };
      if (dirty.visits.size) d.visits = [...dirty.visits].map(id => st.visits[id] || { id, _removed: true });
      [...dirty.visits].forEach(id => { const v = st.visits[id]; if (v && v._removed) delete st.visits[id]; });
      if (dirty.patients.size) d.patients = [...dirty.patients].map(id => st.patients[id]).filter(Boolean);
      LISTS.forEach(k => { if (dirty[k].size) d[k] = [...dirty[k]].map(id => st[k].find(x => x.id === id) || { id, _removed: true }); });
      if (dirty.audit.length) d.audit = dirty.audit.slice();
      dirty = freshDirty();
      return d;
    }

    return { state: st, dispatch, tick, takeDelta, hasChanges, ensureSlots: now => ensureSlots(now) };
  }

  function can(role, command) { return !!(COMMANDS[command] && COMMANDS[command].includes(role)); }

  return {
    VERSION, MIN, TEMPLATES, ER, WARD_TYPES, LANGS, OUTCOMES, ESI_LABEL, COMPLAINTS, COMMANDS, ROLES, PROFILE,
    EngineError, createState, createEngine, applyDelta, can,
    dept, opdDepts, waiting, pace, remaining, newWait, eta, slaStatus, occupancy, openBedReqs, inboundAmbulances,
    todayVisits, stats, suggestion, triage, board, snapshot, sortKey,
    dayKey, startOfDay, atMinute, hourOf, mins, hhmm, clock12, maskPhone, median
  };
});
