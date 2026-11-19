import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/webhook.js';

async function withServer(fn) {
  const server = createServer({ secret: 's3cret', retellKey: '' });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
const vapi = (base, calls, auth = 'Bearer s3cret') => fetch(`${base}/vapi`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: auth },
  body: JSON.stringify({ message: { type: 'tool-calls', call: { id: 'c1' }, toolCallList: calls.map(([name, args], i) => ({ id: `t${i}`, type: 'function', function: { name, arguments: args } })) } }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('webhook: requests without the secret are refused', async () => {
  await withServer(async (base) => {
    assert.equal((await vapi(base, [['get_price', { service: 'boiler_service' }]], 'Bearer wrong')).status, 401);
  });
});

test('webhook: an LLM cannot book a job after the caller reported a gas smell', async () => {
  await withServer(async (base) => {
    const r = await vapi(base, [
      ['triage', { caller_said: 'I can smell gas' }],
      ['book_job', { slot_key: '2026-11-23:priya:am', service: 'boiler_service', postcode: 'LS6', name: 'Ann', phone: '07700900111', phone_confirmed: true }],
    ]);
    const [triage, booking] = r.body.results.map((x) => JSON.parse(x.result));
    assert.equal(triage.emergency, 'gas_emergency');
    assert.match(triage.say_exactly, /0800 111 999/);
    assert.equal(booking.booked, false);
    assert.ok(booking.blocked_by.includes('gas_or_co_emergency'));
  });
});

test('webhook: booking needs a confirmed phone and refuses a slot that is already taken', async () => {
  await withServer(async (base) => {
    const job = { slot_key: '2026-11-23:priya:am', service: 'boiler_service', postcode: 'LS6 2AB', name: 'Ann', phone: '07700 900111' };
    const a = JSON.parse((await vapi(base, [['book_job', { ...job, phone_confirmed: false }]])).body.results[0].result);
    assert.deepEqual(a.blocked_by, ['phone_not_read_back']);
    const b = JSON.parse((await vapi(base, [['book_job', { ...job, phone_confirmed: true }]])).body.results[0].result);
    assert.equal(b.booked, true);
    const c = JSON.parse((await vapi(base, [['book_job', { ...job, name: 'Someone else', phone_confirmed: true }]])).body.results[0].result);
    assert.deepEqual(c.blocked_by, ['slot_taken']);
    assert.ok(c.alternatives.length > 0);
  });
});

test('webhook: Retell-style call returns the listed price only', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/retell/get_price`, { method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: JSON.stringify({ name: 'get_price', args: { service: 'underfloor_heating' }, call: { call_id: 'r1' } }) });
    const body = await r.json();
    assert.equal(body.known, false);
    assert.doesNotMatch(body.say, /£/);
  });
});
