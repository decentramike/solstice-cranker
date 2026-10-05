/**
 * Rehearsal mode's decisions, against a scripted chain.
 *
 * The fake chain mines one block per send, 30 s apart, and answers each call the way the test
 * scripts it -- so every rule can be pinned exactly: never early, never unscheduled, at most
 * once, expected reverts sent without a pre-check, mismatches flagged. The same engine runs
 * against a real EVM in test/integration/rehearsal.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, Interface } from 'ethers';

import swaAbi from '../abi/StreamWeightActor.json' with { type: 'json' };
import sraAbi from '../abi/ServiceRewardsActor.json' with { type: 'json' };
import { loadConfig, resolvePause } from '../src/config.mjs';
import {
  actionLine, assertRehearsalChain, calldataFor, cborBytesToHex, findSentSince, RehearsalRefused, runRehearsal, tagGasLimit,
} from '../src/rehearsal/engine.mjs';
import { runRehearsalFromEnv } from '../src/rehearsal/run.mjs';
import { validateSchedule } from '../src/rehearsal/schedule.mjs';

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
    this.hidden = 0;
    this.failSend = null;
  }
  ts(n) {
    return GENESIS + n * 30;
  }
  /** A transaction the cranker sent earlier, landed at `iso`, with the outcome `result`. */
  sentEarlier(iso, entryLike, result = { status: 1 }) {
    const n = epochOf(iso);
    this.txs.push({ hash: `0xearly${this.txs.length}`, to: TARGETS[entryLike.contract], data: calldataFor(entryLike), blockNumber: n, result });
    this.txs.sort((a, b) => a.blockNumber - b.blockNumber);
  }
  async head() {
    return { number: this.headNumber, timestamp: this.ts(this.headNumber) };
  }
  async nonceAt(tag) {
    if (tag === 'pending') return this.txs.length + this.pendingExtra;
    if (tag === 'latest') return this.txs.length;
    return this.txs.filter((t) => t.blockNumber <= tag).length;
  }
  async timestampAt(n) {
    return this.ts(n);
  }
  async sentInBlock(n) {
    return this.txs
      .filter((t) => t.blockNumber === n)
      .slice(this.hidden)
      .map((t, i) => ({ hash: t.hash, to: t.to, data: t.data, nonce: i, gasLimit: t.gasLimit, blockNumber: n, timestamp: this.ts(n) }));
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

async function run(chain, sched, { now, dryRun = false, pause = { paused: false, reason: null }, cranker = CRANKER } = {}) {
  const h = harness();
  const result = await runRehearsal({
    schedule: sched, targets: TARGETS, chain, cranker, nowMs: ms(now), dryRun, pause,
    gasLimit: 100_000_000n, reportWindowMs: 20 * 60_000, confirmations: 1, alerts: h.alerts, log: h.log,
  });
  return { ...result, ...h };
}

const gatePass = (q) => () => ({ status: 1, gate: { quarter: q, passed: true, steps: 5 } });

describe('the schedule gate: never early, never unscheduled', () => {
  it('too early: nothing is sent, and the next step is reported', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:20:00Z' });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:20:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.deepEqual(r.actions, []);
    assert.equal(r.next.id, '80');
    assert.equal(r.exitCode, 0);
  });

  it('one second before notBefore is still too early', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:25:30Z' });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:24:59Z' });
    assert.equal(chain.sends.length, 0);
    assert.equal(r.exitCode, 0);
  });

  it('the runner clock has passed notBefore but the chain head has not: still waits', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:24:30Z' }); // head lags the wall clock
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:25:10Z' });
    assert.equal(chain.sends.length, 0);
    assert.equal(r.actions[0].decision, 'waiting');
    assert.equal(r.exitCode, 0);
  });

  it('at notBefore on both clocks: sent', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:25:00Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:25:05Z' });
    assert.equal(chain.sends.length, 1);
    assert.equal(r.actions[0].decision, 'sent');
    assert.equal(r.actions[0].match, true);
  });

  it('a call that is not in the file is never sent, however due it is', async () => {
    // Production would send submitShares(8) here; rehearsal has nothing scheduled, so nothing goes.
    const chain = new FakeChain({ at: '2026-10-06T19:05:00Z' });
    const r = await run(chain, schedule(entry({ id: '117', notBefore: '2026-10-09T19:15:00Z', notAfter: '2026-10-09T21:30:00Z' })),
      { now: '2026-10-06T19:05:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.equal(chain.estimates.length, 0);
    assert.deepEqual(r.actions, []);
  });

  it('a step whose window has closed is not sent late', async () => {
    const chain = new FakeChain({ at: '2026-10-06T00:45:00Z' });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-06T00:45:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.equal(r.actions[0].decision, 'missed');
    assert.equal(r.exitCode, 1, 'the first run after the window closes says so');
    assert.match(r.alerts.alerts[0].title, /step 80 was not sent/);
  });

  it('a missed step is alerted once, not every run forever', async () => {
    const chain = new FakeChain({ at: '2026-10-06T02:00:00Z' });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-06T02:00:00Z' });
    assert.deepEqual(r.actions, []);
    assert.equal(r.exitCode, 0);
  });

  it('a row the runbook marks Complete is never sent', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80', status: 'Complete' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.deepEqual(r.actions, []);
  });
});

