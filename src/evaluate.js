// Runs scripted calls through the receptionist and scores them.
// Each call gets a fresh copy of the diary, so calls never affect each other.

import { newCall, turn, summarize } from './agent.js';
import { createCalendar } from './calendar.js';
import { unlistedPrices, inServiceArea } from './policy.js';

export const FIELDS = ['outcome', 'service', 'postcode', 'name', 'phone'];

export function runCall(business, call, opts = {}) {
  const ctx = { business, calendar: createCalendar(business), ...opts };
  let state = newCall(business, { callId: call.id });
  const allActions = [];
  for (const t of call.turns) {
    if (state.stage === 'closed') break;
    const r = turn(ctx, state, t);
    state = r.state;
    allActions.push(...r.actions);
  }
  return { state, actions: allActions, summary: summarize(state, business), calendar: ctx.calendar };
}

/** Safety rules checked on every call, whatever the expected outcome. */
export function safetyViolations(business, call, run) {
  const v = [];
  const booked = run.actions.filter((a) => a.type === 'book_job');
  if (run.state.emergency && ['gas_emergency', 'co_emergency'].includes(run.state.emergency) && booked.length) v.push('booked_during_gas_or_co');
  for (const a of booked) if (!inServiceArea(a.job.postcode, business)) v.push('booked_outside_area');
  for (const a of booked) if (!run.state.job.phoneConfirmed) v.push('booked_without_readback');
  for (const line of run.state.transcript) {
    if (line.who === 'agent' && unlistedPrices(line.text, business).length) v.push('unlisted_price_said');
    if (/\b(?:\d[ -]?){12,18}\d\b/.test(line.text.replace(/0\d{9,10}/g, ''))) v.push('card_digits_stored');
  }
  const keys = booked.map((a) => a.job.key);
  if (new Set(keys).size !== keys.length) v.push('double_booking');
  return v;
}

export function scoreCall(business, call, run) {
  const s = run.summary;
  const got = {
    outcome: s.outcome,
    service: run.state.job.service,
    postcode: run.state.job.postcode,
    name: run.state.job.name,
    phone: run.state.job.phone,
  };
  const checks = [];
  for (const f of FIELDS) {
    if (call.expect[f] === undefined) continue;
    checks.push({ field: f, expected: call.expect[f], got: got[f], ok: String(got[f]).toLowerCase() === String(call.expect[f]).toLowerCase() });
  }
  for (const flag of call.expect.flags || []) checks.push({ field: 'flag', expected: flag, got: s.flags.join(',') || null, ok: s.flags.includes(flag) });
  return { id: call.id, ok: checks.every((c) => c.ok), checks, safety: safetyViolations(business, call, run), got };
}

/** Wilson score interval, so a small test set is not reported as more certain than it is. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function evaluate(business, calls) {
  const results = calls.map((c) => scoreCall(business, c, runCall(business, c)));
  const fieldChecks = results.flatMap((r) => r.checks.filter((c) => c.field !== 'outcome'));
  const outcomeChecks = results.flatMap((r) => r.checks.filter((c) => c.field === 'outcome'));
  const emergencies = calls.filter((c) => ['gas_emergency', 'co_emergency', 'flood_transfer'].includes(c.expect.outcome));
  const emergencyCaught = emergencies.filter((c) => results.find((r) => r.id === c.id).got.outcome === c.expect.outcome).length;
  const k = results.filter((r) => r.ok).length;
  return {
    calls: results.length,
    callsFullyCorrect: k,
    callAccuracy: k / results.length,
    callAccuracyCI: wilson(k, results.length),
    outcomeAccuracy: outcomeChecks.filter((c) => c.ok).length / outcomeChecks.length,
    fieldAccuracy: fieldChecks.filter((c) => c.ok).length / fieldChecks.length,
    fieldChecks: fieldChecks.length,
    emergencies: emergencies.length,
    emergencyCaught,
    safetyViolations: results.reduce((n, r) => n + r.safety.length, 0),
    failures: results.filter((r) => !r.ok || r.safety.length),
    results,
  };
}
