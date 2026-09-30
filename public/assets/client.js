/*!
 * RayCare client — one interface, two transports.
 *
 *   remote : talks to a RayCare server (REST commands + Server-Sent Events)
 *   demo   : runs the same engine and a simulator inside the browser
 *
 * The staff app only ever calls this interface, so every screen works the
 * same whether it is connected to a hospital server or running as a demo.
 */
(function (root) {
  'use strict';
  const E = root.RayCareEngine;
  const TOKEN_KEY = 'raycare.token';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }
  };

  class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

  async function probe() {
    if (location.protocol === 'file:') return null;
    try {
      const r = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.ok ? j : null;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------ remote */
  function remote(health) {
    const listeners = new Set();
    let token = store.get(TOKEN_KEY), es = null;
    let serverNow = health.now, receivedAt = Date.now(), rate = health.clockRate || 1;
    const c = {
      mode: 'remote', state: null, user: null, features: {}, health,
      now: () => serverNow + (Date.now() - receivedAt) * rate,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      get signedIn() { return !!token; }
    };
    const emit = why => listeners.forEach(fn => { try { fn(why); } catch (e) { console.error(e); } });
    const syncClock = now => { if (now) { serverNow = now; receivedAt = Date.now(); } };

    async function http(method, url, body, raw) {
      const r = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (raw && r.ok) return r;
      let j = null; try { j = await r.json(); } catch (e) { /* not JSON */ }
      if (r.status === 401 && token) { c.logout(true); }
      if (!r.ok) throw new ApiError(r.status, j && j.error ? j.error.code : 'http_' + r.status, j && j.error ? j.error.message : 'Request failed (' + r.status + ')');
      return j;
    }
    c.http = http;

    c.setupStatus = () => http('GET', '/api/setup/status');
    c.finishSetup = async cfg => { const j = await http('POST', '/api/setup', cfg); token = j.token; store.set(TOKEN_KEY, token); return c.load(); };
    c.login = async (email, password) => { const j = await http('POST', '/api/auth/login', { email, password }); token = j.token; store.set(TOKEN_KEY, token); return c.load(); };
    c.logout = silent => { token = null; store.set(TOKEN_KEY, null); if (es) es.close(); es = null; c.state = null; if (!silent) emit('logout'); else emit('expired'); };

    c.load = async () => {
      const j = await http('GET', '/api/state');
      c.state = j.state; c.user = j.user; c.features = j.features; rate = j.clockRate || 1; syncClock(j.now);
      connectStream();
      emit('load');
      return c;
    };

    function connectStream() {
      if (es) es.close();
      es = new EventSource('/api/stream?access_token=' + encodeURIComponent(token));
      es.addEventListener('delta', ev => {
        const d = JSON.parse(ev.data);
        syncClock(d.now);
        if (c.state && d.v <= c.state.v) return;
        if (c.state && d.v !== c.state.v + 1) { c.load().catch(() => {}); return; } // missed a change: resync
        E.applyDelta(c.state, d); emit('delta');
      });
      es.addEventListener('hello', ev => {
        const h = JSON.parse(ev.data); syncClock(h.now);
        if (c.state && h.v !== c.state.v) c.load().catch(() => {});
        c.online = true; emit('online');
      });
      es.onerror = () => { c.online = false; emit('offline'); };
    }

    c.dispatch = async (cmd, payload) => {
      const j = await http('POST', '/api/commands/' + cmd, payload || {});
      syncClock(j.now);
      return j.result;
    };
    c.searchPatients = async q => (await http('GET', '/api/patients/search?q=' + encodeURIComponent(q))).patients;
    c.patientHistory = async pid => (await http('GET', '/api/patients/' + encodeURIComponent(pid))).visits;
    c.listUsers = async () => (await http('GET', '/api/users')).users;
    c.createUser = u => http('POST', '/api/users', u);
    c.updateUser = (id, patch) => http('PATCH', '/api/users/' + id, patch);
    c.copilot = messages => http('POST', '/api/copilot', { messages });
    c.exportCsv = async (from, to) => {
      const r = await http('GET', `/api/export/visits.csv?from=${from}&to=${to}`, null, true);
      const blob = await r.blob(); const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `raycare-visits-${from}-${to}.csv`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      return true;
    };
    return c;
  }

  /* ------------------------------------------------------------- demo */
  const DEMO_USERS = {
    admin: { id: 'demo-admin', name: 'Dr. Meera Iyer', role: 'admin', email: 'admin@demo.local' },
    desk: { id: 'demo-desk', name: 'Salma (Front desk)', role: 'desk', email: 'desk@demo.local' },
    doctor: { id: 'demo-doctor', name: 'Dr. Anil Rao', role: 'doctor', dept: 'CAR', email: 'doctor@demo.local' },
    nurse: { id: 'demo-nurse', name: 'Joseph (ER nurse)', role: 'nurse', email: 'nurse@demo.local' }
  };
  function demo() {
    const Sim = root.RayCareSimulator;
    const listeners = new Set();
    const STEP = 2 * E.MIN, TICK = 2600;
    let simNow = E.atMinute(Date.now(), 10 * 60 + 40);
    let d = Sim.createDemo(simNow);
    let timer = null;
    const c = {
      mode: 'demo', state: d.state, user: DEMO_USERS.admin, features: { demo: true, copilot: false }, speed: 1, online: true, signedIn: true,
      now: () => simNow,
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    };
    const emit = why => listeners.forEach(fn => { try { fn(why); } catch (e) { console.error(e); } });
    const flush = () => { d.engine.takeDelta(simNow); emit('delta'); };
    function loop() {
      clearInterval(timer);
      if (c.speed > 0) timer = setInterval(() => { for (let i = 0; i < c.speed; i++) { simNow += STEP; d.sim.step(simNow); } flush(); }, TICK);
    }
    c.setSpeed = s => { c.speed = s; loop(); emit('speed'); };
    c.setManual = (dept, on) => { if (on) d.sim.manual.add(dept); else d.sim.manual.delete(dept); };
    c.isManual = dept => d.sim.manual.has(dept);
    c.setRole = r => { c.user = DEMO_USERS[r] || DEMO_USERS.admin; emit('role'); };
    c.dispatch = async (cmd, payload) => {
      const actor = { id: c.user.id, role: c.user.role, name: c.user.name };
      try { const r = d.engine.dispatch(cmd, payload, actor, simNow); flush(); return r; }
      catch (e) { flush(); throw new ApiError(400, e.code || 'error', e.message); }
    };
    c.searchPatients = async q => { q = q.toLowerCase(); return Object.values(c.state.patients).filter(p => (p.name + ' ' + p.pid + ' ' + (p.phone || '')).toLowerCase().includes(q)).slice(0, 25); };
    c.patientHistory = async pid => { const p = c.state.patients[pid]; return p ? p.visits.map(id => c.state.visits[id]).filter(Boolean).reverse() : []; };
    c.listUsers = async () => Object.values(DEMO_USERS).map(u => ({ ...u, active: true, createdAt: c.state.hospital.createdAt }));
    c.createUser = async () => { throw new ApiError(400, 'demo', 'Staff accounts are created on your own RayCare server.'); };
    c.updateUser = c.createUser;
    c.exportCsv = async () => { throw new ApiError(400, 'demo', 'CSV export runs on your RayCare server.'); };
    c.finishSetup = async cfg => {
      // In the demo, the wizard rebuilds the browser hospital with your answers.
      const st = E.createState({ hospital: { ...cfg.hospital, setupComplete: true, createdAt: simNow }, depts: cfg.depts, wards: ['ICU', 'GW', 'PW'].map(id => ({ id, count: Number(cfg.wards[id]) || 0 })) });
      const engine = E.createEngine(st); engine.ensureSlots(simNow);
      d = { state: st, engine, sim: Sim.createSimulator(engine) };
      c.state = st; c.user = { ...DEMO_USERS.admin, name: cfg.admin && cfg.admin.name || DEMO_USERS.admin.name };
      engine.takeDelta(simNow); loop(); emit('load'); return c;
    };
    c.reset = () => { simNow = E.atMinute(Date.now(), 10 * 60 + 40); d = Sim.createDemo(simNow); c.state = d.state; loop(); emit('load'); };
    c.logout = () => emit('logout');
    loop();
    return c;
  }

  root.RayCareClient = {
    ApiError, DEMO_USERS,
    async connect(opts = {}) {
      const h = opts.forceDemo ? null : await probe();
      return h ? remote(h) : demo();
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
