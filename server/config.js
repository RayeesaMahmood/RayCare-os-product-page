'use strict';
/**
 * Configuration. Every value can be set with an environment variable or a
 * `.env` file next to package.json. Sensible defaults mean a fresh install
 * needs no configuration at all.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

/* Minimal .env loader (no dependency). Existing env vars win. */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

function build(overrides = {}) {
  loadDotEnv(path.join(ROOT, '.env'));
  const env = { ...process.env, ...overrides };
  const bool = v => /^(1|true|yes|on)$/i.test(String(v || ''));
  const demo = bool(env.DEMO_MODE);
  const dataDir = path.resolve(ROOT, env.DATA_DIR || 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // The signing secret is generated once and kept in the data folder, so a
  // fresh install is secure without anyone having to create one.
  let secret = env.JWT_SECRET;
  if (!secret) {
    const f = path.join(dataDir, '.secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('base64url'), { mode: 0o600 });
    secret = fs.readFileSync(f, 'utf8').trim();
  }
  if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

  const port = Number(env.PORT || 8080);
  return {
    root: ROOT,
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dataDir,
    dbFile: env.DB_FILE || path.join(dataDir, demo ? 'demo.db' : 'raycare.db'),
    secret,
    tokenTtlHours: Number(env.TOKEN_TTL_HOURS || 12),
    demo,
    demoSpeed: Math.max(1, Number(env.DEMO_SPEED || 20)),
    notify: { provider: env.NOTIFY_PROVIDER || (demo ? 'none' : 'console'), webhookUrl: env.NOTIFY_WEBHOOK_URL || '', webhookSecret: env.NOTIFY_WEBHOOK_SECRET || '' },
    copilot: { apiKey: env.ANTHROPIC_API_KEY || '', model: env.COPILOT_MODEL || 'claude-haiku-4-5-20251001' },
    serveWebsite: env.SERVE_WEBSITE ? bool(env.SERVE_WEBSITE) : true,
    trustProxy: bool(env.TRUST_PROXY),
    logRequests: env.LOG_REQUESTS !== 'false',
    tickMs: Number(env.TICK_MS || 5000)
  };
}

module.exports = { build, ROOT };
