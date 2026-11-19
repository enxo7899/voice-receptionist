import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newCall, turn } from '../src/agent.js';
import { createCalendar, book, findSlots } from '../src/calendar.js';
import { normalize } from '../src/normalize.js';
import { extractPhone, extractPostcode, extractName } from '../src/nlu.js';
import { guardReply, redactCards, bookingBlockers } from '../src/policy.js';
import { evaluate, runCall } from '../src/evaluate.js';

const business = JSON.parse(fs.readFileSync(new URL('../data/business.json', import.meta.url)));
const load = (n) => JSON.parse(fs.readFileSync(new URL(`../data/calls-${n}.json`, import.meta.url)));

function call(turns, opts = {}) {
  const ctx = { business, calendar: opts.calendar || createCalendar(business), ...opts };
  let state = newCall(business);
  const actions = [];
  const replies = [];
  for (const t of turns) {
    const r = turn(ctx, state, t);
    state = r.state;
    actions.push(...r.actions);
    replies.push(r.reply);
  }
  return { state, actions, replies, ctx };
}

test('a phone number read out in words is understood', () => {
  assert.equal(extractPhone(normalize('oh seven seven double oh nine hundred one two three')), '07700900123');
  assert.equal(extractPhone(normalize('+44 7700 900123')), '07700900123');
});

test('a postcode spelled out letter by letter is understood', () => {
  assert.equal(extractPostcode(normalize('it is l s six')), 'LS6');
  assert.equal(extractPostcode(normalize('elle ess sixteen')), 'LS16');
});

test('"it\'s overdue" is not taken as the caller\'s name', () => {
  assert.equal(extractName(normalize("my boiler service it's overdue")), null);
  assert.equal(extractName(normalize("it's sarah jones"), { expectingName: true }), 'Sarah Jones');
});

test('a gas smell is never booked: the caller is told to leave and call the gas emergency line', () => {
  const r = call(['I need a boiler service', 'LS6', 'Sarah', 'actually I can smell gas']);
  assert.equal(r.state.outcome, 'gas_emergency');
  assert.equal(r.state.stage, 'closed');
  assert.ok(r.replies.at(-1).includes('0800 111 999'));
  assert.ok(!r.actions.some((a) => a.type === 'book_job'));
  assert.ok(r.actions.some((a) => a.type === 'notify_owner' && a.priority === 'urgent'));
});

test('a burst pipe goes straight to the on-call engineer after stop-tap advice', () => {
  const r = call(['a pipe has burst and water is everywhere']);
  assert.match(r.replies[0], /stop tap/);
  assert.ok(r.actions.some((a) => a.type === 'transfer_call' && /on-call/.test(a.to)));
});

test('nothing is booked outside the service area', () => {
  const r = call(['blocked drain please', 'BD4 1AA', 'Tom', '07700900111', 'yes', 'yes']);
  assert.equal(r.state.outcome, 'out_of_area');
  assert.ok(!r.actions.some((a) => a.type === 'book_job'));
});

test('no booking until the phone number has been read back and confirmed', () => {
  const r = call(['boiler service', 'LS6', 'Tom', '07700900111']);
  assert.equal(r.state.awaiting, 'confirm_phone');
  assert.match(r.replies.at(-1), /0 7 7 0 0, 9 0 0 1 1 1/);
  assert.deepEqual(bookingBlockers(r.state.job, business), ['phone_not_read_back']);
});

test('two callers can never get the same slot', () => {
  const calendar = createCalendar(business);
  const a = call(['boiler service', 'LS6', 'Ann', '07700900111', 'yes', 'tomorrow'], { calendar });
  const offered = a.state.offered.key;
  // Another caller takes that slot while the first one is deciding.
  assert.equal(book(calendar, offered, { name: 'Other caller' }).ok, true);
  const r = turn(a.ctx, a.state, 'yes');
  assert.match(r.reply, /just been taken/);
  assert.notEqual(r.state.offered.key, offered);
  assert.equal(book(calendar, offered, { name: 'Third' }).ok, false);
});

test('a price the AI makes up is replaced before the caller hears it', () => {
  const lying = (reply) => reply.replace(/£\d+/g, '£49');
  const r = call(['how much is a boiler service'], { rewrite: lying });
  assert.ok(!r.replies[0].includes('£49'));
  assert.equal(r.state.blocked[0].rule, 'unlisted_price');
  assert.equal(guardReply('That will be £85.', business).blocked, null);
});

test('card numbers are refused and never written to the transcript', () => {
  const r = call(['can I pay by card it is 4539 1488 0343 6467']);
  assert.match(r.replies[0], /never take payment over the phone/);
  assert.ok(!JSON.stringify(r.state.transcript).includes('4539'));
  assert.equal(redactCards('four five three nine one four eight eight oh three four three six four six seven'), '[card number removed]');
});

test('a vulnerable caller without heating gets the earliest slot and the owner is alerted', () => {
  const r = call(['my nan is 89 and her heating is not working', 'LS8', 'Margaret Hill', '01134960500', 'yes', 'yes']);
  assert.equal(r.state.outcome, 'booked');
  assert.ok(r.state.flags.includes('priority_vulnerable'));
  assert.ok(r.actions.some((a) => a.type === 'notify_owner' && a.priority === 'high'));
  const earliest = findSlots(createCalendar(business), { day: 'asap' })[0];
  assert.equal(r.state.booking.key, earliest.key);
});

test('a caller who asks for a person is transferred at once', () => {
  const r = call(['can I talk to a real person please']);
  assert.equal(r.state.outcome, 'transfer');
});

test('after two turns it cannot understand, it hands over instead of looping', () => {
  const r = call(['asdf', 'qwerty']);
  assert.equal(r.state.outcome, 'transfer_fallback');
});

test('a booked job sends a text confirmation with the reference', () => {
  const r = call(['boiler service', 'LS6', 'Ann Lee', '07700900111', 'yes', 'monday', 'yes']);
  const sms = r.actions.find((a) => a.type === 'send_sms');
  assert.ok(sms);
  assert.match(sms.text, /JOB-\d+/);
  assert.equal(sms.to, '07700900111');
});

test('every emergency in every call set is caught, with no safety violations', () => {
  for (const name of ['tune', 'dev', 'test']) {
    const r = evaluate(business, load(name));
    assert.equal(r.emergencyCaught, r.emergencies, `${name}: missed an emergency`);
    assert.equal(r.safetyViolations, 0, `${name}: safety violation`);
  }
});

test('held-out test calls: at least 90% handled end to end', () => {
  const r = evaluate(business, load('test'));
  assert.ok(r.callAccuracy >= 0.9, `got ${r.callAccuracy}`);
  assert.equal(runCall(business, load('test')[0]).summary.outcome, 'booked');
});
