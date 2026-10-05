/**
 * QA round 2: adversarial tests for rehearsal mode (src/rehearsal/*), written by an independent
 * reviewer against commit e758dd3. Unit level; nothing here opens a socket.
 *
 * QChain is a new double, written for this file. Unlike the FakeChain in rehearsal.test.mjs it
 * models a block holding several messages (the cranker's and other senders'), derives the SWA
 * gate at any block from the gate events that landed at or before it, and can be told to misbehave
 * the ways a load-balanced Lotus endpoint does: a null receipt, a throwing receipt read, pruned
 * historical state, a pending nonce below the latest one, a head that moves between reads.
 *
 * Every assertion states the behaviour the spec asks for. A failing test is a finding.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAddress, Interface } from 'ethers';

import swaAbi from '../abi/StreamWeightActor.json' with { type: 'json' };
import sraAbi from '../abi/ServiceRewardsActor.json' with { type: 'json' };
import { STORAGE_SLOTS } from '../src/config.mjs';
import { calldataFor, ethersChain, resolveGateQuarters, runRehearsal } from '../src/rehearsal/engine.mjs';
import { summariseRehearsal } from '../src/rehearsal/run.mjs';
import { validateSchedule } from '../src/rehearsal/schedule.mjs';

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
      // the other contract
    }
  }
  throw new Error(`no error ${name}`);
};

const PASS = (q) => ({ status: 1, gate: { quarter: q, passed: true, steps: 5 } });
const FAILQ = (q) => ({ status: 1, gate: { quarter: q, passed: false, steps: 5 } });
const SWRF = () => ({ status: 0, revert: revertWith('StepWeightRecordsFailed', [16]) });
const LANDED = { status: 1 };

/** The SWA as tonight's plan expects it, given the quarter it would check. */
const tonightGate = (g) => (g === 5 ? PASS(5) : g === 6 ? FAILQ(6) : SWRF());
const subQ = (data) => Number(SRA.decodeFunctionData('submitShares', data)[0]);

