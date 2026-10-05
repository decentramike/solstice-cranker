/**
 * QA: adversarial tests for rehearsal mode (src/rehearsal/*), written by an independent review
 * pass on 5 Oct 2026 and kept as regression tests.
 *
 * Unit level. FakeChain is copied from test/rehearsal.test.mjs and extended (configurable exit code
 * on a revert, null rounds). A second double, FakeProvider, sits under the REAL ethersChain() adapter
 * so its null-round and Lotus-receipt handling is exercised too. Nothing here opens a socket.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, Interface } from 'ethers';

import swaAbi from '../abi/StreamWeightActor.json' with { type: 'json' };
import sraAbi from '../abi/ServiceRewardsActor.json' with { type: 'json' };
import {
  calldataFor, ethersChain, findSentSince, firstBlockAtOrAfter, readOutcome, runRehearsal,
} from '../src/rehearsal/engine.mjs';
import { buildScheduleFromCsv, parseActionCalls, validateSchedule } from '../src/rehearsal/schedule.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SWA = new Interface(swaAbi);
const SRA = new Interface(sraAbi);
const TARGETS = { sra: getAddress('0x00000000000000000000000000000000000000aa'), swa: getAddress('0x00000000000000000000000000000000000000bb') };
const CRANKER = getAddress('0x170356558bd57623d3df9877319014ec9de6e263');
const GENESIS = Date.parse('2026-10-05T00:00:00Z') / 1000;
const epochOf = (iso) => Math.floor((Date.parse(iso) / 1000 - GENESIS) / 30);
const ms = (iso) => Date.parse(iso);

const revertWith = (name, args = []) => {
  for (const iface of [SWA, SRA]) {
    try {
      return iface.encodeErrorResult(name, args);
    } catch {
      // try the other contract
    }
  }
  throw new Error(`no error ${name}`);
};

/** One block per send, 30 s apart; nonce = number of the cranker's transactions so far. */
class FakeChain {
  constructor({ at, gateNext = 7, respond = () => ({ status: 1 }) }) {
    this.headNumber = epochOf(at);
    this.gateNext = gateNext;
    this.respond = respond;
    this.txs = [];
    this.sends = [];
    this.estimates = [];
    this.pendingExtra = 0;
    this.failSend = null;
    this.reads = 0;
  }
  ts(n) {
    return GENESIS + n * 30;
  }
  /** Moves the head forward to `iso` (never backward: sends already advanced it). */
  at(iso) {
    this.headNumber = Math.max(this.headNumber, epochOf(iso));
    return this;
  }
  /** A transaction the cranker (or a person with its key) sent earlier, landed at `iso`. */
  sentEarlier(iso, entryLike, result = { status: 1 }) {
    const n = epochOf(iso);
    const v = validateSchedule({ chainId: 314159, entries: [{ ...entryLike }] }).entries[0];
    const tx = { hash: `0xearly${this.txs.length}`, to: TARGETS[v.contract], data: calldataFor(v), blockNumber: n, result };
    this.txs.push(tx);
    this.txs.sort((a, b) => a.blockNumber - b.blockNumber);
    return tx;
  }
  async head() {
    return { number: this.headNumber, timestamp: this.ts(this.headNumber) };
  }
  async nonceAt(tag) {
    this.reads++;
    if (tag === 'pending') return this.txs.length + this.pendingExtra;
    if (tag === 'latest') return this.txs.length;
    return this.txs.filter((t) => t.blockNumber <= tag).length;
  }
  async timestampAt(n) {
    this.reads++;
    return this.ts(n);
  }
  async sentInBlock(n) {
    return this.txs
      .filter((t) => t.blockNumber === n)
      .map((t, i) => ({ hash: t.hash, to: t.to, data: t.data, nonce: i, blockNumber: n, timestamp: this.ts(n) }));
  }
  /** gateNext is the gate now; at an earlier block, undo the gate checks that landed after it. */
  async gateState(swa, blockTag = 'latest') {
    const later = blockTag === 'latest' ? 0 : this.txs.filter((t) => t.blockNumber > blockTag && t.result?.status === 1 && t.result?.gate).length;
    const next = this.gateNext - later;
    return { next, lastChecked: next - 1, steps: 4, complete: false };
  }
  async receiptOf(hash) {
    const tx = this.txs.find((t) => t.hash === hash);
    if (!tx) return null;
    const r = tx.result ?? { status: 1 };
    const logs = r.gate
      ? [{ address: TARGETS.swa, ...SWA.encodeEventLog('QuarterlyGateCheckResult', [r.gate.quarter, r.gate.passed, r.gate.steps]) }]
      : [];
    return { hash, status: r.status, blockNumber: tx.blockNumber, gasUsed: 4_000_000n, logs };
  }
  async estimateGas(req) {
    this.estimates.push(req);
    const r = this.respond(req, this);
    if (r.status === 0) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: r.revert });
    return 1_000_000n;
  }
  async send(req) {
    if (this.failSend) throw this.failSend;
    const r = this.respond(req, this);
    this.headNumber += 1;
    const tx = { hash: `0x${(this.txs.length + 1).toString(16).padStart(64, '0')}`, ...req, blockNumber: this.headNumber, result: r };
    this.txs.push(tx);
    this.sends.push(tx);
    if (r.status === 1 && r.gate) this.gateNext += 1;
    return { hash: tx.hash, tx };
  }
  async wait(t) {
    return this.receiptOf(t.hash);
  }
  async revertData(req, receipt) {
    const tx = this.txs.find((t) => t.hash === receipt.hash);
    return { data: tx.result.revert ?? null, source: 'fake', exitCode: tx.result.exitCode ?? 33 };
  }
}

