/**
 * Building the rehearsal schedule from the runbook, and reading the contract addresses.
 *
 * test/fixtures/runbook-cranker-rows.csv is the runbook's Schedule tab as exported on 5 Oct 2026,
 * cut down to its header and Actor = Cranker rows (notes column blanked), plus two synthetic
 * rows that must be ignored: a section header and a row another actor sends.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDeployments } from '../src/rehearsal/deployments.mjs';
import {
  buildScheduleFromCsv, loadSchedule, parseActionCalls, parseCsv, parseExpect, parseRunbookTime, validateSchedule,
} from '../src/rehearsal/schedule.mjs';

const CSV = readFileSync(new URL('./fixtures/runbook-cranker-rows.csv', import.meta.url), 'utf8');
const built = buildScheduleFromCsv(CSV);
const byId = Object.fromEntries(built.doc.entries.map((e) => [e.id, e]));

describe('building the schedule from the runbook CSV', () => {
  it('takes Actor = Cranker rows only', () => {
    assert.ok(!built.doc.entries.some((e) => e.step === 900), 'a row another actor sends leaked in');
    assert.equal(built.doc.chainId, 314159);
  });

  it('step 73: QuarterlyGateCheck(Q5), an unnamed revert, gate must be at Q5', () => {
    assert.deepEqual(
      { fn: byId['73'].function, args: byId['73'].args, q: byId['73'].gateQuarter, expect: byId['73'].expect, at: byId['73'].notBefore },
      { fn: 'quarterlyGateCheck', args: [], q: 5, expect: 'revert:*', at: '2026-10-05T13:45:00Z' },
    );
  });

  it('steps 78, 79, 80 at 22:15, 22:20, 22:25: pass, fail, StepWeightRecordsFailed (named in the Watchtower column)', () => {
    assert.deepEqual(['78', '79', '80'].map((id) => [byId[id].notBefore, byId[id].expect, byId[id].gateQuarter]), [
      ['2026-10-05T22:15:00Z', 'pass', 5],
      ['2026-10-05T22:20:00Z', 'fail', 6],
      ['2026-10-05T22:25:00Z', 'revert:StepWeightRecordsFailed', 7],
    ]);
  });

  it('step 93 holds two calls, in order, at the same time', () => {
    assert.deepEqual(
      [byId['93.1'], byId['93.2']].map((e) => [e.function, e.args, e.expect, e.notBefore]),
      [['submitShares', [8], 'pass', '2026-10-06T19:00:00Z'], ['quarterlyGateCheck', [], 'pass', '2026-10-06T19:00:00Z']],
    );
  });

  it('step 117: QuarterlyGateCheck(Q11), revert StepsComplete', () => {
    assert.equal(byId['117'].expect, 'revert:StepsComplete');
    assert.equal(byId['117'].notBefore, '2026-10-09T19:15:00Z');
  });

  it('step 13: the "Read aggregatedFilecoinPayVolume" part is a read, not a send', () => {
    assert.deepEqual(['13.1', '13.2'].map((id) => byId[id]?.function), ['submitShares', 'quarterlyGateCheck']);
    assert.equal(byId['13.3'], undefined);
    assert.equal(byId['13.2'].expect, 'revert:NotBound');
  });

  it('the window closes at Closes (UTC) plus the grace period', () => {
    assert.equal(byId['80'].notAfter, '2026-10-05T23:10:00Z'); // closes 22:40 + 30 min: before step 78's hold ends
    assert.equal(buildScheduleFromCsv(CSV, { graceMinutes: 0 }).doc.entries.find((e) => e.id === '80').notAfter, '2026-10-05T22:40:00Z');
  });

  it('keeps the runbook status, so Complete rows can be skipped', () => {
    assert.equal(byId['16.2'].status, 'Complete');
    assert.equal(byId['80'].status, 'Pending');
  });

  it('every assumption is reported for a person to check', () => {
    assert.ok(built.warnings.some((w) => /step 80: revert name StepWeightRecordsFailed taken from the Watchtower/.test(w)));
    assert.ok(built.warnings.some((w) => /step 73: revert without a named error/.test(w)));
  });

  it('the committed config/rehearsal-schedule.json is a valid schedule', () => {
    const s = loadSchedule(fileURLToPath(new URL('../config/rehearsal-schedule.json', import.meta.url)));
    assert.ok(s.entries.length > 0);
    assert.ok(s.entries.every((e) => e.notBeforeMs < e.notAfterMs));
  });
});

describe('reading the Action prose', () => {
  it('a second call counts only when "then" introduces it', () => {
    const { calls, warnings } = parseActionCalls('QuarterlyGateCheck(Q7), revert, the hold (re-run QuarterlyGateCheck(Q7) Tue 08:00)');
    assert.equal(calls.length, 1);
    assert.match(warnings[0], /mentioned, not introduced with "then"/);
  });

  it('an outcome belongs to the call it follows, not the one before', () => {
    const { calls } = parseActionCalls('SubmitShares(Q3), then QuarterlyGateCheck(Q3), revert StepsComplete()');
    assert.deepEqual(calls.map((c) => c.expect), ['pass', 'revert:StepsComplete']);
  });

  it('negation: "do not call", "must not revert", "no longer reverts"', () => {
    const skipped = parseActionCalls('Nobody cranks: do not call QuarterlyGateCheck(Q5) this weekend');
    assert.equal(skipped.calls.length, 0);
    assert.match(skipped.warnings[0], /negated/);
    assert.equal(parseActionCalls('QuarterlyGateCheck(Q7), PASS (must not revert)').calls[0].expect, 'pass');
    assert.equal(parseActionCalls('QuarterlyGateCheck(Q7) no longer reverts, passes').calls[0].expect, 'pass');
  });

  it('"fails" and "Failed" mean fail for a gate check; both PASS and FAIL is flagged', () => {
    assert.equal(parseActionCalls('QuarterlyGateCheck(Q6) fails, value bound 0').calls[0].expect, 'fail');
    assert.equal(parseActionCalls('QuarterlyGateCheck(Q6), Failed').calls[0].expect, 'fail');
    const both = parseActionCalls('QuarterlyGateCheck(Q6), passes now that the earlier one failed');
    assert.match(both.calls[0].note, /both pass and fail/);
  });

  it('several error names in the Watchtower column: any revert, with a warning', () => {
    const r = parseActionCalls('QuarterlyGateCheck(Q7), revert', 'StepWeightRecordsFailed(code) or HoldUntil(epoch)');
    assert.equal(r.calls[0].expect, 'revert:*');
    assert.match(r.calls[0].note, /names several/);
  });

  it('the outcome after an ignored mention still belongs to the call', () => {
    const r = parseActionCalls('QuarterlyGateCheck(Q7), unlike QuarterlyGateCheck(Q5), revert StepsComplete()');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].expect, 'revert:StepsComplete');
  });

  it('a Closes time before Opens is reported', () => {
    const csv = 'Step,Qtr,Scenario,Actor,Action / command,Watchtower validation,Opens (UTC),Closes (UTC),Status\n' +
      '1,Q1,x,Cranker,SubmitShares(Q1),,Mon 2026-10-05 10:00,Mon 2026-10-05 09:00,Pending\n';
    assert.ok(buildScheduleFromCsv(csv).warnings.some((w) => /not after Opens/.test(w)));
  });

  it('accepts SubmitShares(6) and SubmitShares(Q6) alike', () => {
    assert.deepEqual(parseActionCalls('SubmitShares(6)').calls[0].args, [6]);
    assert.deepEqual(parseActionCalls('SubmitShares(Q6)').calls[0].args, [6]);
  });

  it('parses runbook times as UTC and notices a wrong weekday', () => {
    assert.equal(parseRunbookTime('Mon 2026-10-05 22:25').iso, '2026-10-05T22:25:00Z');
    assert.match(parseRunbookTime('Tue 2026-10-05 22:25').warning, /is a Mon/);
    assert.equal(parseRunbookTime('tbd'), null);
  });

  it('parses quoted CSV with commas, quotes and newlines', () => {
    assert.deepEqual(parseCsv('a,"b, ""c""\nd",e\n1,2,3\n'), [['a', 'b, "c"\nd', 'e'], ['1', '2', '3']]);
  });
});

describe('validating a schedule file', () => {
  const ok = { id: 'x', function: 'quarterlyGateCheck', args: [], notBefore: '2026-10-06T08:00:00Z', notAfter: '2026-10-06T10:15:00Z', expect: 'pass' };
  const bad = (over, re) => assert.throws(() => validateSchedule({ chainId: 314159, entries: [{ ...ok, ...over }] }), re);

  it('rejects anything that is not exactly specified', () => {
    bad({ function: 'removeOrchestrator' }, /not one of/);
    bad({ args: [1] }, /takes no arguments/);
    bad({ function: 'submitShares', args: [] }, /one quarter/);
    bad({ notBefore: '2026-10-06 08:00' }, /ISO 8601/);
    bad({ notAfter: '2026-10-06T08:00:00Z' }, /after notBefore/);
    bad({ expect: 'revert:NoSuchError' }, /not an error either contract declares/);
    bad({ expect: 'maybe' }, /not pass, fail/);
    bad({ function: 'submitShares', args: [3], expect: 'fail' }, /submitShares has no such result/);
    assert.throws(() => validateSchedule({ chainId: 314159, entries: [ok, ok] }), /appears twice/);
    assert.throws(() => validateSchedule({ chainId: 314, entries: [ok] }), /calibnet/);
  });

  it('expect grammar', () => {
    assert.deepEqual(parseExpect('revert:*'), { kind: 'revert', error: null });
    assert.deepEqual(parseExpect('revert:StepsComplete'), { kind: 'revert', error: 'StepsComplete' });
    assert.deepEqual(parseExpect('fail'), { kind: 'fail', error: null });
  });
});

describe('contract addresses come from deployments.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deployments-'));
  const write = (doc) => {
    const f = join(dir, `${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(doc));
    return f;
  };

  it('reads the calibnet entry', async () => {
    const f = write({ 314159: { sra: '0x0339f205314c8210af7cb075d1a96d012e7896a9', swa: '0x66c11a9f6dfec3c1557958cf9f575a023eb01421' } });
    const d = await loadDeployments(f, 314159);
    assert.equal(d.sra, '0x0339f205314C8210AF7Cb075d1A96D012e7896a9');
    assert.equal(d.swa, '0x66C11A9F6dfEC3c1557958cF9f575a023EB01421');
  });

  it('refuses a missing chain, a zero address, a bad address, bad JSON', async () => {
    await assert.rejects(loadDeployments(write({ 314: {} }), 314159), /no entry for chain 314159/);
    await assert.rejects(loadDeployments(write({ 314159: { sra: '0x0000000000000000000000000000000000000000', swa: '0x66c11a9f6dfec3c1557958cf9f575a023eb01421' } }), 314159), /zero address/);
    await assert.rejects(loadDeployments(write({ 314159: { sra: 'nope', swa: 'nope' } }), 314159), /not an address/);
    const f = join(dir, 'broken.json');
    writeFileSync(f, '{');
    await assert.rejects(loadDeployments(f, 314159), /not valid JSON/);
  });

  it('cleans up', () => rmSync(dir, { recursive: true, force: true }));
});

describe('QA round 4: phrases that are not calls to send now', () => {
  it('skips, no-crank notes, conditions, and later times are left out with a warning', () => {
    for (const text of [
      'SubmitShares(Q5) -- skip (no-crank weekend)',
      'SubmitShares(Q5): no crank this weekend',
      'If the gate passed, then QuarterlyGateCheck(Q8)',
    ]) {
      const r = parseActionCalls(text);
      assert.deepEqual(r.calls, [], text);
      assert.ok(r.warnings.length > 0, text);
    }
    for (const text of [
      'SubmitShares(Q7); then QuarterlyGateCheck(Q7) next morning',
      'SubmitShares(Q7), then wait for the hold, then QuarterlyGateCheck(Q7)',
      'SubmitShares(Q7), then in 6 h QuarterlyGateCheck(Q7)',
    ]) {
      const r = parseActionCalls(text);
      assert.deepEqual(r.calls.map((c) => c.function), ['submitShares'], text);
      assert.ok(r.warnings.some((w) => /later row/.test(w)), text);
    }
  });

  it('the rows the runbook actually uses still parse', () => {
    assert.deepEqual(parseActionCalls('SubmitShares(Q8), then QuarterlyGateCheck(Q8), PASS, weight 40%').calls.map((c) => c.function), ['submitShares', 'quarterlyGateCheck']);
    assert.equal(parseActionCalls('QuarterlyGateCheck(Q5), revert, the temporary stream leaves no headroom').calls.length, 1);
    assert.equal(parseActionCalls('QuarterlyGateCheck(Q11), revert StepsComplete(), the 8 steps are taken; the volume is not read').calls[0].expect, 'revert:StepsComplete');
  });
});