class QChain {
  constructor({ at, gate0 = 5, gate = tonightGate, sra = null } = {}) {
    this.headNumber = epochOf(at);
    this.gate0 = gate0; // the SWA's next unchecked quarter before any gate event this double knows of
    this.gateFn = gate; // (quarterItWouldCheck) => result
    this.sraFn = sra; // (q, lastSubmitted) => result; default: AlreadySubmitted / pass
    this.txs = []; // the cranker's messages, in nonce order
    this.third = []; // other senders' gate events: {blockNumber, idx, passed}
    this.sends = [];
    this.estimates = [];
    this.pendingDelta = 0;
    this.receiptNull = new Set();
    this.receiptThrows = new Set();
    this.historicalGateThrows = false;
    this.waitBlocks = 0;
    this.failWait = false;
    this.failSend = null;
    this.afterHead = null;
    this.beforeSend = null;
    this.counter = 0;
  }
  ts(n) {
    return GENESIS + n * 30;
  }
  at(iso) {
    this.headNumber = Math.max(this.headNumber, epochOf(iso));
    return this;
  }
  itemsIn(b) {
    return this.txs.filter((t) => t.blockNumber === b).length + this.third.filter((t) => t.blockNumber === b).length;
  }
  /** Gate events strictly before (block b, position idx). */
  gateBefore(b, idx = Infinity) {
    const ev = [
      ...this.txs.filter((t) => t.result?.status === 1 && t.result.gate).map((t) => [t.blockNumber, t.idx]),
      ...this.third.map((t) => [t.blockNumber, t.idx]),
    ];
    return this.gate0 + ev.filter(([bn, i]) => bn < b || (bn === b && i < idx)).length;
  }
  gateNextAt(b) {
    return this.gateBefore(b + 1, 0);
  }
  lastSubmitted(beforeBlock = Infinity, beforeIdx = Infinity) {
    let last = this.sraBase ?? 0;
    for (const t of this.txs) {
      if (t.to !== TARGETS.sra || t.result?.status !== 1) continue;
      if (t.blockNumber < beforeBlock || (t.blockNumber === beforeBlock && t.idx < beforeIdx)) last = Math.max(last, subQ(t.data));
    }
    return last;
  }
  respond(req, b, idx) {
    if (String(req.to).toLowerCase() === TARGETS.swa.toLowerCase()) return this.gateFn(this.gateBefore(b, idx));
    const q = subQ(req.data);
    const last = this.lastSubmitted(b, idx);
    if (this.sraFn) return this.sraFn(q, last);
    return q <= last ? { status: 0, revert: revertWith('AlreadySubmitted', [q]) } : LANDED;
  }
  /** A message the cranker's key sent earlier (a run, or a person with force_call), landed at `when`. */
  place(when, entryLike, result) {
    const b = typeof when === 'number' ? when : epochOf(when);
    const v = validateSchedule({ chainId: 314159, entries: [{ ...entryLike }] }).entries[0];
    const tx = { hash: `0x${(++this.counter).toString(16).padStart(64, '0')}`, to: TARGETS[v.contract], data: calldataFor(v), blockNumber: b, idx: this.itemsIn(b), nonce: this.txs.length, result, gasLimit: 100_000_000n };
    this.txs.push(tx);
    return tx;
  }
  /** Somebody else's quarterlyGateCheck() that landed (and so moved the gate). */
  thirdPartyGate(when, passed = true) {
    const b = typeof when === 'number' ? when : epochOf(when);
    this.third.push({ blockNumber: b, idx: this.itemsIn(b), passed });
  }
  async head() {
    const h = { number: this.headNumber, timestamp: this.ts(this.headNumber) };
    if (this.afterHead) {
      const f = this.afterHead;
      this.afterHead = null;
      f(this);
    }
    return h;
  }
  async nonceAt(tag) {
    if (tag === 'pending') return this.txs.length + this.pendingDelta;
    const b = tag === 'latest' ? this.headNumber : tag;
    return this.txs.filter((t) => t.blockNumber <= b).length;
  }
  async timestampAt(n) {
    return this.ts(n);
  }
  async sentInBlock(n) {
    return this.txs
      .filter((t) => t.blockNumber === n && n <= this.headNumber)
      .sort((a, b) => a.idx - b.idx)
      .map((t) => ({ hash: t.hash, to: t.to, data: t.data, nonce: t.nonce, gasLimit: t.gasLimit, blockNumber: n, timestamp: this.ts(n) }));
  }
  async gateState(swa, blockTag = 'latest') {
    if (blockTag !== 'latest' && this.historicalGateThrows) {
      throw Object.assign(new Error('missing trie node (state pruned)'), { code: 'UNKNOWN_ERROR', shortMessage: 'state pruned' });
    }
    const next = this.gateNextAt(blockTag === 'latest' ? this.headNumber : blockTag);
    return { next, lastChecked: next - 1, steps: 4, complete: false };
  }
  receiptFor(tx) {
    const r = tx.result ?? LANDED;
    const logs = r.status === 1 && r.gate
      ? [{ address: TARGETS.swa, ...SWA.encodeEventLog('QuarterlyGateCheckResult', [r.gate.quarter, r.gate.passed, r.gate.steps]) }]
      : [];
    return { hash: tx.hash, status: r.status, blockNumber: tx.blockNumber, gasUsed: 4_000_000n, logs };
  }
  async receiptOf(hash) {
    if (this.receiptThrows.has(hash)) throw Object.assign(new Error('eth_getTransactionReceipt failed'), { code: 'UNKNOWN_ERROR' });
    if (this.receiptNull.has(hash)) return null;
    const tx = this.txs.find((t) => t.hash === hash);
    if (!tx || tx.blockNumber > this.headNumber) return null;
    return this.receiptFor(tx);
  }
  async estimateGas(req) {
    this.estimates.push(req);
    const r = this.respond(req, this.headNumber + 1, 0);
    if (r.status === 0) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: r.revert });
    return 1_000_000n;
  }
  async send(req) {
    if (this.failSend) throw this.failSend;
    const b = this.headNumber + 1;
    if (this.beforeSend) this.beforeSend(this, b);
    const idx = this.itemsIn(b);
    const result = this.respond(req, b, idx);
    const tx = { hash: `0x${(++this.counter).toString(16).padStart(64, '0')}`, ...req, blockNumber: b, idx, nonce: this.txs.length, result };
    this.txs.push(tx);
    this.sends.push(tx);
    this.headNumber = b;
    return { hash: tx.hash, tx };
  }
  async wait(t) {
    if (this.failWait) throw Object.assign(new Error('timeout waiting for receipt'), { code: 'TIMEOUT', shortMessage: 'timeout waiting for receipt' });
    this.headNumber += this.waitBlocks;
    return this.receiptFor(t.tx);
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
const one = (e) => schedule(e).entries[0];

// Tonight's three byte-identical gate checks, as in config/rehearsal-schedule.json.
const E78 = entry({ id: '78', step: 78, gateQuarter: 5, notBefore: '2026-10-05T22:15:00Z', notAfter: '2026-10-05T23:00:00Z', expect: 'pass' });
const E79 = entry({ id: '79', step: 79, gateQuarter: 6, notBefore: '2026-10-05T22:20:00Z', notAfter: '2026-10-05T23:05:00Z', expect: 'fail' });
const E80 = entry({ id: '80', step: 80, gateQuarter: 7, notBefore: '2026-10-05T22:25:00Z', notAfter: '2026-10-05T23:10:00Z', expect: 'revert:StepWeightRecordsFailed' });
// Runbook steps 30.1 / 31: the same submitShares(3), windows overlapping.
const E30 = entry({ id: '30.1', step: 30, function: 'submitShares', args: [3], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T19:45:00Z', expect: 'pass' });
const E31 = entry({ id: '31', step: 31, function: 'submitShares', args: [3], notBefore: '2026-10-06T19:15:00Z', notAfter: '2026-10-06T20:00:00Z', expect: 'revert:*' });

function harness() {
  const alerts = { alerts: [], raise(a) { this.alerts.push(a); return a; } };
  const lines = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, (m) => lines.push(`${l} ${m}`)]));
  return { alerts, lines, log };
}

/** Every engine run in this file, for the exit-code/alert invariant at the end. */
const ALL_RUNS = [];

async function run(chain, sched, { now, dryRun = false, pause = { paused: false, reason: null }, cranker = CRANKER, reportWindowMs = 15 * 60_000, clock } = {}) {
  const h = harness();
  const nowMs = typeof now === 'number' ? now : ms(now);
  const result = await runRehearsal({
    schedule: sched, targets: TARGETS, chain, cranker, nowMs, clock, dryRun, pause, receiptPollMs: 1,
    gasLimit: 100_000_000n, reportWindowMs, confirmations: 1, alerts: h.alerts, log: h.log,
  });
  const r = { ...result, ...h, dryRun };
  ALL_RUNS.push(r);
  return r;
}
const decisions = (r) => r.actions.map((a) => [a.id, a.decision]);
const explain = (r) => JSON.stringify(r.actions.map((a) => [a.id, a.decision, a.txHash?.slice(-4) ?? null, a.result]));