/**
 * Lotus null rounds, presented the way ethersChain() presents them: a null round has no block, so
 * its timestamp and nonce are the previous real block's, and it holds no transactions.
 */
class NullRoundChain extends FakeChain {
  constructor(opts) {
    super(opts);
    this.nulls = new Set(opts.nulls ?? []);
  }
  real(n) {
    let b = n;
    while (b > 0 && this.nulls.has(b)) b--;
    return b;
  }
  async timestampAt(n) {
    this.reads++;
    return this.ts(this.real(n));
  }
  async sentInBlock(n) {
    if (this.nulls.has(n)) return [];
    return super.sentInBlock(n);
  }
  async send(req) {
    while (this.nulls.has(this.headNumber + 1)) this.headNumber += 1;
    return super.send(req);
  }
}

const entry = (over) => ({
  id: '1', step: 1, function: 'quarterlyGateCheck', args: [], gateQuarter: null,
  notBefore: '2026-10-05T22:25:00Z', notAfter: '2026-10-06T00:40:00Z', expect: 'pass', status: 'Pending', ...over,
});
const schedule = (...entries) => validateSchedule({ chainId: 314159, entries });

function harness() {
  const alerts = { alerts: [], raise(a) { this.alerts.push(a); return a; } };
  const lines = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, (m) => lines.push(`${l} ${m}`)]));
  return { alerts, lines, log };
}

// Revised after round 1: the default report window is the trigger interval, 15 minutes.
async function run(chain, sched, { now, dryRun = false, pause = { paused: false, reason: null }, cranker = CRANKER, reportWindowMs = 15 * 60_000 } = {}) {
  const h = harness();
  const result = await runRehearsal({
    schedule: sched, targets: TARGETS, chain, cranker, nowMs: typeof now === 'number' ? now : ms(now), dryRun, pause,
    gasLimit: 100_000_000n, reportWindowMs, confirmations: 1, alerts: h.alerts, log: h.log,
  });
  return { ...result, ...h };
}

const decisions = (r) => r.actions.map((a) => [a.id, a.decision]);
const gatePass = (q) => () => ({ status: 1, gate: { quarter: q, passed: true, steps: 5 } });

// Steps 78, 79, 80: byte-identical quarterlyGateCheck() calls, windows overlapping.
const E78 = entry({ id: '78', step: 78, gateQuarter: 5, notBefore: '2026-10-05T22:15:00Z', notAfter: '2026-10-06T00:30:00Z', expect: 'pass' });
const E79 = entry({ id: '79', step: 79, gateQuarter: 6, notBefore: '2026-10-05T22:20:00Z', notAfter: '2026-10-06T00:35:00Z', expect: 'fail' });
const E80 = entry({ id: '80', step: 80, gateQuarter: 7, notBefore: '2026-10-05T22:25:00Z', notAfter: '2026-10-06T00:40:00Z', expect: 'revert:StepWeightRecordsFailed' });
/** The SWA as tonight's plan expects it: Q5 passes, Q6 lands failed, then StepWeightRecordsFailed. */
const tonight = (req, c) => {
  if (c.gateNext === 5) return { status: 1, gate: { quarter: 5, passed: true, steps: 5 } };
  if (c.gateNext === 6) return { status: 1, gate: { quarter: 6, passed: false, steps: 5 } };
  return { status: 0, revert: revertWith('StepWeightRecordsFailed', [16]) };
};
const noGuard = (e) => ({ ...e, gateQuarter: null });

// =============================================================================================
describe('QA: window boundaries', () => {
  it('exactly at notBefore on both clocks: sent', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:25:00Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:25:00Z' });
    assert.deepEqual(decisions(r), [['80', 'sent']]);
    assert.equal(chain.sends.length, 1);
  });

  it('1 ms before notBefore (head already past it): not sent, nothing recorded, next = this step', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:25:30Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: ms('2026-10-05T22:25:00Z') - 1 });
    assert.equal(chain.sends.length, 0);
    assert.equal(chain.estimates.length, 0);
    assert.deepEqual(r.actions, []);
    assert.equal(r.next.id, '80');
    assert.equal(r.exitCode, 0);
  });

  it('exactly at notAfter: not sent, reported missed', async () => {
    const chain = new FakeChain({ at: '2026-10-06T00:40:00Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-06T00:40:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.deepEqual(decisions(r), [['80', 'missed']]);
  });

  it('chain head behind the wall clock (runner past notBefore, head not): waits, no send, no estimate', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:24:30Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:40:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.equal(chain.estimates.length, 0);
    assert.deepEqual(decisions(r), [['80', 'waiting']]);
    assert.equal(r.exitCode, 0);
  });

  it('chain head ahead of the wall clock (head past notBefore, runner not): not sent', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:27:00Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:24:59Z' });
    assert.equal(chain.sends.length, 0);
    assert.deepEqual(r.actions, []);
  });

  it('chain head already past notAfter while the runner clock is not: not sent (it would land after notAfter)', async () => {
    const chain = new FakeChain({ at: '2026-10-06T00:41:00Z', respond: gatePass(7) });
    await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-06T00:39:00Z' });
    assert.equal(chain.sends.length, 0, `sent at chain time ${new Date(chain.ts(chain.sends[0]?.blockNumber ?? 0) * 1000).toISOString()}, after notAfter 00:40`);
  });

  // Revised after round 1: no send starts within SEND_MARGIN_MS (60 s) of notAfter, so the last
  // possible send is a minute before it -- and it must not be reported missed afterwards.
  it('sent at the last moment allowed (61 s before notAfter): the next run does not report it missed', async () => {
    const e = entry({ id: '80' });
    const chain = new FakeChain({ at: '2026-10-06T00:38:30Z', respond: gatePass(7) });
    const r1 = await run(chain, schedule(e), { now: ms('2026-10-06T00:40:00Z') - 61_000 });
    assert.deepEqual(decisions(r1), [['80', 'sent']]);
    const tooLate = await run(new FakeChain({ at: '2026-10-06T00:38:30Z', respond: gatePass(7) }), schedule(e), { now: ms('2026-10-06T00:40:00Z') - 1 });
    assert.deepEqual(decisions(tooLate), [['80', 'too-late']]);
    chain.at('2026-10-06T00:45:00Z');
    const r2 = await run(chain, schedule(e), { now: '2026-10-06T00:45:00Z' });
    assert.equal(chain.sends.length, 1);
    assert.ok(!decisions(r2).some(([, d]) => d === 'missed'), `run 2 said ${JSON.stringify(decisions(r2))}`);
    assert.deepEqual(r2.alerts.alerts, []);
    assert.equal(r2.exitCode, 0);
  });
});