describe('at most once: the chain is the ledger', () => {
  it('a second run in the same window sees the first send and does not repeat it', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:25:00Z', respond: gatePass(7) });
    const s = schedule(entry({ id: '80' }));
    await run(chain, s, { now: '2026-10-05T22:25:05Z' });
    chain.headNumber = epochOf('2026-10-05T22:40:00Z');
    const r2 = await run(chain, s, { now: '2026-10-05T22:40:00Z' });
    assert.equal(chain.sends.length, 1);
    assert.equal(r2.actions[0].decision, 'already-sent');
    assert.equal(r2.actions[0].txHash, chain.sends[0].hash);
  });

  it('byte-identical gate checks (steps 78, 79) are told apart by their windows', async () => {
    const e78 = entry({ id: '78', notBefore: '2026-10-05T22:15:00Z', notAfter: '2026-10-06T00:30:00Z' });
    const e79 = entry({ id: '79', notBefore: '2026-10-05T22:20:00Z', notAfter: '2026-10-06T00:35:00Z', expect: 'fail' });
    const s = schedule(e78, e79);
    const chain = new FakeChain({ at: '2026-10-05T22:16:00Z', respond: (req, c) => ({ status: 1, gate: { quarter: c.gateNext, passed: c.gateNext === 5, steps: 4 } }), gateNext: 5 });
    const r1 = await run(chain, s, { now: '2026-10-05T22:16:00Z' });
    assert.deepEqual(r1.actions.map((a) => [a.id, a.decision]), [['78', 'sent']]);
    chain.headNumber = epochOf('2026-10-05T22:31:00Z');
    const r2 = await run(chain, s, { now: '2026-10-05T22:31:00Z' });
    assert.deepEqual(r2.actions.map((a) => [a.id, a.decision]), [['78', 'already-sent'], ['79', 'sent']]);
    assert.equal(r2.actions[1].match, true, 'Q6 failed, as step 79 expects');
    assert.equal(chain.sends.length, 2);
  });

  it('a transaction sent before the window opened does not count -- the 18:16 gate check is not step 78', async () => {
    const e78 = entry({ id: '78', notBefore: '2026-10-05T22:15:00Z', notAfter: '2026-10-06T00:30:00Z', gateQuarter: null });
    const chain = new FakeChain({ at: '2026-10-05T22:16:00Z', respond: gatePass(7) });
    chain.sentEarlier('2026-10-05T18:16:00Z', validateSchedule({ chainId: 314159, entries: [e78] }).entries[0]);
    const r = await run(chain, schedule(e78), { now: '2026-10-05T22:16:00Z' });
    assert.equal(r.actions[0].decision, 'sent');
  });

  it('a cranker transaction still in the mpool holds every send', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: gatePass(7) });
    chain.pendingExtra = 1;
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.equal(r.actions[0].decision, 'held');
  });

  it('if the blocks cannot account for every nonce, nothing is sent and a person is told', async () => {
    const e = entry({ id: '80' });
    const chain = new FakeChain({ at: '2026-10-05T22:30:00Z', respond: gatePass(7) });
    chain.sentEarlier('2026-10-05T22:26:00Z', validateSchedule({ chainId: 314159, entries: [e] }).entries[0]);
    chain.hidden = 1; // the block fetch comes back without it
    const r = await run(chain, schedule(e), { now: '2026-10-05T22:30:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.equal(r.actions[0].decision, 'held');
    assert.equal(r.exitCode, 1);
    assert.match(r.alerts.alerts[0].title, /cannot account/);
  });

  it('bisects the nonce history to find exactly the blocks holding the cranker\'s transactions', async () => {
    const chain = new FakeChain({ at: '2026-10-05T23:00:00Z' });
    const e = validateSchedule({ chainId: 314159, entries: [entry({})] }).entries[0];
    for (const t of ['2026-10-05T22:30:00Z', '2026-10-05T22:31:00Z', '2026-10-05T22:50:00Z']) chain.sentEarlier(t, e);
    chain.sentEarlier('2026-10-05T20:00:00Z', e); // before the lookback
    const found = await findSentSince(chain, Date.parse('2026-10-05T22:25:00Z') / 1000, await chain.head());
    assert.equal(found.complete, true);
    assert.deepEqual(found.txs.map((t) => t.blockNumber), ['22:30', '22:31', '22:50'].map((hm) => epochOf(`2026-10-05T${hm}:00Z`)));
  });
});