// =============================================================================================
describe('QA2: two of the cranker\'s gate checks in one block', () => {
  it('landed (Q5) then reverted, same block: tested quarters are 5 and 6; each step keeps its own tx', async () => {
    const c = new QChain({ at: '2026-10-05T22:30:00Z', gate0: 5 });
    const E79r = { ...E79, expect: 'revert:*' };
    const b = epochOf('2026-10-05T22:21:00Z');
    const t1 = c.place(b, E78, PASS(5));
    const t2 = c.place(b, E79r, SWRF());
    const txs = (await c.sentInBlock(b)).map((t) => ({ ...t }));
    assert.equal(await resolveGateQuarters(c, txs, TARGETS.swa), true);
    assert.deepEqual(txs.map((t) => t.testedQuarter), [5, 6]);
    const r = await run(c, schedule(E78, E79r), { now: '2026-10-05T22:30:00Z' });
    assert.deepEqual(decisions(r), [['78', 'already-sent'], ['79', 'already-sent']], explain(r));
    assert.deepEqual(r.actions.map((a) => a.txHash), [t1.hash, t2.hash]);
    assert.deepEqual(r.actions.map((a) => a.match), [true, true]);
    assert.equal(c.sends.length, 0);
  });

  it('reverted then landed (Q5), same block: both tested Q5; Q6 (step 79) is still sent exactly once', async () => {
    const c = new QChain({ at: '2026-10-05T22:30:00Z', gate0: 5 });
    const b = epochOf('2026-10-05T22:21:00Z');
    c.place(b, E78, SWRF());
    c.place(b, E78, PASS(5));
    const txs = (await c.sentInBlock(b)).map((t) => ({ ...t }));
    assert.equal(await resolveGateQuarters(c, txs, TARGETS.swa), true);
    assert.deepEqual(txs.map((t) => t.testedQuarter), [5, 5]);
    const r = await run(c, schedule(E78, E79), { now: '2026-10-05T22:30:00Z' });
    assert.deepEqual(decisions(r), [['78', 'already-sent'], ['79', 'sent']], explain(r));
    const r2 = await run(c.at('2026-10-05T22:40:00Z'), schedule(E78, E79), { now: '2026-10-05T22:40:00Z' });
    assert.deepEqual(decisions(r2), [['78', 'already-sent'], ['79', 'already-sent']], explain(r2));
    assert.equal(c.sends.length, 1);
  });

  it('landed (Q5) then reverted (Q6) in one block, the landed one\'s receipt comes back null: step 79 is not sent a second time', async () => {
    // eth_getTransactionReceipt answers null for a mined message on an endpoint whose tx index lags.
    const c = new QChain({ at: '2026-10-05T22:30:00Z', gate0: 5 });
    const E79r = { ...E79, expect: 'revert:*' };
    const b = epochOf('2026-10-05T22:21:00Z');
    const t1 = c.place(b, E78, PASS(5));
    c.place(b, E79r, SWRF());
    c.receiptNull.add(t1.hash);
    const r = await run(c, schedule(E78, E79r), { now: '2026-10-05T22:30:00Z' });
    assert.equal(c.sends.length, 0,
      `the cranker re-sent a gate check that its own earlier message (which tested Q6) already covered; decisions ${explain(r)}`);
  });

  it('real ethersChain(): a null receipt for the landed check is taken as "not landed", so the next check in its block gets the wrong quarter', async () => {
    // Same block B: the cranker's check #1 landed (tested Q5; its receipt comes back null), #2
    // reverted (tested Q6). The SWA's lastCheckedQuarter at B-1 is 4.
    const B = 2600;
    const data = calldataFor(one(E78));
    const t1 = { hash: `0x${'1'.padStart(64, '0')}`, to: TARGETS.swa, data, blockNumber: B, nonce: 0 };
    const t2 = { hash: `0x${'2'.padStart(64, '0')}`, to: TARGETS.swa, data, blockNumber: B, nonce: 1 };
    const slot = BigInt(STORAGE_SLOTS.swaGateParams.slot);
    const provider = {
      async getTransactionReceipt(h) {
        return h === t1.hash ? null : { hash: h, status: 0, blockNumber: B, logs: [] };
      },
      async getStorage(addr, key, tag) {
        const lastChecked = tag === B - 1 ? 4 : 5;
        return '0x' + (BigInt(key) === slot ? lastChecked : 0).toString(16).padStart(64, '0');
      },
    };
    const chain = ethersChain({ provider, wallet: null, address: CRANKER });
    const txs = [{ ...t1 }, { ...t2 }];
    const ok = await resolveGateQuarters(chain, txs, TARGETS.swa);
    assert.ok(!ok || txs[1].testedQuarter === 6,
      `resolveGateQuarters returned ${ok} with tested quarters ${JSON.stringify(txs.map((t) => t.testedQuarter))}; #2 tested Q6`);
  });

  it('a gate check whose receipt read throws: nothing sent, a person told, exit 1', async () => {
    const c = new QChain({ at: '2026-10-05T22:31:00Z', gate0: 7, gate: () => SWRF() });
    const t = c.place('2026-10-05T22:26:00Z', E80, SWRF());
    c.receiptThrows.add(t.hash);
    const r = await run(c, schedule(E80), { now: '2026-10-05T22:31:00Z' });
    // (The row is labelled already-sent: a gate check of unknown quarter matches any gate entry by
    // window. Nothing is sent either way, which is what matters.)
    assert.ok(decisions(r).every(([, d]) => d === 'held' || d === 'already-sent'), explain(r));
    assert.equal(c.sends.length, 0);
    assert.equal(r.exitCode, 1);
    assert.match(r.alerts.alerts.map((a) => a.title).join('|'), /cannot account/);
  });
});