// =============================================================================================
describe('QA: three byte-identical gate checks (78/79/80 at 22:15/22:20/22:25)', () => {
  for (const [label, s] of [['gate guard on', schedule(E78, E79, E80)], ['gate guard off (gateQuarter null)', schedule(noGuard(E78), noGuard(E79), noGuard(E80))]]) {
    it(`runs at 22:16, 22:21, 22:31: each sent once, in order (${label})`, async () => {
      const chain = new FakeChain({ at: '2026-10-05T22:16:00Z', gateNext: 5, respond: tonight });
      const r1 = await run(chain, s, { now: '2026-10-05T22:16:00Z' });
      assert.deepEqual(decisions(r1), [['78', 'sent']]);
      const r2 = await run(chain.at('2026-10-05T22:21:00Z'), s, { now: '2026-10-05T22:21:00Z' });
      assert.deepEqual(decisions(r2), [['78', 'already-sent'], ['79', 'sent']]);
      const r3 = await run(chain.at('2026-10-05T22:31:00Z'), s, { now: '2026-10-05T22:31:00Z' });
      assert.deepEqual(decisions(r3), [['78', 'already-sent'], ['79', 'already-sent'], ['80', 'sent']]);
      const r4 = await run(chain.at('2026-10-05T22:45:00Z'), s, { now: '2026-10-05T22:45:00Z' });
      assert.deepEqual(decisions(r4), [['78', 'already-sent'], ['79', 'already-sent'], ['80', 'already-sent']]);
      assert.deepEqual(r4.actions.map((a) => a.txHash), chain.sends.map((t) => t.hash), 'each step credited with its own tx');
      assert.equal(chain.sends.length, 3);
      assert.deepEqual([r1, r2, r3].map((r) => r.actions.at(-1).match), [true, true, true]);
      assert.deepEqual([r1, r2, r3, r4].map((r) => r.exitCode), [0, 0, 0, 0]);
    });

    it(`one late run at 22:50 (all three open): all three sent, once, in order (${label})`, async () => {
      const chain = new FakeChain({ at: '2026-10-05T22:50:00Z', gateNext: 5, respond: tonight });
      const r1 = await run(chain, s, { now: '2026-10-05T22:50:00Z' });
      assert.deepEqual(decisions(r1), [['78', 'sent'], ['79', 'sent'], ['80', 'sent']]);
      assert.deepEqual(r1.actions.map((a) => a.match), [true, true, true]);
      assert.deepEqual(chain.sends.map((t) => t.result.gate?.quarter ?? 'revert'), [5, 6, 'revert']);
      const r2 = await run(chain.at('2026-10-05T23:00:00Z'), s, { now: '2026-10-05T23:00:00Z' });
      assert.deepEqual(decisions(r2), [['78', 'already-sent'], ['79', 'already-sent'], ['80', 'already-sent']]);
      assert.deepEqual(r2.actions.map((a) => a.txHash), chain.sends.map((t) => t.hash));
      assert.equal(chain.sends.length, 3);
    });
  }

  it('78 held (gate already past Q5), 79 sent: the next run credits 79 with its own tx, not 78', async () => {
    const s = schedule(E78, E79, E80);
    const chain = new FakeChain({ at: '2026-10-05T22:21:00Z', gateNext: 6, respond: tonight });
    const r1 = await run(chain, s, { now: '2026-10-05T22:21:00Z' });
    assert.deepEqual(decisions(r1), [['78', 'blocked'], ['79', 'sent']]);
    const r2 = await run(chain.at('2026-10-05T22:26:00Z'), s, { now: '2026-10-05T22:26:00Z' });
    const by = Object.fromEntries(r2.actions.map((a) => [a.id, a]));
    assert.equal(by['79'].decision, 'already-sent', `79 is "${by['79'].decision}" (${by['79'].result}); 78 is "${by['78'].decision}" with tx ${by['78'].txHash}`);
    assert.equal(by['79'].txHash, chain.sends[0].hash);
    assert.notEqual(by['78'].decision, 'already-sent', '78 was never sent');
  });

  it('...and with the guard off on 79 (hand-edited schedule), 79 is not sent twice', async () => {
    const s = schedule(E78, noGuard(E79));
    const chain = new FakeChain({ at: '2026-10-05T22:21:00Z', gateNext: 6, respond: tonight });
    await run(chain, s, { now: '2026-10-05T22:21:00Z' });
    assert.equal(chain.sends.length, 1);
    await run(chain.at('2026-10-05T22:26:00Z'), s, { now: '2026-10-05T22:26:00Z' });
    assert.equal(chain.sends.length, 1, 'step 79 was broadcast a second time');
  });

  it('a row marked Complete still owns its tx: step 30 (Complete) sent 19:16 is not counted as step 31', async () => {
    // Runbook steps 30/31: SubmitShares(Q3) at 19:00, then "SubmitShares(Q3) again, revert" at 19:15.
    const e30 = entry({ id: '30', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T21:15:00Z', status: 'Complete' });
    const e31 = entry({ id: '31', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:15:00Z', notAfter: '2026-10-06T21:30:00Z', expect: 'revert:*' });
    const chain = new FakeChain({ at: '2026-10-06T19:20:00Z', respond: () => ({ status: 0, revert: revertWith('AlreadySubmitted', [3]) }) });
    chain.sentEarlier('2026-10-06T19:16:00Z', e30); // step 30 went out at 19:16 (cron jitter), then was marked Complete
    const r = await run(chain, schedule(e30, e31), { now: '2026-10-06T19:20:00Z' });
    assert.deepEqual(decisions(r), [['31', 'sent']], `step 31 was "${r.actions[0]?.decision}" with tx ${r.actions[0]?.txHash}`);
  });
});

// =============================================================================================
describe('QA: crash after broadcast, manual force-send', () => {
  it('tx mined but the run died before recording: the next run does not resend', async () => {
    // A reverted gate check does not advance the gate, so it is still at Q7.
    const chain = new FakeChain({ at: '2026-10-05T22:31:00Z', gateNext: 7, respond: gatePass(7) });
    const t = chain.sentEarlier('2026-10-05T22:25:30Z', E80, { status: 0, revert: revertWith('StepWeightRecordsFailed', [16]) });
    const r = await run(chain, schedule(E80), { now: '2026-10-05T22:31:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.deepEqual(decisions(r), [['80', 'already-sent']]);
    assert.equal(r.actions[0].txHash, t.hash);
  });

  it('tx still in the mpool after the crash: held; once mined, already-sent; never resent', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: gatePass(7) });
    chain.pendingExtra = 1;
    const r1 = await run(chain, schedule(E80), { now: '2026-10-05T22:26:00Z' });
    assert.deepEqual(decisions(r1), [['80', 'held']]);
    chain.pendingExtra = 0;
    chain.sentEarlier('2026-10-05T22:27:00Z', E80, { status: 0, revert: revertWith('StepWeightRecordsFailed', [16]) });
    const r2 = await run(chain.at('2026-10-05T22:31:00Z'), schedule(E80), { now: '2026-10-05T22:31:00Z' });
    assert.deepEqual(decisions(r2), [['80', 'already-sent']]);
    assert.equal(chain.sends.length, 0);
  });

  it('crash-recovered step whose tx did NOT do what the plan expected is still flagged', async () => {
    // The crashed run never got to compare the outcome; no later run does either.
    const chain = new FakeChain({ at: '2026-10-05T22:31:00Z', respond: gatePass(7) });
    chain.sentEarlier('2026-10-05T22:25:30Z', E80, { status: 1, gate: { quarter: 7, passed: true, steps: 6 } }); // landed; plan said revert
    const r = await run(chain, schedule(E80), { now: '2026-10-05T22:31:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.notEqual(r.actions[0].match, null, 'outcome of the recovered tx was never evaluated (match is null)');
  });

  it('a manual force_call inside the window (cranker key) counts as the step', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:17:00Z', gateNext: 5, respond: tonight });
    const t = chain.sentEarlier('2026-10-05T22:16:00Z', E78);
    const r = await run(chain, schedule(E78), { now: '2026-10-05T22:17:00Z' });
    assert.deepEqual(decisions(r), [['78', 'already-sent']]);
    assert.equal(r.actions[0].txHash, t.hash);
    assert.equal(chain.sends.length, 0);
  });

  it('a manual force_call at 22:21 after the cranker sent 78 at 22:16 counts as 79; 80 still goes at 22:26', async () => {
    const s = schedule(E78, E79, E80);
    const chain = new FakeChain({ at: '2026-10-05T22:16:00Z', gateNext: 5, respond: tonight });
    await run(chain, s, { now: '2026-10-05T22:16:00Z' });
    // A gate check that lands always emits QuarterlyGateCheckResult; this one tested Q6 and failed.
    const manual = chain.sentEarlier('2026-10-05T22:21:00Z', E79, { status: 1, gate: { quarter: 6, passed: false, steps: 5 } });
    chain.gateNext = 7;
    const r = await run(chain.at('2026-10-05T22:26:00Z'), s, { now: '2026-10-05T22:26:00Z' });
    assert.deepEqual(decisions(r), [['78', 'already-sent'], ['79', 'already-sent'], ['80', 'sent']]);
    assert.equal(r.actions[1].txHash, manual.hash);
    assert.equal(chain.sends.length, 2);
  });

  it('a manual force_call one minute before the window opened does not count', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:16:00Z', gateNext: 5, respond: tonight });
    chain.sentEarlier('2026-10-05T22:14:00Z', E78);
    const r = await run(chain, schedule(E78), { now: '2026-10-05T22:16:00Z' });
    assert.deepEqual(decisions(r), [['78', 'sent']]);
  });
});

// =============================================================================================
describe('QA: null rounds', () => {
  // Blocks 2700..2760 around 22:30; nulls scattered, including at the window edge and next to txs.
  const NULLS = [2695, 2700, 2701, 2702, 2710, 2719, 2721, 2740, 2741];
  const e = entry({});
  function chainWithTxs(nulls, txBlocks, headIso = '2026-10-05T23:00:00Z') {
    const c = new NullRoundChain({ at: headIso, nulls });
    for (const b of txBlocks) {
      assert.ok(!c.nulls.has(b), 'test bug: tx in a null round');
      c.sentEarlier(new Date((GENESIS + b * 30) * 1000).toISOString(), e);
    }
    return c;
  }

  it('firstBlockAtOrAfter lands on the first REAL block when t is a null round', async () => {
    const c = chainWithTxs(NULLS, []);
    const head = await c.head();
    assert.equal(await firstBlockAtOrAfter(c, GENESIS + 2700 * 30, head), 2703);
    assert.equal(await firstBlockAtOrAfter(c, GENESIS + 2703 * 30, head), 2703);
    assert.equal(await firstBlockAtOrAfter(c, GENESIS + 2699 * 30, head), 2699);
  });

  it('findSentSince finds every tx around scattered null rounds (FakeChain adapter)', async () => {
    const blocks = [2699, 2703, 2703, 2711, 2718, 2720, 2722, 2742, 2759];
    const c = chainWithTxs(NULLS, blocks);
    const found = await findSentSince(c, GENESIS + 2699 * 30, await c.head());
    assert.equal(found.complete, true, `missing ${found.missing}`);
    assert.deepEqual(found.txs.map((t) => t.blockNumber), blocks);
  });

  it('findSentSince survives a 60-epoch (30 min) null stretch, e.g. after a calibnet halt (FakeChain adapter)', async () => {
    const stretch = Array.from({ length: 60 }, (_, i) => 2705 + i);
    const c = chainWithTxs(stretch, [2702, 2766, 2770], '2026-10-05T23:10:00Z'); // head 2780, past the stretch
    const found = await findSentSince(c, GENESIS + 2690 * 30, await c.head());
    assert.deepEqual(found.txs.map((t) => t.blockNumber), [2702, 2766, 2770]);
  });

  /** A JSON-RPC provider in the shape ethersChain() uses, with Lotus null-round errors. */
  class FakeProvider {
    constructor({ head, nulls, txs, nullNonceThrows = true }) {
      this.headN = head;
      this.nulls = new Set(nulls);
      this.txs = txs; // {blockNumber, hash, to, data}
      this.nullNonceThrows = nullNonceThrows;
      this.calls = 0;
    }
    nullErr() {
      // The shape ethers v6 gives a JSON-RPC error it does not recognise.
      const error = { code: 1, message: 'requested epoch was a null round' };
      return Object.assign(new Error(`could not coalesce error (error=${JSON.stringify(error)})`), { code: 'UNKNOWN_ERROR', shortMessage: 'could not coalesce error', info: { error } });
    }
    async getBlock(tag, prefetch = false) {
      this.calls++;
      const n = tag === 'latest' ? this.headN : tag;
      if (n > this.headN) return null;
      if (this.nulls.has(n)) throw this.nullErr();
      const mine = this.txs.filter((t) => t.blockNumber === n);
      return {
        number: n, timestamp: GENESIS + n * 30,
        prefetchedTransactions: prefetch ? mine.map((t) => ({ ...t, from: CRANKER, nonce: this.txs.indexOf(t) })) : undefined,
      };
    }
    async getTransactionCount(addr, tag) {
      this.calls++;
      if (tag === 'latest' || tag === 'pending') return this.txs.length;
      if (this.nulls.has(tag) && this.nullNonceThrows) throw this.nullErr();
      return this.txs.filter((t) => t.blockNumber <= tag).length;
    }
  }
  const mkTxs = (blocks) => blocks.map((b, i) => ({ blockNumber: b, hash: `0x${String(i + 1).padStart(64, '0')}`, to: TARGETS.swa, data: calldataFor(validateSchedule({ chainId: 314159, entries: [e] }).entries[0]) }));

  for (const nullNonceThrows of [true, false]) {
    it(`real ethersChain(): finds every tx around null rounds (getTransactionCount at a null round ${nullNonceThrows ? 'errors' : 'answers'})`, async () => {
      const blocks = [2699, 2703, 2703, 2711, 2718, 2720, 2722, 2742, 2759];
      const provider = new FakeProvider({ head: 2760, nulls: NULLS, txs: mkTxs(blocks), nullNonceThrows });
      const chain = ethersChain({ provider, wallet: null, address: CRANKER });
      const head = await chain.head();
      // Revised after round 1: ethersChain() gives a null round its epoch's own time (head time
      // minus 30 s per epoch), so the first epoch at or after 2700's time is 2700 itself. Null
      // rounds hold no transactions, so starting the scan there loses nothing.
      assert.equal(await firstBlockAtOrAfter(chain, GENESIS + 2700 * 30, head), 2700);
      const found = await findSentSince(chain, GENESIS + 2699 * 30, head);
      assert.equal(found.complete, true, `missing ${found.missing}`);
      assert.deepEqual(found.txs.map((t) => t.blockNumber), blocks);
    });
  }

  it('real ethersChain(): survives a 60-epoch null stretch inside the scan range', async () => {
    const stretch = Array.from({ length: 60 }, (_, i) => 2705 + i);
    const provider = new FakeProvider({ head: 2780, nulls: stretch, txs: mkTxs([2702, 2766, 2770]) });
    const chain = ethersChain({ provider, wallet: null, address: CRANKER });
    const found = await findSentSince(chain, GENESIS + 2690 * 30, await chain.head());
    assert.deepEqual(found.txs.map((t) => t.blockNumber), [2702, 2766, 2770]);
  });

  it('engine on a null-round chain: step sent once, second run sees it', async () => {
    const c = new NullRoundChain({ at: '2026-10-05T22:26:00Z', nulls: [2693, 2694, 2695, 2696], respond: gatePass(7) });
    await run(c, schedule(entry({ id: '80' })), { now: '2026-10-05T22:26:00Z' });
    c.nulls.add(c.headNumber + 1);
    c.nulls.add(c.headNumber + 2);
    const r = await run(c.at('2026-10-05T22:40:00Z'), schedule(entry({ id: '80' })), { now: '2026-10-05T22:40:00Z' });
    assert.deepEqual(decisions(r), [['80', 'already-sent']]);
    assert.equal(c.sends.length, 1);
  });
});

// =============================================================================================
describe('QA: alert timing', () => {
  it('missed: exactly one alert across runs every 15 minutes (the documented cron-job.org cadence)', async () => {
    const chain = new FakeChain({ at: '2026-10-06T00:41:00Z' });
    const s = schedule(entry({ id: '80' }));
    const runs = [];
    for (const t of ['2026-10-06T00:41:00Z', '2026-10-06T00:56:00Z', '2026-10-06T01:11:00Z', '2026-10-06T01:26:00Z']) {
      runs.push(await run(chain.at(t), s, { now: t }));
    }
    const n = runs.reduce((k, r) => k + r.alerts.alerts.filter((a) => /was not sent/.test(a.title)).length, 0);
    assert.equal(n, 1, `"missed" alerted ${n} times; exit codes ${runs.map((r) => r.exitCode).join(',')}`);
  });

  it('missed: no alert at or after notAfter + report window', async () => {
    const chain = new FakeChain({ at: '2026-10-06T01:00:00Z' });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-06T01:00:00Z' });
    assert.deepEqual(r.alerts.alerts, []);
    assert.equal(r.exitCode, 0);
  });

  it('blocked gate: exactly one alert across runs every 15 minutes', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:16:00Z', gateNext: 7 });
    const s = schedule(E78);
    const runs = [];
    for (const t of ['2026-10-05T22:16:00Z', '2026-10-05T22:31:00Z', '2026-10-05T22:46:00Z']) runs.push(await run(chain.at(t), s, { now: t }));
    assert.deepEqual(runs.map((r) => r.actions[0].decision), ['blocked', 'blocked', 'blocked']);
    const n = runs.reduce((k, r) => k + r.alerts.alerts.length, 0);
    assert.equal(n, 1, `"blocked" alerted ${n} times; exit codes ${runs.map((r) => r.exitCode).join(',')}`);
  });

  it('missed is not alerted while the ledger is incomplete, nor while keyless', async () => {
    const chain = new FakeChain({ at: '2026-10-06T00:45:00Z' });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-06T00:45:00Z', cranker: null, dryRun: true });
    assert.deepEqual(decisions(r), [['80', 'missed']]);
    assert.deepEqual(r.alerts.alerts, []);
  });
});

// =============================================================================================
describe('QA: runbook status', () => {
  for (const status of ['Complete', 'complete', 'COMPLETED', ' Done ', 'Skipped', 'skip', 'N/A', 'Cancelled', 'canceled']) {
    it(`status "${status}": never sent, never estimated, never reported missed`, async () => {
      const open = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: gatePass(7) });
      const r = await run(open, schedule(entry({ id: '80', status })), { now: '2026-10-05T22:26:00Z' });
      assert.equal(open.sends.length + open.estimates.length, 0);
      assert.deepEqual(r.actions, []);
      const closed = new FakeChain({ at: '2026-10-06T00:45:00Z' });
      const r2 = await run(closed, schedule(entry({ id: '80', status })), { now: '2026-10-06T00:45:00Z' });
      assert.deepEqual(r2.actions, []);
      assert.equal(r2.exitCode, 0);
    });
  }
});