describe('expected reverts are sent anyway, and recorded', () => {
  it('step 80: sent with no pre-check and the explicit gas limit; tx, epoch, reason and match recorded', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:25:30Z', respond: () => ({ status: 0, revert: revertWith('StepWeightRecordsFailed', [16]) }) });
    const r = await run(chain, schedule(entry({ id: '80', gateQuarter: 7, expect: 'revert:StepWeightRecordsFailed' })), { now: '2026-10-05T22:25:30Z' });
    assert.equal(chain.estimates.length, 0, 'no eth_estimateGas / eth_call pre-check for an expected revert');
    assert.equal(chain.sends.length, 1);
    assert.equal(chain.sends[0].gasLimit, 100_000_800n, 'the explicit limit, its last five digits naming step 80');
    const a = r.actions[0];
    assert.equal(a.decision, 'sent');
    assert.match(a.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(a.epoch, chain.sends[0].blockNumber);
    assert.equal(a.result, 'reverted StepWeightRecordsFailed(16)');
    assert.equal(a.match, true);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.alerts.alerts, []);
  });

  it('step 117: StepsComplete() matches revert:StepsComplete', async () => {
    const chain = new FakeChain({ at: '2026-10-09T19:15:30Z', gateNext: 11, respond: () => ({ status: 0, revert: revertWith('StepsComplete') }) });
    const r = await run(chain, schedule(entry({ id: '117', gateQuarter: 11, notBefore: '2026-10-09T19:15:00Z', notAfter: '2026-10-09T21:30:00Z', expect: 'revert:StepsComplete' })),
      { now: '2026-10-09T19:15:30Z' });
    assert.equal(r.actions[0].match, true);
    assert.equal(r.actions[0].result, 'reverted StepsComplete()');
  });

  it('revert:* matches any revert', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: () => ({ status: 0, revert: revertWith('HoldUntil', [4130000]) }) });
    const r = await run(chain, schedule(entry({ id: '73', expect: 'revert:*' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(r.actions[0].match, true);
  });
});