// =============================================================================================
describe('QA2: somebody else calls quarterlyGateCheck()', () => {
  it('a third party checks Q5 inside step 78\'s window before the cranker: 78 blocked (alerted once), 79 and 80 go on time, nothing sent twice', async () => {
    const s = schedule(E78, E79, E80);
    const c = new QChain({ at: '2026-10-05T22:16:00Z', gate0: 5 });
    c.thirdPartyGate('2026-10-05T22:15:30Z', true);
    const runs = [];
    // Runs every 5 minutes, so the report window is 5 minutes (it is meant to equal the cadence).
    for (const t of ['2026-10-05T22:16:00Z', '2026-10-05T22:21:00Z', '2026-10-05T22:26:00Z', '2026-10-05T22:31:00Z', '2026-10-05T22:46:00Z']) {
      runs.push(await run(c.at(t), s, { now: t, reportWindowMs: 5 * 60_000 }));
    }
    assert.deepEqual(decisions(runs[1]), [['78', 'blocked'], ['79', 'sent']]);
    assert.deepEqual(decisions(runs[2]), [['78', 'blocked'], ['79', 'already-sent'], ['80', 'sent']]);
    assert.deepEqual(decisions(runs[4]), [['78', 'blocked'], ['79', 'already-sent'], ['80', 'already-sent']]);
    assert.equal(c.sends.length, 2);
    const blocked78 = runs.flatMap((r) => r.alerts.alerts).filter((a) => /step 78 held/.test(a.title));
    assert.equal(blocked78.length, 1, 'the blocked step 78 was alerted more or less than once');
  });

  it('a third party\'s check lands in the cranker\'s block, just ahead of it (race): no step is sent twice', async () => {
    const s = schedule(E78, E79);
    const c = new QChain({ at: '2026-10-05T22:21:00Z', gate0: 5 });
    let raced = false;
    c.beforeSend = (chain, b) => {
      if (!raced) {
        raced = true;
        chain.thirdPartyGate(b, true); // lands first in the same block: the cranker's call now tests Q6
      }
    };
    const r1 = await run(c, s, { now: '2026-10-05T22:21:00Z' });
    assert.equal(r1.actions[0].decision, 'sent');
    assert.equal(r1.actions[0].match, false, 'a check that tested Q6 is not step 78');
    assert.equal(r1.exitCode, 1);
    const r2 = await run(c.at('2026-10-05T22:26:00Z'), s, { now: '2026-10-05T22:26:00Z' });
    assert.deepEqual(decisions(r2), [['78', 'blocked'], ['79', 'already-sent']], explain(r2));
    assert.equal(r2.actions[1].match, true, 'Q6 landed failed, as 79 expects');
    assert.equal(c.sends.length, 1);
  });

  it('a third party\'s check lands earlier in the block than the cranker\'s reverted check: each step at most once', async () => {
    // The cranker's message tested Q7 (third party took Q6), but the block-before state says Q6.
    const s = schedule(E79, E80);
    const c = new QChain({ at: '2026-10-05T22:31:00Z', gate0: 6, gate: (g) => (g === 6 ? FAILQ(6) : SWRF()) });
    const b = epochOf('2026-10-05T22:26:00Z');
    c.thirdPartyGate(b, false);
    const mine = c.place(b, E79, SWRF());
    const r = await run(c, s, { now: '2026-10-05T22:31:00Z' });
    const credited = r.actions.filter((a) => a.txHash === mine.hash).map((a) => a.id);
    assert.equal(credited.length, 1, `the cranker's one message was credited to ${JSON.stringify(credited)}`);
    const r2 = await run(c.at('2026-10-05T22:46:00Z'), s, { now: '2026-10-05T22:46:00Z' });
    assert.ok(r2.actions.every((a) => a.decision !== 'sent'), `a step was sent twice: ${explain(r2)}`);
  });
});

// =============================================================================================
describe('QA2: historical gate state unavailable', () => {
  it('eth_getStorageAt at block-1 fails (pruned): held, not guessed; alert; exit 1', async () => {
    const c = new QChain({ at: '2026-10-05T22:31:00Z', gate0: 7, gate: () => SWRF() });
    c.place('2026-10-05T22:26:00Z', E80, SWRF());
    c.historicalGateThrows = true;
    const r = await run(c, schedule(E80), { now: '2026-10-05T22:31:00Z' });
    assert.ok(decisions(r).every(([, d]) => d === 'held' || d === 'already-sent'), explain(r));
    assert.equal(c.sends.length, 0);
    assert.equal(r.exitCode, 1);
    assert.match(r.alerts.alerts[0].body, /could not tell which quarter/);
    // A second entry whose quarter is unknown is held too, not sent on a guess.
    const r2 = await run(c, schedule(E79, E80), { now: '2026-10-05T22:31:00Z' });
    assert.equal(c.sends.length, 0, explain(r2));
  });

  it('...and a landed check (event in its receipt) needs no historical read: it is credited normally', async () => {
    const c = new QChain({ at: '2026-10-05T22:20:00Z', gate0: 5 });
    const t = c.place('2026-10-05T22:16:00Z', E78, PASS(5));
    c.historicalGateThrows = true;
    const r = await run(c, schedule(E78), { now: '2026-10-05T22:20:00Z' });
    assert.deepEqual(decisions(r), [['78', 'already-sent']]);
    assert.equal(r.actions[0].txHash, t.hash);
  });
});

