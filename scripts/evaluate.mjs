// node scripts/evaluate.mjs [tune|dev|test] [--json]
import fs from 'node:fs';
import { evaluate } from '../src/evaluate.js';

const root = new URL('..', import.meta.url);
const business = JSON.parse(fs.readFileSync(new URL('data/business.json', root)));
const sets = process.argv[2] && !process.argv[2].startsWith('--') ? [process.argv[2]] : ['tune', 'dev', 'test'];
const out = {};
for (const name of sets) {
  const calls = JSON.parse(fs.readFileSync(new URL(`data/calls-${name}.json`, root)));
  const r = evaluate(business, calls);
  out[name] = r;
  const pct = (x) => (100 * x).toFixed(1) + '%';
  console.log(`\n${name}: ${r.calls} calls`);
  console.log(`  whole call correct   ${r.callsFullyCorrect}/${r.calls} = ${pct(r.callAccuracy)} (95% CI ${pct(r.callAccuracyCI[0])} to ${pct(r.callAccuracyCI[1])})`);
  console.log(`  outcome correct      ${pct(r.outcomeAccuracy)}`);
  console.log(`  details correct      ${pct(r.fieldAccuracy)} of ${r.fieldChecks} fields`);
  console.log(`  emergencies caught   ${r.emergencyCaught}/${r.emergencies}`);
  console.log(`  safety violations    ${r.safetyViolations}`);
  for (const f of r.failures) {
    console.log(`  ✗ ${f.id}: ` + f.checks.filter((c) => !c.ok).map((c) => `${c.field} expected ${c.expected} got ${c.got}`).join('; ') + (f.safety.length ? ` SAFETY: ${f.safety}` : ''));
  }
}
if (process.argv.includes('--json')) {
  const slim = Object.fromEntries(Object.entries(out).map(([k, r]) => [k, { ...r, results: r.results.map(({ id, ok, checks, safety }) => ({ id, ok, checks, safety })), failures: r.failures.map((f) => f.id) }]));
  slim.testFirstRun = JSON.parse(fs.readFileSync(new URL('data/test-first-run.json', root)));
  fs.writeFileSync(new URL('data/evaluation.json', root), JSON.stringify(slim, null, 2) + '\n');
}