describe('an unexpected outcome is sent and flagged', () => {
  it('expected pass, reverted on chain: sent anyway, flagged as a mismatch, exit 1', async () => {
    const chain = new FakeChain({ at: '2026-10-06T19:00:30Z', respond: () => ({ status: 0, revert: revertWith('NotBound', [8]) }) });
    const r = await run(chain, schedule(entry({ id: '93.1', function: 'submitShares', args: [8], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T21:15:00Z' })),
      { now: '2026-10-06T19:00:30Z' });
    assert.equal(chain.estimates.length, 1, 'a pass is estimated first');
    assert.equal(chain.sends.length, 1, 'and sent even though the estimate predicted a revert');
    assert.equal(chain.sends[0].gasLimit, 100_000_931n, 'the explicit limit (the estimate failed), tagged with step 93.1');
    const a = r.actions[0];
    assert.equal(a.match, false);
    assert.equal(a.result, 'reverted NotBound(8)');
    assert.equal(r.exitCode, 1);
    assert.match(r.alerts.alerts[0].title, /step 93.1 did not do what the plan expected/);
  });

  it('expected one error, got another: a mismatch', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: () => ({ status: 0, revert: revertWith('StepsComplete') }) });
    const r = await run(chain, schedule(entry({ id: '80', expect: 'revert:StepWeightRecordsFailed' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(r.actions[0].match, false);
    assert.equal(r.exitCode, 1);
  });

  it('expected a revert, it landed: a mismatch', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80', expect: 'revert:StepWeightRecordsFailed' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(r.actions[0].match, false);
    assert.equal(r.actions[0].result, 'landed, gate passed for Q7 (steps 5)');
  });

  it('step 79: "fail" means the gate check lands and reports passed = false', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:21:00Z', gateNext: 6, respond: () => ({ status: 1, gate: { quarter: 6, passed: false, steps: 4 } }) });
    const r = await run(chain, schedule(entry({ id: '79', gateQuarter: 6, expect: 'fail', notBefore: '2026-10-05T22:20:00Z' })), { now: '2026-10-05T22:21:00Z' });
    assert.equal(r.actions[0].match, true);
    const passing = new FakeChain({ at: '2026-10-05T22:21:00Z', gateNext: 6, respond: gatePass(6) });
    const r2 = await run(passing, schedule(entry({ id: '79', gateQuarter: 6, expect: 'fail', notBefore: '2026-10-05T22:20:00Z' })), { now: '2026-10-05T22:21:00Z' });
    assert.equal(r2.actions[0].match, false);
  });
});

describe('the gate quarter in the plan must be the one the call would check', () => {
  it('blocked, not sent, and a person is told while the window is fresh', async () => {
    // Tonight: steps 78/79 went out early, so the gate is at Q7 when step 78 ("Q5") opens.
    const chain = new FakeChain({ at: '2026-10-05T22:16:00Z', gateNext: 7, respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '78', gateQuarter: 5, notBefore: '2026-10-05T22:15:00Z' })), { now: '2026-10-05T22:16:00Z' });
    assert.equal(chain.sends.length, 0);
    assert.equal(r.actions[0].decision, 'blocked');
    assert.equal(r.exitCode, 1);
    // ...and not re-alerted every run after the first twenty minutes.
    const later = await run(chain, schedule(entry({ id: '78', gateQuarter: 5, notBefore: '2026-10-05T22:15:00Z' })), { now: '2026-10-05T23:00:00Z' });
    assert.equal(later.actions[0].decision, 'blocked');
    assert.equal(later.exitCode, 0);
  });

  it('a later step whose quarter does match still goes', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', gateNext: 7, respond: () => ({ status: 0, revert: revertWith('StepWeightRecordsFailed', [16]) }) });
    const s = schedule(
      entry({ id: '78', gateQuarter: 5, notBefore: '2026-10-05T22:15:00Z' }),
      entry({ id: '80', gateQuarter: 7, notBefore: '2026-10-05T22:25:00Z', expect: 'revert:StepWeightRecordsFailed' }),
    );
    const r = await run(chain, s, { now: '2026-10-05T22:26:00Z' });
    assert.deepEqual(r.actions.map((a) => [a.id, a.decision]), [['78', 'blocked'], ['80', 'sent']]);
  });
});

describe('pause and dry run send nothing', () => {
  it('paused: every open step is reported, none is sent, exit 0', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:26:00Z', pause: { paused: true, reason: 'CRANK_PAUSED is set' } });
    assert.equal(chain.sends.length, 0);
    assert.equal(chain.estimates.length, 0);
    assert.equal(r.actions[0].decision, 'paused');
    assert.equal(r.exitCode, 0);
  });

  it('the CRANK_PAUSED variable and the PAUSED file both pause', () => {
    assert.equal(resolvePause(new Date(), { CRANK_PAUSED: '1' }).paused, true);
    const dir = mkdtempSync(join(tmpdir(), 'pause-'));
    try {
      const file = join(dir, 'PAUSED');
      assert.equal(resolvePause(new Date(), { CRANK_PAUSE_FILE: file }).paused, false);
      writeFileSync(file, 'rehearsal hold\n');
      const p = resolvePause(new Date(), { CRANK_PAUSE_FILE: file });
      assert.equal(p.paused, true);
      assert.match(p.reason, /pause file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dry run: decides and reports, broadcasts nothing', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80', expect: 'revert:StepWeightRecordsFailed' })), { now: '2026-10-05T22:26:00Z', dryRun: true });
    assert.equal(chain.sends.length, 0);
    assert.equal(r.actions[0].decision, 'dry-run');
  });
});