// =============================================================================================
describe('QA: decoding outcomes', () => {
  const unknown = '0xdeadbeef' + '00'.repeat(32);

  it('expected revert:*, reverted with an unknown selector: recorded with the selector, matches', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: () => ({ status: 0, revert: unknown }) });
    const r = await run(chain, schedule(entry({ id: '73', expect: 'revert:*' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(r.actions[0].decision, 'sent');
    assert.equal(r.actions[0].result, 'reverted 0xdeadbeef');
    assert.equal(r.actions[0].match, true);
    assert.equal(r.exitCode, 0);
  });

  it('expected a named revert, got an unknown selector: mismatch, alert names the selector, exit 1', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: () => ({ status: 0, revert: unknown }) });
    const r = await run(chain, schedule(entry({ id: '80', expect: 'revert:StepWeightRecordsFailed' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(r.actions[0].match, false);
    assert.equal(r.exitCode, 1);
    assert.match(r.alerts.alerts[0].body, /0xdeadbeef/);
  });

  it('expected revert:*, message failed with exit code 7 (out of gas) and no data: NOT a match', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: () => ({ status: 0, revert: null, exitCode: 7 }) });
    const r = await run(chain, schedule(entry({ id: '73', expect: 'revert:*' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(r.actions[0].result, 'failed on chain, exit code 7');
    assert.equal(r.actions[0].match, false, 'SYS_OUT_OF_GAS counted as the scheduled revert');
    assert.equal(r.exitCode, 1);
  });

  it('expected a named revert, exit code 7 and no data: mismatch', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: () => ({ status: 0, revert: null, exitCode: 7 }) });
    const r = await run(chain, schedule(entry({ id: '80', expect: 'revert:StepWeightRecordsFailed' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(r.actions[0].match, false);
  });

  it('real ethersChain().revertData: a Lotus receipt with exit code 7 and no return comes back as exit 7, no data', async () => {
    const provider = {
      async send(method) {
        if (method === 'Filecoin.EthGetMessageCidByTransactionHash') return { '/': 'bafy2bzacedummy' };
        if (method === 'Filecoin.StateSearchMsg') return { Receipt: { ExitCode: 7, Return: null } };
        throw new Error(`unexpected ${method}`);
      },
      async call() {
        throw new Error('replay must not be needed');
      },
    };
    const chain = ethersChain({ provider, wallet: null, address: CRANKER });
    const v = validateSchedule({ chainId: 314159, entries: [entry({ expect: 'revert:*' })] }).entries[0];
    const o = await readOutcome({ chain, entry: v, req: { to: TARGETS.swa, data: calldataFor(v) }, receipt: { hash: '0x1', status: 0, blockNumber: 10 }, targets: TARGETS });
    assert.equal(o.exitCode, 7);
    assert.equal(o.revert, null);
  });
});

// =============================================================================================
describe('QA: dry run', () => {
  it('no key (cranker null): sends nothing, reads no nonce, does not throw', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:50:00Z', gateNext: 5, respond: tonight });
    chain.send = async () => {
      throw new Error('send called in a keyless dry run');
    };
    const s = schedule(E78, E79, E80, entry({ id: '73', notBefore: '2026-10-05T20:00:00Z', notAfter: '2026-10-05T22:45:00Z' }));
    const r = await run(chain, s, { now: '2026-10-05T22:50:00Z', cranker: null, dryRun: true });
    assert.equal(chain.sends.length, 0);
    assert.equal(decisions(r).find(([id]) => id === '78')[1], 'dry-run');
    assert.equal(decisions(r).find(([id]) => id === '73')[1], 'missed');
  });

  it('dry run does not page anyone about gate mismatches caused by its own unsent earlier steps', async () => {
    // 22:26: 78, 79, 80 all open, gate at Q5. A real run would send 78 -> Q6, 79 -> Q7, 80.
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', gateNext: 5, respond: tonight });
    const r = await run(chain, schedule(E78, E79, E80), { now: '2026-10-05T22:26:00Z', cranker: null, dryRun: true });
    assert.equal(chain.sends.length, 0);
    assert.deepEqual(r.alerts.alerts.map((a) => a.title), [], `decisions ${JSON.stringify(decisions(r))}`);
    assert.equal(r.exitCode, 0);
  });
});

// =============================================================================================
describe('QA: schedule builder, tricky Action prose', () => {
  it('two calls without "then": only the first is sent, and a warning says so', () => {
    for (const text of ['SubmitShares(Q8) and QuarterlyGateCheck(Q8), PASS', 'SubmitShares(Q8); QuarterlyGateCheck(Q8), PASS']) {
      const { calls, warnings } = parseActionCalls(text);
      assert.equal(calls.length, 1, text);
      assert.match(warnings.join('\n'), /not introduced with "then"/);
    }
  });

  it('lowercase "pass" is pass, with no "no outcome stated" note', () => {
    const { calls } = parseActionCalls('QuarterlyGateCheck(Q7), pass, weight 35%');
    assert.deepEqual([calls[0].expect, calls[0].note], ['pass', null]);
  });

  it('"FAILED" is fail', () => {
    assert.equal(parseActionCalls('QuarterlyGateCheck(Q6), FAILED, value bound 0').calls[0].expect, 'fail');
  });

  it('"fail" / "fails" / "Failed" in any case is fail, not pass', () => {
    const got = ['QuarterlyGateCheck(Q6), fail, value bound 0', 'QuarterlyGateCheck(Q6) fails: value bound 0', 'QuarterlyGateCheck(Q6), Failed (value bound 0)']
      .map((t) => parseActionCalls(t).calls[0].expect);
    assert.deepEqual(got, ['fail', 'fail', 'fail']);
  });

  it('"must not revert" is not an expected revert', () => {
    assert.equal(parseActionCalls('QuarterlyGateCheck(Q7), PASS (must not revert), weight 35%').calls[0].expect, 'pass');
  });

  it('two error names in one outcome: flagged for a person, not silently the first one', () => {
    const { calls, warnings } = parseActionCalls('QuarterlyGateCheck(Q7), revert HoldUntil or StepWeightRecordsFailed, whichever f02 hits first');
    assert.ok(calls[0].expect === 'revert:*' || warnings.some((w) => /HoldUntil|StepWeightRecordsFailed|ambiguous|more than one/i.test(w)),
      `expect=${calls[0].expect}, warnings=${JSON.stringify(warnings)}, note=${calls[0].note}`);
  });

  // Was a todo in round 1; the parser now treats a "then" call that names another time as a mention.
  it('"then re-run X Tue 08:00" names a later step, not a second call now', () => {
    const { calls, warnings } = parseActionCalls('QuarterlyGateCheck(Q7), revert StepWeightRecordsFailed; then re-run QuarterlyGateCheck(Q7) Tue 08:00');
    assert.ok(calls.length === 1 || warnings.length > 0, `${calls.length} calls, no warning: ${JSON.stringify(calls.map((c) => c.expect))}`);
  });

  const HEADER = 'Step,Actor,Action / command,Watchtower validation,Opens (UTC),Closes (UTC),Status';
  const q = (c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  const csv = (header, ...rows) => [header, ...rows.map((r) => r.map(q).join(','))].join('\n') + '\n';

  it('no Closes column: window = Opens + 15 min + grace', () => {
    const { doc } = buildScheduleFromCsv(csv('Step,Actor,Action / command,Opens (UTC),Status', ['86', 'Cranker', 'QuarterlyGateCheck(Q7), PASS', 'Tue 2026-10-06 08:00', 'Pending']));
    assert.equal(doc.entries[0].notAfter, '2026-10-06T08:45:00Z'); // Opens + 15 min + 30 min grace
  });

  it('blank Closes: window = Opens + 15 min + grace', () => {
    const { doc } = buildScheduleFromCsv(csv(HEADER, ['86', 'Cranker', 'QuarterlyGateCheck(Q7), PASS', '', 'Tue 2026-10-06 08:00', '', 'Pending']));
    assert.equal(doc.entries[0].notAfter, '2026-10-06T08:45:00Z'); // Opens + 15 min + 30 min grace
  });

  it('Closes before Opens (typo): the substitution is reported', () => {
    const { doc, warnings } = buildScheduleFromCsv(csv(HEADER, ['86', 'Cranker', 'QuarterlyGateCheck(Q7), PASS', '', 'Tue 2026-10-06 08:00', 'Tue 2026-10-06 07:15', 'Pending']));
    assert.equal(doc.entries[0].notAfter, '2026-10-06T08:45:00Z'); // Opens + 15 min + 30 min grace
    assert.ok(warnings.some((w) => /Closes/i.test(w)), `no warning: ${JSON.stringify(warnings)}`);
  });

  it('wrong weekday on Opens and Closes: both warned, the date wins', () => {
    const { doc, warnings } = buildScheduleFromCsv(csv(HEADER, ['80', 'Cranker', 'QuarterlyGateCheck(Q7), revert', '', 'Tue 2026-10-05 22:25', 'Wed 2026-10-05 22:40', 'Pending']));
    assert.equal(doc.entries[0].notBefore, '2026-10-05T22:25:00Z');
    assert.ok(warnings.some((w) => /step 80: "Tue 2026-10-05 22:25" says Tue but 2026-10-05 is a Mon/.test(w)));
    assert.ok(warnings.some((w) => /says Wed/.test(w)));
  });

  it('a full weekday name that is right is not warned', () => {
    const { warnings } = buildScheduleFromCsv(csv(HEADER, ['80', 'Cranker', 'QuarterlyGateCheck(Q7), PASS', '', 'Monday 2026-10-05 22:25', 'Monday 2026-10-05 22:40', 'Pending']));
    assert.deepEqual(warnings.filter((w) => /says/.test(w)), []);
  });

  it('a CSV saved with a UTF-8 BOM (Excel) still builds', () => {
    const text = '﻿' + csv(HEADER, ['86', 'Cranker', 'QuarterlyGateCheck(Q7), PASS', '', 'Tue 2026-10-06 08:00', 'Tue 2026-10-06 08:15', 'Pending']);
    assert.doesNotThrow(() => buildScheduleFromCsv(text));
  });
});

// =============================================================================================
describe('QA: build output determinism', () => {
  const FIXTURE = join(ROOT, 'test', 'fixtures', 'runbook-cranker-rows.csv');
  const CSV = readFileSync(FIXTURE, 'utf8');
  const json = (text) => JSON.stringify(buildScheduleFromCsv(text).doc, null, 2) + '\n';

  it('same CSV -> byte-identical JSON, twice in one process', () => {
    assert.equal(json(CSV), json(CSV));
  });

  it('CRLF line endings -> byte-identical JSON (incl. crankerRowsSha256)', () => {
    assert.equal(json(CSV.replace(/\r?\n/g, '\r\n')), json(CSV));
  });

  it('the script, run twice on the same CSV, writes byte-identical files; --check passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-build-'));
    try {
      const outs = [join(dir, 'a.json'), join(dir, 'b.json')];
      for (const out of outs) {
        const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-rehearsal-schedule.mjs'), '--csv', FIXTURE, '--out', out], { encoding: 'utf8', env: { PATH: process.env.PATH } });
        assert.equal(r.status, 0, r.stderr);
      }
      assert.ok(readFileSync(outs[0]).equals(readFileSync(outs[1])));
      assert.equal(readFileSync(outs[0], 'utf8'), json(CSV));
      const check = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-rehearsal-schedule.mjs'), '--csv', FIXTURE, '--out', outs[0], '--check'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(check.status, 0, check.stderr);
      writeFileSync(outs[1], readFileSync(outs[1], 'utf8').replace('"Pending"', '"Complete"'));
      const stale = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-rehearsal-schedule.mjs'), '--csv', FIXTURE, '--out', outs[1], '--check'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(stale.status, 1, 'a hand-edited file passed --check');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
