'use strict';
/**
 * Patient notifications in the patient's own language.
 *
 * Three moments: token issued, three patients ahead, and "your turn".
 * Providers:
 *   console  — prints messages to the server log (default; good for pilots)
 *   webhook  — POSTs JSON to NOTIFY_WEBHOOK_URL, signed with HMAC-SHA256.
 *              Point it at your SMS / WhatsApp gateway, n8n, Zapier or a
 *              small script — RayCare stays vendor-neutral.
 *   none     — disabled
 */
const crypto = require('node:crypto');
const E = require('../shared/engine.js');

const T = {
  en: {
    registered: (v, m, url) => `${v.hospital}: your token is ${v.tok} for ${v.deptName}. Estimated wait ${m} min. Track live: ${url}`,
    near: v => `${v.hospital}: ${v.ahead} patients are ahead of token ${v.tok}. Please come back to the waiting area.`,
    called: v => `${v.hospital}: token ${v.tok}, it's your turn. Please go to ${v.room}.`
  },
  hi: {
    registered: (v, m, url) => `${v.hospital}: आपका टोकन ${v.tok} (${v.deptName}) है। अनुमानित प्रतीक्षा ${m} मिनट। लाइव देखें: ${url}`,
    near: v => `${v.hospital}: टोकन ${v.tok} से पहले ${v.ahead} मरीज़ हैं। कृपया प्रतीक्षा क्षेत्र में लौट आएँ।`,
    called: v => `${v.hospital}: टोकन ${v.tok}, आपकी बारी है। कृपया ${v.room} में जाएँ।`
  },
  te: {
    registered: (v, m, url) => `${v.hospital}: మీ టోకెన్ ${v.tok} (${v.deptName}). అంచనా నిరీక్షణ ${m} నిమిషాలు. లైవ్: ${url}`,
    near: v => `${v.hospital}: టోకెన్ ${v.tok} ముందు ${v.ahead} మంది ఉన్నారు. దయచేసి వేచి ఉండే ప్రాంతానికి రండి.`,
    called: v => `${v.hospital}: టోకెన్ ${v.tok}, మీ వంతు వచ్చింది. దయచేసి ${v.room} కి వెళ్ళండి.`
  }
};

function createNotifier({ cfg, store, log }) {
  const provider = cfg.notify.provider;

  async function deliver(msg) {
    if (provider === 'none') return 'skipped';
    if (provider === 'webhook' && cfg.notify.webhookUrl) {
      const body = JSON.stringify(msg);
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.notify.webhookSecret) headers['X-RayCare-Signature'] = 'sha256=' + crypto.createHmac('sha256', cfg.notify.webhookSecret).update(body).digest('hex');
      const r = await fetch(cfg.notify.webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('Webhook responded ' + r.status);
      return 'sent';
    }
    log.info(`[notify] ${msg.kind} → ${E.maskPhone(msg.to)} (${msg.lang}): ${msg.text}`);
    return 'logged';
  }

  function send(v, kind, text, now) {
    const msg = { kind, to: v.phone, lang: v.lang, text, token: v.tok, visitId: v.id, at: new Date(now).toISOString() };
    deliver(msg)
      .then(status => store.logNotification({ t: now, visitId: v.id, channel: provider, recipient: E.maskPhone(v.phone), kind, status }))
      .catch(err => { log.warn(`Notification failed for ${v.tok}: ${err.message}`); store.logNotification({ t: now, visitId: v.id, channel: provider, recipient: E.maskPhone(v.phone), kind, status: 'failed', detail: err.message }); });
  }

  /* Look at what just changed and send any messages that are now due. */
  function check(delta, st, now, markNotified) {
    if (provider === 'none' || !delta || !delta.visits) return;
    const depts = new Set(delta.visits.map(v => v.dept));
    const due = [];
    for (const id of depts) {
      const d = E.dept(st, id); if (!d || id === 'ER') continue;
      E.waiting(st, id).forEach((v, i) => {
        const p = st.patients[v.pid]; if (!p || !p.phone) return;
        const ctx = { hospital: st.hospital.name, tok: v.tok, deptName: d.name, room: d.room, ahead: i, phone: p.phone, lang: v.lang, id: v.id };
        const tpl = T[v.lang] || T.en;
        if (!v.notified.registered) due.push([v.id, 'registered', ctx, tpl.registered(ctx, E.eta(st, v.id, now).mins, `${cfg.publicUrl}/t/?v=${encodeURIComponent(v.id)}&k=${v.trackKey}`)]);
        else if (i <= 3 && i > 0 && !v.notified.near) due.push([v.id, 'near', ctx, tpl.near(ctx)]);
      });
      const cur = st.serving[id] && st.visits[st.serving[id]];
      if (cur && !cur.notified.called) {
        const p = st.patients[cur.pid];
        if (p && p.phone) { const ctx = { hospital: st.hospital.name, tok: cur.tok, room: d.room, phone: p.phone, lang: cur.lang, id: cur.id }; due.push([cur.id, 'called', ctx, (T[cur.lang] || T.en).called(ctx)]); }
      }
    }
    for (const [id, kind, ctx, text] of due) {
      markNotified(id, kind);
      send({ id, tok: ctx.tok, phone: ctx.phone, lang: ctx.lang }, kind, text, now);
    }
  }

  return { check, templates: T };
}

module.exports = { createNotifier };