describe('calibnet only', () => {
  it('refuses any chain id but 314159', () => {
    assert.throws(() => assertRehearsalChain(3141592n, 'devnet'), RehearsalRefused);
    assert.throws(() => assertRehearsalChain(314n, 'mainnet'), RehearsalRefused);
    assert.doesNotThrow(() => assertRehearsalChain(314159n, 'calibnet'));
  });

  it('CRANK_MODE=rehearsal on mainnet or devnet refuses before reading anything or touching a node', async () => {
    for (const NETWORK of ['mainnet', 'devnet']) {
      const config = loadConfig({ NETWORK, CRANK_MODE: 'rehearsal', RPC_URL: 'http://127.0.0.1:1', CRANK_SCHEDULE_FILE: '/nonexistent.json' }, { requireKey: false });
      await assert.rejects(runRehearsalFromEnv(config), RehearsalRefused);
    }
  });

  it('CRANK_MODE takes production or rehearsal and nothing else', () => {
    assert.equal(loadConfig({ NETWORK: 'calibnet' }, { requireKey: false }).mode, 'production');
    assert.throws(() => loadConfig({ NETWORK: 'calibnet', CRANK_MODE: 'rehersal' }, { requireKey: false }), /CRANK_MODE/);
  });
});

describe('failures stop the run in order', () => {
  it('a broadcast that fails stops later steps; the next run picks them up', async () => {
    const chain = new FakeChain({ at: '2026-10-06T19:01:00Z', respond: () => ({ status: 1 }) });
    chain.failSend = Object.assign(new Error('insufficient funds'), { shortMessage: 'insufficient funds' });
    const s = schedule(
      entry({ id: '93.1', function: 'submitShares', args: [8], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T21:15:00Z' }),
      entry({ id: '93.2', notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T21:15:00Z' }),
    );
    const r = await run(chain, s, { now: '2026-10-06T19:01:00Z' });
    assert.deepEqual(r.actions.map((a) => [a.id, a.decision]), [['93.1', 'failed'], ['93.2', 'held']]);
    assert.equal(r.exitCode, 1);
  });
});

describe('one line per action', () => {
  it('carries step, function, tx hash, epoch, result and match', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:25:30Z', respond: () => ({ status: 0, revert: revertWith('StepWeightRecordsFailed', [16]) }) });
    const r = await run(chain, schedule(entry({ id: '80', expect: 'revert:StepWeightRecordsFailed' })), { now: '2026-10-05T22:25:30Z' });
    const line = r.lines.find((l) => l.includes('rehearsal step=80 fn='));
    assert.match(line, /step=80 fn=quarterlyGateCheck\(\) tx=0x[0-9a-f]{64} epoch=\d+ decision=sent result="reverted StepWeightRecordsFailed\(16\)" expect=revert:StepWeightRecordsFailed match=yes/);
    assert.equal(actionLine({ id: '1', call: 'x()', decision: 'waiting', expect: 'pass' }), 'step=1 fn=x() tx=- epoch=- decision=waiting result=- expect=pass match=-');
  });
});

describe('Lotus receipt return values', () => {
  it('decodes the CBOR byte string Lotus wraps an FEVM output in', () => {
    assert.equal(cborBytesToHex('QA=='), '0x'); // a successful call that returns nothing, as seen on calibnet
    const revert = revertWith('StepsComplete');
    const raw = Buffer.from(revert.slice(2), 'hex');
    assert.equal(cborBytesToHex(Buffer.concat([Buffer.from([0x40 | raw.length]), raw]).toString('base64')), revert);
    const long = Buffer.from(revertWith('StepWeightRecordsFailed', [16]).slice(2), 'hex'); // 36 bytes: one length byte
    assert.equal(cborBytesToHex(Buffer.concat([Buffer.from([0x58, long.length]), long]).toString('base64')), `0x${long.toString('hex')}`);
    assert.equal(cborBytesToHex(''), null);
    assert.equal(cborBytesToHex(Buffer.from([0x01]).toString('base64')), null, 'not a byte string');
  });
});

describe('QA round 1: attribution, windows, outcomes', () => {
  it('a held gate step never claims a later step\'s transaction (no double send)', async () => {
    // The gate is already at Q7 when step 78 ("Q5") opens: 78 is held, 80 ("Q7") goes.
    const s = schedule(
      entry({ id: '78', gateQuarter: 5, notBefore: '2026-10-05T22:15:00Z', notAfter: '2026-10-05T23:00:00Z' }),
      entry({ id: '80', gateQuarter: 7, notBefore: '2026-10-05T22:25:00Z', notAfter: '2026-10-05T23:10:00Z', expect: 'revert:StepWeightRecordsFailed' }),
    );
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', gateNext: 7, respond: () => ({ status: 0, revert: revertWith('StepWeightRecordsFailed', [16]) }) });
    const r1 = await run(chain, s, { now: '2026-10-05T22:26:00Z' });
    assert.deepEqual(r1.actions.map((a) => [a.id, a.decision]), [['78', 'blocked'], ['80', 'sent']]);
    chain.headNumber = epochOf('2026-10-05T22:41:00Z');
    const r2 = await run(chain, s, { now: '2026-10-05T22:41:00Z' });
    assert.deepEqual(r2.actions.map((a) => [a.id, a.decision]), [['78', 'blocked'], ['80', 'already-sent']]);
    assert.equal(chain.sends.length, 1, 'step 80 was sent twice');
  });

  // Revised in QA round 2. A send inside 31's window that LANDED fits 30.1 (pass), but at that
  // moment the engine would have been sending 31. On chain that is a genuine conflict, so 31 is
  // held and a person is told -- never sent a second time on a guess.
  it('a Complete row\'s late send inside the next identical row\'s window: that row is held, not resent', async () => {
    const e30 = entry({ id: '30.1', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T19:45:00Z', status: 'Complete' });
    const e31 = entry({ id: '31', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:15:00Z', notAfter: '2026-10-06T20:00:00Z', expect: 'revert:AlreadySubmitted' });
    const s = schedule(e30, e31);
    const chain = new FakeChain({ at: '2026-10-06T19:20:00Z', respond: () => ({ status: 0, revert: revertWith('AlreadySubmitted', [3]) }) });
    chain.sentEarlier('2026-10-06T19:16:00Z', s.entries[0]); // sent late, inside step 31's window
    const r = await run(chain, s, { now: '2026-10-06T19:20:00Z' });
    assert.deepEqual(r.actions.map((a) => [a.id, a.decision, a.result]), [['31', 'held', 'possibly sent already']]);
    assert.equal(chain.sends.length, 0);
    assert.match(r.alerts.alerts[0].title, /step 31 held: it may already have been sent/);
  });

  it('...but the cranker\'s own send of 31 after someone else did 30.1 is simply 31', async () => {
    const e30 = entry({ id: '30.1', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T19:45:00Z', status: 'Complete' });
    const e31 = entry({ id: '31', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:15:00Z', notAfter: '2026-10-06T20:00:00Z', expect: 'revert:AlreadySubmitted' });
    const s = schedule(e30, e31);
    const chain = new FakeChain({ at: '2026-10-06T19:16:00Z', respond: () => ({ status: 0, revert: revertWith('AlreadySubmitted', [3]) }) });
    await run(chain, s, { now: '2026-10-06T19:16:00Z' });
    chain.headNumber = epochOf('2026-10-06T19:31:00Z');
    const r = await run(chain, s, { now: '2026-10-06T19:31:00Z' });
    assert.deepEqual(r.actions.map((a) => [a.id, a.decision, a.match]), [['31', 'already-sent', true]]);
    assert.equal(chain.sends.length, 1);
  });

  it('out of gas is not the revert a row was testing', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', respond: () => ({ status: 0, exitCode: 7 }) });
    const r = await run(chain, schedule(entry({ id: '73', expect: 'revert:*' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(r.actions[0].match, false);
    assert.equal(r.actions[0].result, 'failed on chain, exit code 7');
  });

  it('no send starts within a minute of notAfter, by either clock', async () => {
    const chain = new FakeChain({ at: '2026-10-06T00:39:00Z', respond: gatePass(7) });
    const r = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-06T00:39:30Z' });
    assert.equal(chain.sends.length, 0);
    assert.equal(r.actions[0].decision, 'too-late');
    const ahead = new FakeChain({ at: '2026-10-06T00:39:30Z', respond: gatePass(7) }); // head ahead of the runner
    await run(ahead, schedule(entry({ id: '80' })), { now: '2026-10-06T00:38:45Z' });
    assert.equal(ahead.sends.length, 0);
  });

  it('a gate check that tested a different quarter is not a match, even if it passed', async () => {
    const chain = new FakeChain({ at: '2026-10-06T08:01:00Z', gateNext: 7, respond: () => ({ status: 1, gate: { quarter: 8, passed: true, steps: 5 } }) });
    const r = await run(chain, schedule(entry({ id: '86', gateQuarter: 7, notBefore: '2026-10-06T08:00:00Z', notAfter: '2026-10-06T08:45:00Z' })), { now: '2026-10-06T08:01:00Z' });
    assert.equal(r.actions[0].match, false);
  });

  it('a dry run pages nobody, and pictures the gate advancing through the passes it would send', async () => {
    const s = schedule(
      entry({ id: '78', gateQuarter: 5, notBefore: '2026-10-05T22:15:00Z' }),
      entry({ id: '79', gateQuarter: 6, notBefore: '2026-10-05T22:20:00Z', expect: 'fail' }),
      entry({ id: '80', gateQuarter: 7, notBefore: '2026-10-05T22:25:00Z', expect: 'revert:StepWeightRecordsFailed' }),
    );
    const chain = new FakeChain({ at: '2026-10-05T22:26:00Z', gateNext: 5 });
    const r = await run(chain, s, { now: '2026-10-05T22:26:00Z', dryRun: true });
    assert.deepEqual(r.actions.map((a) => a.decision), ['dry-run', 'dry-run', 'dry-run']);
    const blocked = await run(new FakeChain({ at: '2026-10-05T22:26:00Z', gateNext: 7 }), s, { now: '2026-10-05T22:26:00Z', dryRun: true });
    assert.deepEqual(blocked.actions.map((a) => a.decision), ['blocked', 'blocked', 'dry-run']);
    assert.deepEqual(blocked.alerts.alerts, []);
    assert.equal(blocked.exitCode, 0);
  });

  it('a step found already sent is still checked against the plan', async () => {
    const e = entry({ id: '80', gateQuarter: 7, expect: 'revert:StepWeightRecordsFailed' });
    const s = schedule(e);
    const chain = new FakeChain({ at: '2026-10-05T22:40:00Z', gateNext: 7 });
    chain.sentEarlier('2026-10-05T22:26:00Z', s.entries[0], { status: 0, revert: revertWith('StepsComplete') }); // the run that sent it crashed
    const r = await run(chain, s, { now: '2026-10-05T22:40:00Z' });
    assert.equal(r.actions[0].decision, 'already-sent');
    assert.equal(r.actions[0].result, 'reverted StepsComplete()');
    assert.equal(r.actions[0].match, false);
    assert.equal(chain.sends.length, 0);
  });

  it('a stuck cranker transaction is alerted once it has held a step for a report window', async () => {
    const chain = new FakeChain({ at: '2026-10-05T22:46:00Z', respond: gatePass(7) });
    chain.pendingExtra = 1;
    const early = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:26:00Z' });
    assert.equal(early.exitCode, 0);
    const later = await run(chain, schedule(entry({ id: '80' })), { now: '2026-10-05T22:46:00Z' });
    assert.equal(later.exitCode, 1);
    assert.match(later.alerts.alerts[0].title, /stuck/);
  });
});

describe('QA round 2', () => {
  it('a Complete row whose own send predates the scan cannot steal a later identical row\'s send', async () => {
    // 30.1 (Complete) sent 19:00:30; 31 is the same submitShares(3), opening 19:15. The scan must
    // reach back far enough for 30.1 to see its own transaction, or it takes 31's and 31 goes twice.
    const s = schedule(
      entry({ id: '30.1', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T19:45:00Z', status: 'Complete' }),
      entry({ id: '31', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:15:00Z', notAfter: '2026-10-06T20:00:00Z', expect: 'revert:AlreadySubmitted' }),
    );
    const chain = new FakeChain({ at: '2026-10-06T19:15:30Z', respond: () => ({ status: 0, revert: revertWith('AlreadySubmitted', [3]) }) });
    chain.sentEarlier('2026-10-06T19:00:30Z', s.entries[0]);
    await run(chain, s, { now: '2026-10-06T19:15:30Z' });
    chain.headNumber = epochOf('2026-10-06T19:30:30Z');
    const r2 = await run(chain, s, { now: '2026-10-06T19:30:30Z' });
    assert.equal(chain.sends.length, 1, 'step 31 was broadcast twice');
    assert.deepEqual(r2.actions.map((a) => [a.id, a.decision]), [['31', 'already-sent']]);
  });

  it('...and the same with two Pending rows whose windows differ in length', async () => {
    const s = schedule(
      entry({ id: 'A', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T19:30:00Z' }),
      entry({ id: 'B', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:15:00Z', notAfter: '2026-10-06T21:00:00Z', expect: 'revert:AlreadySubmitted' }),
    );
    const chain = new FakeChain({ at: '2026-10-06T19:00:30Z', respond: (req, c) => (c.sends.length ? { status: 0, revert: revertWith('AlreadySubmitted', [3]) } : { status: 1 }) });
    await run(chain, s, { now: '2026-10-06T19:00:30Z' });
    for (const t of ['2026-10-06T19:15:30Z', '2026-10-06T19:50:00Z', '2026-10-06T20:20:00Z']) {
      chain.headNumber = Math.max(chain.headNumber, epochOf(t));
      await run(chain, s, { now: t });
    }
    assert.equal(chain.sends.length, 2, `sends: ${chain.sends.length}`);
  });

  it('the run\'s own landed gate check moves the gate on, even if the next read is a block behind', async () => {
    const s = schedule(
      entry({ id: '78', gateQuarter: 5, notBefore: '2026-10-05T22:15:00Z' }),
      entry({ id: '79', gateQuarter: 6, notBefore: '2026-10-05T22:20:00Z', expect: 'fail' }),
    );
    const chain = new FakeChain({ at: '2026-10-05T22:21:00Z', gateNext: 5, respond: (req, c) => ({ status: 1, gate: { quarter: c.gateNext, passed: c.gateNext === 5, steps: 5 } }) });
    const stale = chain.gateState.bind(chain);
    chain.gateState = async (swa, tag) => (tag === undefined || tag === 'latest' ? { next: 5, lastChecked: 4, steps: 4, complete: false } : stale(swa, tag));
    const r = await run(chain, s, { now: '2026-10-05T22:21:00Z' });
    assert.deepEqual(r.actions.map((a) => [a.id, a.decision]), [['78', 'sent'], ['79', 'sent']]);
  });

  it('a window that closes while paused is on the record, not alerted', async () => {
    const chain = new FakeChain({ at: '2026-10-05T23:15:00Z' });
    const r = await run(chain, schedule(entry({ id: '80', notAfter: '2026-10-05T23:10:00Z' })),
      { now: '2026-10-05T23:15:00Z', pause: { paused: true, reason: 'CRANK_PAUSED is set' } });
    assert.deepEqual(r.actions.map((a) => [a.id, a.decision, a.result]), [['80', 'paused', 'window closed while paused']]);
    assert.deepEqual(r.alerts.alerts, []);
    assert.equal(r.exitCode, 0);
  });
});

describe('the gas limit names the step', () => {
  it('step ids map to readable tags', () => {
    assert.deepEqual(['31', '30.1', '93.2', '117'].map((id) => String(tagGasLimit(100_000_000n, id))), ['100000310', '100000301', '100000932', '100001170']);
    assert.equal(tagGasLimit(42_172_838n, '86'), 42_200_860n, 'an estimate is rounded up to the next 100,000 first');
  });

  it('the 19:44 case: 30.1 too late, 31 sent and landed -- the tag says it was 31, so 30.1 is missed and 31 not resent', async () => {
    const s = schedule(
      entry({ id: '30.1', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T19:45:00Z' }),
      entry({ id: '31', function: 'submitShares', args: [3], notBefore: '2026-10-06T19:15:00Z', notAfter: '2026-10-06T20:00:00Z', expect: 'revert:AlreadySubmitted' }),
    );
    const chain = new FakeChain({ at: '2026-10-06T19:44:00Z', respond: () => ({ status: 1 }) }); // Q3 never submitted: it lands
    const r1 = await run(chain, s, { now: '2026-10-06T19:44:10Z' });
    assert.deepEqual(r1.actions.map((a) => [a.id, a.decision]), [['30.1', 'too-late'], ['31', 'sent']]);
    chain.headNumber = epochOf('2026-10-06T19:46:00Z');
    const r2 = await run(chain, s, { now: '2026-10-06T19:46:00Z' });
    assert.deepEqual(r2.actions.map((a) => [a.id, a.decision]), [['30.1', 'missed'], ['31', 'already-sent']]);
    assert.equal(chain.sends.length, 1);
  });
});