// =============================================================================================
describe('QA2: gateQuarter null mixed with labelled entries (same calldata)', () => {
  const A = entry({ id: 'A', gateQuarter: null, notBefore: '2026-10-05T22:15:00Z', notAfter: '2026-10-05T22:30:00Z', expect: 'pass' });
  const B = entry({ id: 'B', gateQuarter: 6, notBefore: '2026-10-05T22:20:00Z', notAfter: '2026-10-05T23:05:00Z', expect: 'fail' });

  it('null entry A never sent (too late), labelled B sent: next run reports A missed and credits B with its own tx', async () => {
    const s = schedule(A, B);
    const c = new QChain({ at: '2026-10-05T22:29:00Z', gate0: 6 });
    const r1 = await run(c, s, { now: '2026-10-05T22:29:10Z' });
    assert.deepEqual(decisions(r1), [['A', 'too-late'], ['B', 'sent']]);
    const r2 = await run(c.at('2026-10-05T22:31:00Z'), s, { now: '2026-10-05T22:31:00Z' });
    assert.deepEqual(decisions(r2), [['A', 'missed'], ['B', 'already-sent']],
      `A (never sent) took B's transaction: ${explain(r2)}; alerts ${JSON.stringify(r2.alerts.alerts.map((a) => a.title))}`);
  });

  it('...both null (hand-edited schedule): B is not sent twice', async () => {
    const s = schedule(A, { ...B, gateQuarter: null });
    const c = new QChain({ at: '2026-10-05T22:29:00Z', gate0: 6 });
    await run(c, s, { now: '2026-10-05T22:29:10Z' });
    assert.equal(c.sends.length, 1);
    const r2 = await run(c.at('2026-10-05T22:31:00Z'), s, { now: '2026-10-05T22:31:00Z' });
    assert.equal(c.sends.length, 1, `B was broadcast twice: ${explain(r2)}`);
  });

  it('null entry first, labelled one after it, both sent in one real run; next run credits each its own tx', async () => {
    const s = schedule({ ...A, notAfter: '2026-10-05T23:00:00Z' }, B);
    const c = new QChain({ at: '2026-10-05T22:21:00Z', gate0: 5 });
    const r1 = await run(c, s, { now: '2026-10-05T22:21:00Z' });
    assert.deepEqual(decisions(r1), [['A', 'sent'], ['B', 'sent']]);
    const r2 = await run(c.at('2026-10-05T22:36:00Z'), s, { now: '2026-10-05T22:36:00Z' });
    assert.deepEqual(r2.actions.map((a) => [a.id, a.decision, a.txHash]), [['A', 'already-sent', c.sends[0].hash], ['B', 'already-sent', c.sends[1].hash]]);
  });

  it('a dry run pictures what that real run would do (A then B), instead of blocking B', async () => {
    const s = schedule({ ...A, notAfter: '2026-10-05T23:00:00Z' }, B);
    const real = await run(new QChain({ at: '2026-10-05T22:21:00Z', gate0: 5 }), s, { now: '2026-10-05T22:21:00Z' });
    const dry = await run(new QChain({ at: '2026-10-05T22:21:00Z', gate0: 5 }), s, { now: '2026-10-05T22:21:00Z', dryRun: true, cranker: null });
    assert.deepEqual(real.actions.map((a) => a.decision), ['sent', 'sent']);
    assert.deepEqual(dry.actions.map((a) => a.decision), ['dry-run', 'dry-run'], `dry run said ${explain(dry)}`);
  });
});

// =============================================================================================
describe('QA2: submitShares(3) twice, overlapping windows (steps 30.1 pass, 31 revert)', () => {
  it('normal night: 30.1 at 19:05, 31 at 19:20; later runs credit each with its own tx', async () => {
    const s = schedule(E30, E31);
    const c = new QChain({ at: '2026-10-06T19:05:00Z' });
    const r1 = await run(c, s, { now: '2026-10-06T19:05:00Z' });
    assert.deepEqual(decisions(r1), [['30.1', 'sent']]);
    const r2 = await run(c.at('2026-10-06T19:20:00Z'), s, { now: '2026-10-06T19:20:00Z' });
    assert.deepEqual(decisions(r2), [['30.1', 'already-sent'], ['31', 'sent']]);
    assert.equal(r2.actions[1].match, true, r2.actions[1].result);
    for (const t of ['2026-10-06T19:35:00Z', '2026-10-06T19:50:00Z']) {
      const r = await run(c.at(t), s, { now: t });
      assert.ok(r.actions.every((a) => a.decision === 'already-sent' || a.decision === 'missed'), explain(r));
    }
    assert.equal(c.sends.length, 2);
  });

  it('30.1 sent by the cranker at 19:05, then marked Complete in the runbook; 31 sent 19:20: the 19:35 run does not send 31 again', async () => {
    const s = schedule({ ...E30, status: 'Complete' }, E31);
    const c = new QChain({ at: '2026-10-06T19:20:00Z' });
    c.place('2026-10-06T19:05:00Z', E30, LANDED); // the cranker's own 30.1, before 31's window opened
    const r1 = await run(c, s, { now: '2026-10-06T19:20:00Z' });
    assert.deepEqual(decisions(r1), [['31', 'sent']]);
    assert.equal(r1.actions[0].match, true);
    const r2 = await run(c.at('2026-10-06T19:35:00Z'), s, { now: '2026-10-06T19:35:00Z' });
    assert.equal(c.sends.length, 1, `step 31 was broadcast twice; run 2: ${explain(r2)}`);
  });

  it('30.1 still Pending but past its report window, 31 open longer: 31 is not sent again', async () => {
    const E31long = { ...E31, notAfter: '2026-10-06T21:00:00Z' };
    const s = schedule(E30, E31long);
    const c = new QChain({ at: '2026-10-06T19:05:00Z' });
    await run(c, s, { now: '2026-10-06T19:05:00Z' });
    await run(c.at('2026-10-06T19:20:00Z'), s, { now: '2026-10-06T19:20:00Z' });
    assert.equal(c.sends.length, 2);
    const r3 = await run(c.at('2026-10-06T20:05:00Z'), s, { now: '2026-10-06T20:05:00Z' });
    assert.equal(c.sends.length, 2, `step 31 was broadcast twice; run 3: ${explain(r3)}`);
  });

  it('30.1 done by someone else (Complete, not the cranker\'s key); cranker sends 31 at 19:20: 31 is not sent again', async () => {
    const s = schedule({ ...E30, status: 'Complete' }, E31);
    const c = new QChain({ at: '2026-10-06T19:20:00Z' });
    c.sraBase = 3; // a person submitted Q3 from another wallet
    const r1 = await run(c, s, { now: '2026-10-06T19:20:00Z' });
    assert.deepEqual(decisions(r1), [['31', 'sent']]);
    const r2 = await run(c.at('2026-10-06T19:35:00Z'), s, { now: '2026-10-06T19:35:00Z' });
    assert.equal(c.sends.length, 1, `step 31 was broadcast twice; run 2: ${explain(r2)}`);
  });

  it('first run at 19:44:10: 30.1 too late, 31 sent; the 19:46 run reports 30.1 missed and does not send 31 again', async () => {
    const s = schedule(E30, E31);
    const c = new QChain({ at: '2026-10-06T19:44:00Z' });
    const r1 = await run(c, s, { now: '2026-10-06T19:44:10Z' });
    assert.deepEqual(decisions(r1), [['30.1', 'too-late'], ['31', 'sent']]);
    const r2 = await run(c.at('2026-10-06T19:46:00Z'), s, { now: '2026-10-06T19:46:00Z' });
    assert.equal(c.sends.length, 1, `step 31 was broadcast twice; run 2: ${explain(r2)}`);
    assert.deepEqual(decisions(r2), [['30.1', 'missed'], ['31', 'already-sent']], explain(r2));
  });
});

