#!/usr/bin/env node
'use strict';
/**
 * RayCare OS server entry point.
 *   npm start        production (real clock, your hospital)
 *   npm run demo     demo hospital with simulated patients (resets each start)
 */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`RayCare needs Node.js 22.5 or newer (you have ${process.versions.node}). Download it from https://nodejs.org`);
  process.exit(1);
}
// node:sqlite prints an "experimental" warning on Node 22; it is stable for our use.
process.removeAllListeners('warning');
process.on('warning', w => { if (!(w.name === 'ExperimentalWarning' && /SQLite/.test(w.message))) console.warn(w); });

const { build } = require('./config.js');
const { createApp } = require('./app.js');

const cfg = build(process.argv.includes('--demo') ? { DEMO_MODE: 'true' } : {});
const { app, runtime, users, log, close } = createApp(cfg);

const server = app.listen(cfg.port, cfg.host, () => {
  const line = '─'.repeat(58);
  console.log(`\n${line}\n  RayCare OS ${require('../shared/engine.js').VERSION} is running${cfg.demo ? ' in DEMO mode' : ''}\n${line}`);
  console.log(`  Website        ${cfg.publicUrl}/`);
  console.log(`  Staff app      ${cfg.publicUrl}/app/`);
  console.log(`  Lobby TV       ${cfg.publicUrl}/tv/`);
  console.log(`  QR check-in    ${cfg.publicUrl}/checkin/`);
  if (!runtime.ready && users.count() === 0) console.log(`\n  First run: open ${cfg.publicUrl}/app/ to start the setup wizard.`);
  if (cfg.demo) console.log('\n  Demo logins (password demo1234): admin@demo.local, desk@demo.local,\n  doctor@demo.local, nurse@demo.local');
  console.log(`\n  Data: ${cfg.dbFile}\n${line}\n`);
});

function shutdown(sig) {
  log.info(`${sig} received, shutting down`);
  server.close(() => { close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
