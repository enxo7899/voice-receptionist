// Webhook for voice platforms. Vapi sends "tool-calls" server messages; Retell sends
// custom function calls. Both end up in the same tools, so the same rules apply.
//
//   WEBHOOK_SECRET=change-me node server/webhook.js
//   Vapi:   POST /vapi          Authorization: Bearer <WEBHOOK_SECRET>
//   Retell: POST /retell/<fn>   X-Retell-Signature checked with retell-sdk when RETELL_API_KEY is set
//
// The diary lives in memory here. In production put it in your booking system or a database.

import http from 'node:http';
import fs from 'node:fs';
import { createTools } from './tools.js';

const business = JSON.parse(fs.readFileSync(new URL('../data/business.json', import.meta.url)));

export function createServer({ secret = process.env.WEBHOOK_SECRET, retellKey = process.env.RETELL_API_KEY } = {}) {
  const { tools } = createTools(business);

  async function readBody(req) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new Error('too large'); }
    return raw;
  }
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  function run(name, args, call) {
    const fn = tools[name];
    if (!fn) return { error: `unknown tool ${name}` };
    try { return { result: fn(args || {}, call) }; } catch (e) { return { error: e.message }; }
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    let raw;
    try { raw = await readBody(req); } catch { return send(res, 413, { error: 'too large' }); }
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }

    if (url.pathname === '/vapi') {
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'unauthorised' });
      const msg = body.message || {};
      if (msg.type !== 'tool-calls') return send(res, 200, {});
      const call = { id: msg.call?.id || 'vapi' };
      const results = (msg.toolCallList || []).map((tc) => {
        const name = tc.function?.name || tc.name;
        let args = tc.function?.arguments ?? tc.arguments ?? {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        const out = run(name, args, call);
        return out.error ? { toolCallId: tc.id, name, error: out.error } : { toolCallId: tc.id, name, result: JSON.stringify(out.result) };
      });
      return send(res, 200, { results });
    }

    const m = url.pathname.match(/^\/retell\/([a-z_]+)$/);
    if (m) {
      if (retellKey) {
        let Retell;
        try { ({ Retell } = await import('retell-sdk')); } catch { return send(res, 500, { error: 'install retell-sdk to verify signatures' }); }
        if (!Retell.verify(raw, retellKey, req.headers['x-retell-signature'])) return send(res, 401, { error: 'bad signature' });
      } else if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
        return send(res, 401, { error: 'unauthorised' });
      }
      const args = body.args ?? body;
      const out = run(m[1], args, { id: body.call?.call_id || 'retell' });
      return send(res, out.error ? 400 : 200, out.error ? { error: out.error } : out.result);
    }
    return send(res, 404, { error: 'not found' });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.WEBHOOK_SECRET && !process.env.RETELL_API_KEY) {
    console.error('Set WEBHOOK_SECRET (and/or RETELL_API_KEY) first.');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 8787);
  createServer().listen(port, () => console.log(`Receptionist tools on http://localhost:${port} (POST /vapi, POST /retell/<tool>)`));
}