// =============================================================================================
describe('QA2: head moves between reads; runner clock vs chain clock ±2 min', () => {
  it('head read as N, then a cranker message (force_call) lands in N+1 before the nonce reads: held, then already-sent', async () => {
    const e = { ...E80, gateQuarter: 7 };
    const c = new QChain({ at: '2026-10-05T22:30:00Z', gate0: 7, gate: () => SWRF() });
    c.afterHead = (chain) => {
      chain.place(chain.headNumber + 1, e, SWRF());
      chain.headNumber += 1;
    };
    const r1 = await run(c, schedule(e), { now: '2026-10-05T22:30:00Z' });
    assert.deepEqual(decisions(r1), [['80', 'held']]);
    assert.equal(c.sends.length, 0);
    const r2 = await run(c.at('2026-10-05T22:36:00Z'), schedule(e), { now: '2026-10-05T22:36:00Z' });
    assert.deepEqual(decisions(r2), [['80', 'already-sent']]);
    assert.equal(c.sends.length, 0);
  });

  it('runner 2 min ahead of the chain: waits until the head reaches notBefore, then sends once', async () => {
    const c = new QChain({ at: '2026-10-05T22:24:00Z', gate0: 7, gate: () => SWRF() });
    const r1 = await run(c, schedule(E80), { now: '2026-10-05T22:26:00Z' });
    assert.deepEqual(decisions(r1), [['80', 'waiting']]);
    assert.equal(c.sends.length, 0);
    const r2 = await run(c.at('2026-10-05T22:25:00Z'), schedule(E80), { now: '2026-10-05T22:27:00Z' });
    assert.deepEqual(decisions(r2), [['80', 'sent']]);
    assert.ok(c.ts(c.sends[0].blockNumber) * 1000 >= ms(E80.notBefore));
  });

  it('runner 2 min behind the chain: nothing until the runner reaches notBefore', async () => {
    const c = new QChain({ at: '2026-10-05T22:26:00Z', gate0: 7, gate: () => SWRF() });
    const r1 = await run(c, schedule(E80), { now: '2026-10-05T22:24:00Z' });
    assert.deepEqual(r1.actions, []);
    assert.equal(c.estimates.length + c.sends.length, 0);
    const r2 = await run(c.at('2026-10-05T22:27:00Z'), schedule(E80), { now: '2026-10-05T22:25:00Z' });
    assert.deepEqual(decisions(r2), [['80', 'sent']]);
  });

  it('runner 2 min ahead near notAfter: not started inside the last minute by the runner clock', async () => {
    const c = new QChain({ at: '2026-10-05T23:07:30Z', gate0: 7, gate: () => SWRF() });
    const r = await run(c, schedule(E80), { now: '2026-10-05T23:09:30Z' });
    assert.deepEqual(decisions(r), [['80', 'too-late']]);
    assert.equal(c.sends.length, 0);
  });

  it('runner 2 min behind the chain, a receipt wait in between: the pre-send re-check uses the chain clock too', async () => {
    // Head 19:30:00, runner 19:28:00. B closes 19:31:45: open by both clocks at the start of the run.
    // A's send and receipt wait take two epochs (60 s) on both clocks. By the chain, B now starts
    // 45 s before notAfter -- inside the 60 s margin -- so it must not be sent.
    const A = entry({ id: 'A', function: 'submitShares', args: [8], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T21:00:00Z' });
    const B = entry({ id: 'B', notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T19:31:45Z' });
    const c = new QChain({ at: '2026-10-06T19:30:00Z', gate0: 8, gate: (g) => PASS(g) });
    c.waitBlocks = 1;
    const nowMs = ms('2026-10-06T19:28:00Z');
    const startHead = c.headNumber;
    const clock = () => nowMs + (c.headNumber - startHead) * 30_000;
    const r = await run(c, schedule(A, B), { now: nowMs, clock });
    const sentB = c.sends.find((t) => t.to === TARGETS.swa);
    const chainAtSendB = sentB ? new Date((c.ts(sentB.blockNumber - 1)) * 1000).toISOString() : null;
    assert.equal(sentB, undefined,
      `B was started with the chain head at ${chainAtSendB}, ${sentB ? (ms(B.notAfter) - c.ts(sentB.blockNumber - 1) * 1000) / 1000 : '?'} s before notAfter; decisions ${explain(r)}`);
  });
});

// =============================================================================================
describe('QA2: pending vs latest nonce', () => {
  it('pending above latest (a message stuck in the mpool): every step held; alerted exactly once over 15-minute runs', async () => {
    const e = entry({ id: '80' });
    const c = new QChain({ at: '2026-10-05T22:26:00Z', gate0: 7, gate: (g) => PASS(g) });
    c.pendingDelta = 1;
    const runs = [];
    for (const t of ['2026-10-05T22:26:00Z', '2026-10-05T22:41:00Z', '2026-10-05T22:56:00Z', '2026-10-05T23:11:00Z']) runs.push(await run(c.at(t), schedule(e), { now: t }));
    assert.deepEqual(runs.map((r) => r.actions[0].decision), ['held', 'held', 'held', 'held']);
    assert.deepEqual(runs.map((r) => r.alerts.alerts.length), [0, 1, 0, 0]);
    assert.deepEqual(runs.map((r) => r.exitCode), [0, 1, 0, 0]);
    assert.equal(c.sends.length, 0);
  });

  it('pending BELOW latest (a lagging node answers pending from the parent state), cranker message in the head block: not sent again', async () => {
    const c = new QChain({ at: '2026-10-05T22:30:00Z', gate0: 7, gate: () => SWRF() });
    const t = c.place(c.headNumber, E80, SWRF()); // a force_call that landed in the head block
    c.pendingDelta = -1;
    const r = await run(c, schedule(E80), { now: '2026-10-05T22:30:10Z' });
    assert.equal(c.sends.length, 0, `step 80 was broadcast again although ${t.hash.slice(-4)} sits in the head block; ${explain(r)}`);
  });

  it('...same lagging node, cranker\'s own run sent it one block ago and is re-triggered at once: not sent again', async () => {
    const c = new QChain({ at: '2026-10-05T22:30:00Z', gate0: 7, gate: () => SWRF() });
    await run(c, schedule(E80), { now: '2026-10-05T22:30:00Z' });
    assert.equal(c.sends.length, 1);
    c.pendingDelta = -1;
    const r = await run(c, schedule(E80), { now: '2026-10-05T22:30:40Z' });
    assert.equal(c.sends.length, 1, `step 80 was broadcast twice; ${explain(r)}`);
  });

  it('pending below latest with no recent message: sends normally (not stuck)', async () => {
    const c = new QChain({ at: '2026-10-05T22:26:00Z', gate0: 7, gate: () => SWRF() });
    c.place('2026-10-05T20:00:00Z', entry({ id: 'x', function: 'submitShares', args: [2] }), LANDED);
    c.pendingDelta = -1;
    const r = await run(c, schedule(E80), { now: '2026-10-05T22:26:00Z' });
    assert.deepEqual(decisions(r), [['80', 'sent']]);
  });
});

// =============================================================================================
describe('QA2: mismatches and alerts', () => {
  // Revised in QA round 2. The sending run now polls for a dropped receipt, so the outcome is
  // usually read there. When it cannot be, that run alerts "outcome unknown" (exit 1) and asks a
  // person to check the tx; later runs record the outcome without paging again, and their job
  // summary does not call the run "Healthy" while a mismatch is on the record.
  it('receipt unknown on the sending run: that run alerts; the next run records the mismatch and does not say Healthy', async () => {
    const e = entry({ id: '93.1', function: 'submitShares', args: [8], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T19:45:00Z' });
    const c = new QChain({ at: '2026-10-06T19:01:00Z', sra: (q) => ({ status: 0, revert: revertWith('NotBound', [q]) }) });
    c.failWait = true;
    const realReceipt = c.receiptOf.bind(c);
    c.receiptOf = async () => null; // the node will not hand the receipt back during this run
    const r1 = await run(c, schedule(e), { now: '2026-10-06T19:01:00Z' });
    assert.equal(r1.actions[0].result, 'receipt unknown');
    assert.equal(r1.exitCode, 1);
    assert.match(r1.alerts.alerts[0].title, /outcome unknown/);
    c.failWait = false;
    c.receiptOf = realReceipt;
    const r2 = await run(c.at('2026-10-06T19:06:00Z'), schedule(e), { now: '2026-10-06T19:06:00Z' });
    assert.equal(r2.actions[0].decision, 'already-sent');
    assert.equal(r2.actions[0].match, false);
    assert.equal(c.sends.length, 1);
    const summary = summariseRehearsal({ ...r2, network: 'calibnet', balanceFil: '1', paused: false, dryRun: false }, null);
    assert.doesNotMatch(summary, /Healthy/);
    assert.match(summary, /did not match the plan/);
  });
});

// =============================================================================================
describe('QA2: invariant over every engine run above', () => {
  it('exit 1 <=> at least one alert; dry runs never alert and never exit 1', () => {
    assert.ok(ALL_RUNS.length > 30, `only ${ALL_RUNS.length} runs recorded`);
    const bad = ALL_RUNS
      .map((r, i) => ({ i, dry: r.dryRun, exit: r.exitCode, alerts: r.alerts.alerts.length, needs: r.needsPerson }))
      .filter((x) => (x.dry ? x.alerts !== 0 || x.exit !== 0 : (x.exit === 1) !== (x.alerts > 0)));
    assert.deepEqual(bad, []);
  });
});

// =============================================================================================
// Scripts: rehearsal-plan labels, build --check
// =============================================================================================
const TMP = mkdtempSync(join(tmpdir(), 'qa2-rehearsal-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** Runs a script with Date.now() pinned (a preload module), with no inherited secrets or RPC. */
function script(name, args, { fixedNow = null, env = {} } = {}) {
  const pre = join(TMP, 'fixed-now.mjs');
  writeFileSync(pre, 'const t = Number(process.env.QA2_FIXED_NOW); if (t) { Date.now = () => t; }\n');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(pre).href, join(ROOT, 'scripts', name), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH, QA2_FIXED_NOW: fixedNow ? String(fixedNow) : '', ...env },
  });
  return r;
}

describe('QA2: rehearsal-plan labels across past / now / future', () => {
  const NOW = ms('2026-10-05T22:30:00Z');
  const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
  const M = 60_000;
  const file = join(TMP, 'plan-schedule.json');
  writeFileSync(file, JSON.stringify({ chainId: 314159, entries: [
    entry({ id: 'past', notBefore: iso(NOW - 120 * M), notAfter: iso(NOW - 60 * M) }),
    entry({ id: 'open', notBefore: iso(NOW - 10 * M), notAfter: iso(NOW + 30 * M) }),
    entry({ id: 'edge', notBefore: iso(NOW - 10 * M), notAfter: iso(NOW + 30_000) }),
    entry({ id: 'future', notBefore: iso(NOW + 60 * M), notAfter: iso(NOW + 120 * M), gateQuarter: 9 }),
    entry({ id: 'done', notBefore: iso(NOW - 10 * M), notAfter: iso(NOW + 30 * M), status: 'Complete' }),
    entry({ id: 'beyond', notBefore: iso(NOW + 30 * 60 * M), notAfter: iso(NOW + 31 * 60 * M) }),
    entry({ id: 'before', notBefore: iso(NOW - 10 * 60 * M), notAfter: iso(NOW - 9 * 60 * M) }),
  ] }));
  const deployments = join(TMP, 'deployments.json');
  writeFileSync(deployments, JSON.stringify({ 314159: { sra: TARGETS.sra, swa: TARGETS.swa } }));
  const plan = (extra = []) => script('rehearsal-plan.mjs', ['--schedule', file, '--from', iso(NOW - 3 * 60 * M), '--to', iso(NOW + 24 * 60 * M), ...extra], { fixedNow: NOW, env: { SOLSTICE_DEPLOYMENTS: deployments } });

  it('--json: CLOSED / OPEN NOW / WOULD SEND / skip, range respected, addresses from the deployments file', () => {
    const r = plan(['--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const by = Object.fromEntries(out.rows.map((x) => [x.step, x]));
    assert.deepEqual(Object.keys(by).sort(), ['done', 'edge', 'future', 'open', 'past'].sort());
    assert.equal(by.past.decision, 'CLOSED');
    assert.equal(by.open.decision, 'OPEN NOW');
    assert.equal(by.future.decision, 'WOULD SEND');
    assert.match(by.done.decision, /^skip/);
    assert.equal(by.open.to, TARGETS.swa);
    assert.equal(by.future.condition, 'SWA next quarter = Q9');
    assert.equal(out.contracts.source, deployments);
  });

  it('text output: one line per step, nothing sent, no key needed', () => {
    const r = plan(['--offline']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Rehearsal dry run -- nothing is sent/);
    for (const [id, label] of [['past', 'CLOSED'], ['open', 'OPEN NOW'], ['future', 'WOULD SEND']]) {
      assert.match(r.stdout, new RegExp(`step ${id}\\s+${label}`));
    }
    assert.doesNotMatch(r.stdout, /step beyond|step before/);
  });

  it('a step with 30 s left is not labelled OPEN NOW ("the next run sends it"): the engine will not start it', () => {
    const r = plan(['--json']);
    const edge = JSON.parse(r.stdout).rows.find((x) => x.step === 'edge');
    assert.notEqual(edge.decision, 'OPEN NOW', 'the plan promises a send the engine refuses (inside SEND_MARGIN_MS of notAfter)');
  });

  it('bad ranges are refused', () => {
    for (const args of [['--hours', '0'], ['--hours', 'abc'], ['--from', 'yesterday'], ['--from', iso(NOW), '--to', iso(NOW - M)], ['--bogus']]) {
      const r = script('rehearsal-plan.mjs', ['--schedule', file, '--offline', ...args], { fixedNow: NOW });
      assert.equal(r.status, 1, `${args.join(' ')} -> ${r.status} ${r.stdout}`);
    }
  });
});

describe('QA2: build-rehearsal-schedule --check', () => {
  const FIXTURE = join(ROOT, 'test', 'fixtures', 'runbook-cranker-rows.csv');
  const build = (args) => script('build-rehearsal-schedule.mjs', args);

  it('a missing output file is stale: exit 1, and --check creates nothing', () => {
    const out = join(TMP, 'missing.json');
    const r = build(['--csv', FIXTURE, '--out', out, '--check']);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(existsSync(out), false);
  });

  it('--check never rewrites a stale file', () => {
    const out = join(TMP, 'stale.json');
    writeFileSync(out, '{"hand":"edited"}\n');
    const r = build(['--csv', FIXTURE, '--out', out, '--check']);
    assert.equal(r.status, 1);
    assert.equal(readFileSync(out, 'utf8'), '{"hand":"edited"}\n');
  });

  it('a different --grace-minutes makes a fresh file stale; the same one passes', () => {
    const out = join(TMP, 'grace.json');
    assert.equal(build(['--csv', FIXTURE, '--out', out]).status, 0);
    assert.equal(build(['--csv', FIXTURE, '--out', out, '--check']).status, 0);
    assert.equal(build(['--csv', FIXTURE, '--out', out, '--check', '--grace-minutes', '45']).status, 1);
  });

  it('refuses bad input before writing: no CSV and no sheet id, missing CSV, negative grace', () => {
    const out = join(TMP, 'never.json');
    for (const args of [['--out', out], ['--csv', join(TMP, 'nope.csv'), '--out', out], ['--csv', FIXTURE, '--out', out, '--grace-minutes', '-5']]) {
      const r = build(args);
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(existsSync(out), false);
    }
  });
});
