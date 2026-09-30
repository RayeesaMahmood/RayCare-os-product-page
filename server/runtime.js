'use strict';
/**
 * Runtime — the one place where commands are executed.
 *
 *   request ─▶ runtime.exec(command, payload, actor)
 *                 ├─ engine.dispatch()      validate + apply business rules
 *                 ├─ engine.takeDelta()     collect changed entities
 *                 ├─ store.persist(delta)   one SQLite transaction
 *                 ├─ hub.broadcast(delta)   push to every open screen (SSE)
 *                 └─ notifier.check(delta)  SMS / WhatsApp / webhook
 *
 * Node runs one command at a time, so there are no race conditions between
 * two desks calling the same patient. If the database write fails the engine
 * is reloaded from the database, so memory never drifts from disk.
 */
const E = require('../shared/engine.js');
const Sim = require('../shared/simulator.js');
const crypto = require('node:crypto');

function createClock(cfg) {
  if (!cfg.demo) return { now: () => Date.now(), rate: 1 };
  // Demo mode: a virtual clock that starts at 10:40 today and runs faster.
  const t0 = Date.now(), base = E.atMinute(t0, 10 * 60 + 40);
  return { now: () => base + (Date.now() - t0) * cfg.demoSpeed, rate: cfg.demoSpeed };
}

function createHub(log) {
  const clients = new Set();
  const publicClients = new Set();
  setInterval(() => { for (const c of [...clients, ...publicClients]) c.res.write(': ping\n\n'); }, 25000).unref();
  function add(set, req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const c = { res, user: req.user };
    set.add(c);
    req.on('close', () => set.delete(c));
    return c;
  }
  return {
    addStaff: (req, res) => add(clients, req, res),
    addPublic: (req, res) => add(publicClients, req, res),
    broadcast(delta, boardFn) {
      if (delta && clients.size) { const msg = `event: delta\ndata: ${JSON.stringify(delta)}\n\n`; for (const c of clients) c.res.write(msg); }
      if (publicClients.size) { const msg = `event: board\ndata: ${JSON.stringify(boardFn())}\n\n`; for (const c of publicClients) c.res.write(msg); }
    },
    size: () => clients.size + publicClients.size,
    log
  };
}

function createRuntime({ cfg, store, notifier, log }) {
  const clock = createClock(cfg);
  const hub = createHub(log);
  let engine = null, sim = null, timer = null;
  const genKey = () => crypto.randomBytes(6).toString('base64url');

  function boot() {
    const now = clock.now();
    if (cfg.demo && !store.isSetup()) {
      const demo = Sim.createDemo(now);
      store.saveFull(demo.state);
      log.info(`Demo hospital created: ${Object.keys(demo.state.visits).length} visits so far today`);
    }
    if (store.isSetup()) {
      engine = E.createEngine(store.load(now), { genKey });
      engine.tick(now); flush(now);
      if (cfg.demo) sim = Sim.createSimulator(engine);
    }
    if (timer) clearInterval(timer);
    const every = cfg.demo ? Math.max(1000, Math.round(2 * E.MIN / cfg.demoSpeed)) : cfg.tickMs;
    timer = setInterval(tick, every);
    timer.unref();
  }

  function flush(now) {
    const delta = engine.takeDelta(now);
    if (!delta) return null;
    try { store.persist(delta); }
    catch (e) {
      log.error('Persist failed, reloading state from database', e);
      engine = E.createEngine(store.load(now), { genKey });
      if (sim) sim = Sim.createSimulator(engine);
      throw e;
    }
    hub.broadcast(delta, () => E.board(engine.state, now));
    notifier.check(delta, engine.state, now, (id, kind) => {
      engine.dispatch('markNotified', { id, kind }, { role: 'system', name: 'Notifier' }, now);
      const d2 = engine.takeDelta(now); if (d2) store.persist(d2);
    });
    return delta;
  }

  function exec(command, payload, actor) {
    if (!engine) { const e = new Error('Hospital is not set up yet'); e.name = 'EngineError'; e.code = 'not_setup'; throw e; }
    const now = clock.now();
    const result = engine.dispatch(command, payload, actor, now);
    const delta = flush(now);
    return { result, v: delta ? delta.v : engine.state.v };
  }

  function tick() {
    if (!engine) return;
    const now = clock.now();
    try {
      if (sim) sim.step(now); else engine.tick(now);
      flush(now);
    } catch (e) { log.error('Tick failed', e); }
  }

  /* First-run setup: build a fresh hospital from the wizard answers. */
  function setup(config) {
    const now = clock.now();
    const st = E.createState({ ...config, hospital: { ...config.hospital, setupComplete: true, createdAt: now } });
    const eng = E.createEngine(st, { genKey });
    eng.ensureSlots(now); eng.tick(now); eng.takeDelta(now);
    store.saveFull(st);
    engine = eng;
    return st;
  }

  return {
    boot, exec, setup, tick, clock, hub,
    get engine() { return engine; },
    get ready() { return !!engine; },
    stop() { if (timer) clearInterval(timer); }
  };
}

module.exports = { createRuntime };
