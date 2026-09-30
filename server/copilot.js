'use strict';
/**
 * RayCare Copilot (server side). Optional: enabled when ANTHROPIC_API_KEY is
 * set. Claude reads a live snapshot and can call a small set of tools. Every
 * tool runs through runtime.exec as the signed-in user, so the same role
 * permissions and audit log apply as when staff click buttons.
 */
const E = require('../shared/engine.js');

const SYSTEM = `You are RayCare Copilot, the operations assistant inside RayCare OS, a hospital patient-flow system.
Staff ask about queues, the emergency department, beds and patients, or ask you to act.
Base every answer on the live snapshot or tool results and never invent patients or numbers.
When asked to do something, use the tools. Clinical decisions stay with clinicians: you may flag risk but never diagnose.
Reply in plain text, under 90 words, short sentences, no markdown headings.`;

const TOOLS = [
  { name: 'get_snapshot', description: 'Live hospital state: departments, emergency, ambulances, beds, pending admissions, today\'s stats.', input_schema: { type: 'object', properties: {} } },
  { name: 'call_next', description: 'Call the next patient in a department queue. Returns the token called.', input_schema: { type: 'object', properties: { department: { type: 'string', description: 'Department id, e.g. CAR' } }, required: ['department'] } },
  { name: 'register_patient', description: 'Register a walk-in patient and issue a token.', input_schema: { type: 'object', properties: { name: { type: 'string' }, department: { type: 'string' }, priority: { type: 'boolean' } }, required: ['name', 'department'] } },
  { name: 'assign_bed', description: 'Assign the best free bed to the oldest pending admission, or to request_id.', input_schema: { type: 'object', properties: { request_id: { type: 'string' } } } }
];

function resolveDept(st, x) {
  x = String(x || '').toLowerCase();
  const d = st.depts.find(d => d.id.toLowerCase() === x || d.name.toLowerCase().includes(x) || x.includes(d.name.toLowerCase().slice(0, 5)));
  return d && d.id;
}

function createCopilot({ cfg, runtime, log }) {
  const enabled = !!cfg.copilot.apiKey;

  function runTool(name, input, actor) {
    const st = runtime.engine.state, now = runtime.clock.now();
    switch (name) {
      case 'get_snapshot': return E.snapshot(st, now);
      case 'call_next': return runtime.exec('callNext', { dept: resolveDept(st, input.department) }, actor).result;
      case 'register_patient': return runtime.exec('registerPatient', { name: input.name, dept: resolveDept(st, input.department), priority: !!input.priority, source: 'Registered by Copilot' }, actor).result;
      case 'assign_bed': return runtime.exec('assignBed', { reqId: input.request_id }, actor).result;
      default: throw new Error('Unknown tool');
    }
  }

  async function chat(messages, actor) {
    const st = runtime.engine.state, now = runtime.clock.now();
    const convo = [{ role: 'user', content: 'Live snapshot:\n' + JSON.stringify(E.snapshot(st, now)) }, { role: 'assistant', content: 'Understood. I have the live snapshot.' }, ...messages.slice(-12)];
    const actions = [];
    for (let round = 0; round < 5; round++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.copilot.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.copilot.model, max_tokens: 600, system: SYSTEM, tools: TOOLS, messages: convo }),
        signal: AbortSignal.timeout(60000)
      });
      if (!r.ok) { const t = await r.text(); log.warn('Copilot API error ' + r.status + ' ' + t.slice(0, 200)); throw Object.assign(new Error('The AI service is unavailable right now.'), { status: 502 }); }
      const data = await r.json();
      convo.push({ role: 'assistant', content: data.content });
      const uses = data.content.filter(c => c.type === 'tool_use');
      if (!uses.length || data.stop_reason !== 'tool_use') return { text: data.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim(), actions };
      const results = uses.map(u => {
        try { const out = runTool(u.name, u.input || {}, actor); actions.push({ tool: u.name, input: u.input, ok: true }); return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 20000) }; }
        catch (e) { actions.push({ tool: u.name, input: u.input, ok: false, error: e.message }); return { type: 'tool_result', tool_use_id: u.id, content: 'Error: ' + e.message, is_error: true }; }
      });
      convo.push({ role: 'user', content: results });
    }
    return { text: 'I ran out of steps for that request. Try asking for one thing at a time.', actions };
  }

  return { enabled, chat };
}

module.exports = { createCopilot };
