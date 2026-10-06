/**
 * QA round 3: adversarial tests for rehearsal mode (src/rehearsal/*), written by an independent
 * reviewer against commit e9e6fc2. Unit level; nothing here opens a socket.
 *
 * NightNet is a new double: a JSON-RPC provider + wallet in the exact shape the REAL ethersChain()
 * adapter uses (getBlock, getTransactionCount, getTransactionReceipt, getStorage, estimateGas, call,
 * send), backed by a small model of the SWA/SRA that follows the runbook's plan for steps 77-117:
 * quarters bind at 19:00 daily from Mon (Q7), a passing gate check queues a write held for 6 h
 * (another pass inside the hold reverts StepWeightRecordsFailed), Q6 lands failed, the 8th step
 * makes the next check revert StepsComplete(). It mines a block per send, keeps an mpool (so a
 * crashed run's message can sit pending), and counts every RPC call.
 *
 * Every assertion states the behaviour the spec asks for. A failing test is a finding.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, Interface } from 'ethers';

import swaAbi from '../abi/StreamWeightActor.json' with { type: 'json' };
import sraAbi from '../abi/ServiceRewardsActor.json' with { type: 'json' };
import { STORAGE_SLOTS } from '../src/config.mjs';
import { calldataFor, ethersChain, runRehearsal, stepTag } from '../src/rehearsal/engine.mjs';
import { buildScheduleFromCsv, loadSchedule, parseActionCalls, parseRunbookTime, validateSchedule } from '../src/rehearsal/schedule.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SWA = new Interface(swaAbi);
const SRA = new Interface(sraAbi);
const TARGETS = { sra: getAddress('0x00000000000000000000000000000000000000aa'), swa: getAddress('0x00000000000000000000000000000000000000bb') };
const CRANKER = getAddress('0x170356558bd57623d3df9877319014ec9de6e263');
const OTHER = getAddress('0x00000000000000000000000000000000000000cc');
const GENESIS = Date.parse('2026-10-05T00:00:00Z') / 1000;
const ms = (iso) => (typeof iso === 'number' ? iso : Date.parse(iso));
const epochOf = (t) => Math.floor((ms(t) / 1000 - GENESIS) / 30);
const tsOf = (n) => GENESIS + n * 30;
const isoOf = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
const MIN = 60_000;
const NOPAUSE = { paused: false, reason: null };

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

const entry = (over) => ({
  id: '1', step: 1, function: 'quarterlyGateCheck', args: [], gateQuarter: null,
  notBefore: '2026-10-05T22:25:00Z', notAfter: '2026-10-06T00:40:00Z', expect: 'pass', status: 'Pending', ...over,
});
const schedule = (...entries) => validateSchedule({ chainId: 314159, entries });
const one = (e) => schedule(e).entries[0];
const decisions = (r) => r.actions.map((a) => [a.id, a.decision]);
const explain = (r) => JSON.stringify(r.actions.map((a) => [a.id, a.decision, a.txHash?.slice(-4) ?? null, a.result, a.match]));

class Crash extends Error {}

function harness({ crashOn = null } = {}) {
  const alerts = { alerts: [], raise(a) { this.alerts.push(a); return a; } };
  const lines = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((l) => [l, (m) => {
    lines.push(`${l} ${m}`);
    // The process dies right after a broadcast: before the receipt wait, before the record.
    if (crashOn && new RegExp(`^rehearsal step=${crashOn.replace('.', '\\.')} broadcast `).test(m)) throw new Crash(`killed after broadcasting ${crashOn}`);
  }]));
  return { alerts, lines, log };
}

/** Every engine run in this file, for the alert/exit invariant at the end. */
const ALL_RUNS = [];

// =============================================================================================
// NightNet: the provider + wallet under the real ethersChain()
// =============================================================================================
const SLOT = BigInt(STORAGE_SLOTS.swaGateParams.slot);
const GATE_DATA = SWA.encodeFunctionData('quarterlyGateCheck', []).toLowerCase();
const BIND_Q7 = ms('2026-10-05T19:00:00Z');
const HOLD_MS = 6 * 3600_000;

/** The contracts as the runbook plans them. */
function planModel({ failQuarters = [6] } = {}) {
  const fails = new Set(failQuarters);
  const bound = (q, t) => q <= 6 || t >= BIND_Q7 + (q - 7) * 86_400_000;
  return function evaluate(req, s, t) {
    const to = String(req.to).toLowerCase();
    const data = String(req.data).toLowerCase();
    const rev = (name, args) => ({ result: { status: 0, revert: revertWith(name, args) }, next: s });
    if (to === TARGETS.swa.toLowerCase() && data === GATE_DATA) {
      const q = s.gateNext;
      if (s.steps >= 8) return rev('StepsComplete');
      if (!bound(q, t)) return rev('NotBound', [q]);
      if (fails.has(q)) return { result: { status: 1, gate: { quarter: q, passed: false, steps: s.steps } }, next: { ...s, gateNext: q + 1 } };
      if (t < s.holdUntil) return rev('StepWeightRecordsFailed', [16]);
      const steps = s.steps + 1;
      return { result: { status: 1, gate: { quarter: q, passed: true, steps } }, next: { ...s, gateNext: q + 1, steps, holdUntil: t + HOLD_MS } };
    }
    if (to === TARGETS.sra.toLowerCase()) {
      const q = Number(SRA.decodeFunctionData('submitShares', data)[0]);
      if (!bound(q, t)) return rev('NotBound', [q]);
      if (q <= s.lastSubmitted) return rev('AlreadySubmitted', [q]);
      return { result: { status: 1 }, next: { ...s, lastSubmitted: q } };
    }
    return { result: { status: 0, revert: null }, next: s };
  };
}

const nullErr = () => {
  const error = { code: 1, message: 'requested epoch was a null round' };
  return Object.assign(new Error(`could not coalesce error (error=${JSON.stringify(error)})`), { code: 'UNKNOWN_ERROR', shortMessage: 'could not coalesce error', info: { error } });
};

class NightNet {
  constructor({ start, initial = { gateNext: 5, steps: 3, holdUntil: 0, lastSubmitted: 6 }, model = planModel(), nulls = [] }) {
    this.head = epochOf(start);
    this.initial = initial;
    this.model = model;
    this.nulls = new Set(nulls);
    this.mined = []; // {tx, block, result, after}, in (block, position) order
    this.mempool = []; // {tx, mineAt: ms | null}
    this.nonce = 0;
    this.counter = 0;
    this.calls = new Map();
    this.total = 0;
    this.sent = []; // the engine's broadcasts: {tx, runNow, clockAtSend}
    this.clockNow = 0;
    this.runNow = 0;
    this.holdNextSendUntil = null; // the next broadcast stays in the mpool until this time
    this.receiptNull = new Set();
    const net = this;
    const c = (m) => {
      net.calls.set(m, (net.calls.get(m) ?? 0) + 1);
      net.total++;
    };
    this.provider = {
      async getBlock(tag, prefetch = false) {
        c(prefetch ? 'getBlock(full)' : 'getBlock');
        const n = tag === 'latest' ? net.head : Number(tag);
        if (n > net.head) return null;
        if (net.nulls.has(n)) throw nullErr();
        const txs = net.mined.filter((m) => m.block === n).map((m) => ({ ...m.tx }));
        // Somebody else's message in most blocks, to make sure the scan filters by sender.
        if (n % 3 === 0) txs.unshift({ hash: `0x${'e'.repeat(56)}${n.toString(16).padStart(8, '0')}`, to: TARGETS.swa, data: GATE_DATA, nonce: n, gasLimit: 100_000_000n, from: OTHER });
        return { number: n, timestamp: tsOf(n), prefetchedTransactions: prefetch ? txs : undefined };
      },
      async getTransactionCount(addr, tag) {
        c('getTransactionCount');
        assert.equal(addr, CRANKER);
        if (tag === 'pending') return net.mined.length + net.mempool.length;
        const b = tag === 'latest' ? net.head : Number(tag);
        if (net.nulls.has(b)) throw nullErr();
        return net.mined.filter((m) => m.block <= b).length;
      },
      async getTransactionReceipt(hash) {
        c('getTransactionReceipt');
        if (net.receiptNull.has(hash)) return null;
        const m = net.mined.find((x) => x.tx.hash === hash && x.block <= net.head);
        return m ? net.receipt(m) : null;
      },
      async getStorage(addr, key, tag) {
        c('getStorage');
        const b = tag === 'latest' ? net.head : Number(tag);
        if (net.nulls.has(b)) throw nullErr();
        const s = net.stateAfter(b);
        const i = BigInt(key) - SLOT;
        const v = addr.toLowerCase() !== TARGETS.swa.toLowerCase() ? 0 : i === 0n ? s.gateNext - 1 : i === 3n ? s.steps : 0;
        return '0x' + BigInt(v).toString(16).padStart(64, '0');
      },
      async estimateGas(req) {
        c('estimateGas');
        const { result } = net.model(req, net.stateAfter(net.head), tsOf(net.head + 1) * 1000);
        if (result.status === 0) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: result.revert });
        return 30_000_000n;
      },
      async call(req) {
        c('call');
        const b = Number(req.blockTag);
        const { result } = net.model(req, net.stateAfter(b), tsOf(b + 1) * 1000);
        if (result.status === 0) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: result.revert });
        return '0x';
      },
      async send(method) {
        c(method);
        throw new Error(`the method ${method} does not exist/is not available`);
      },
      async getBalance() {
        c('getBalance');
        return 50n * 10n ** 18n;
      },
    };
    this.wallet = {
      async sendTransaction(req) {
        c('sendRawTransaction');
        const tx = { hash: net.hash(), to: req.to, data: req.data, gasLimit: BigInt(req.gasLimit), nonce: net.nonce++, from: CRANKER };
        net.mempool.push({ tx, mineAt: net.holdNextSendUntil });
        net.holdNextSendUntil = null;
        net.sent.push({ tx, runNow: net.runNow, clockAtSend: net.clockNow });
        return { hash: tx.hash, wait: async () => net.waitFor(tx) };
      },
    };
  }
  hash() {
    return `0x${(++this.counter).toString(16).padStart(64, '0')}`;
  }
  stateAfter(b) {
    let s = this.initial;
    for (const m of this.mined) {
      if (m.block > b) break;
      s = m.after;
    }
    return s;
  }
  receipt(m) {
    const logs = m.result.status === 1 && m.result.gate
      ? [{ address: TARGETS.swa, ...SWA.encodeEventLog('QuarterlyGateCheckResult', [m.result.gate.quarter, m.result.gate.passed, m.result.gate.steps]) }]
      : [];
    return { hash: m.tx.hash, status: m.result.status, blockNumber: m.block, gasUsed: 4_000_000n, logs };
  }
  mineOne(p, b) {
    const { result, next } = this.model(p.tx, this.stateAfter(b), tsOf(b) * 1000);
    const m = { tx: p.tx, block: b, result, after: next };
    this.mined.push(m);
    this.mempool.splice(this.mempool.indexOf(p), 1);
    return m;
  }
  /** Mines the mpool up to and including `tx`, in nonce order, into the next block. */
  waitFor(tx) {
    const b = this.head + 1;
    let mine = null;
    while (this.mempool.length) {
      const p = this.mempool[0];
      const m = this.mineOne(p, b);
      if (p.tx === tx) {
        mine = m;
        break;
      }
    }
    this.head = b;
    this.clockNow = Math.max(this.clockNow + 5_000, tsOf(b) * 1000 + 10_000);
    return this.receipt(mine);
  }
  /** Moves the head to the epoch of time t, mining whatever in the mpool is due. */
  advance(t) {
    const target = epochOf(t);
    while (this.head < target) {
      this.head += 1;
      while (this.mempool.length && this.mempool[0].mineAt !== null && this.mempool[0].mineAt <= tsOf(this.head) * 1000) {
        this.mineOne(this.mempool[0], this.head);
      }
    }
  }
  /** A message from the cranker's key that the engine did not send: force_call, production mode. */
  external(at, e, gasLimit = 100_000_000n) {
    const v = one(e);
    const tx = { hash: this.hash(), to: TARGETS[v.contract], data: calldataFor(v), gasLimit, nonce: this.nonce++, from: CRANKER };
    this.mempool.push({ tx, mineAt: ms(at) });
    return tx;
  }
}

// Revised after QA round 3: the report window now defaults to 30 minutes (twice the trigger).
async function netRun(net, sched, now, { crashOn = null, reportWindowMs = 30 * MIN, dryRun = false } = {}) {
  const nowMs = ms(now);
  net.runNow = nowMs;
  net.clockNow = nowMs;
  const h = harness({ crashOn });
  const chain = ethersChain({ provider: net.provider, wallet: net.wallet, address: CRANKER, epochSeconds: 30 });
  const before = net.total;
  const head = net.head;
  let r;
  try {
    // Revised after QA round 3: as in Actions, the week's runs share an alert ledger (the workflow
    // carries it in the cache), so each problem is alerted once. A dry run neither reads nor writes it.
    net.ledger ??= new Map();
    const alertState = dryRun ? null : { has: (k) => net.ledger.has(k), add: (k) => net.ledger.set(k, nowMs) };
    const result = await runRehearsal({
      schedule: sched, targets: TARGETS, chain, cranker: CRANKER, nowMs, clock: () => net.clockNow, dryRun, pause: NOPAUSE,
      gasLimit: 100_000_000n, reportWindowMs, confirmations: 1, alerts: h.alerts, log: h.log, receiptPollMs: 1, alertState,
    });
    r = { ...result, ...h, dryRun };
  } catch (err) {
    if (!(err instanceof Crash)) throw err;
    // scripts/crank.mjs: an uncaught error raises a critical "aborted" alert and exits 1.
    h.alerts.raise({ severity: 'critical', title: `Solstice cranker aborted on calibnet: ${err.message}` });
    r = { crashed: true, actions: [], exitCode: 1, needsPerson: ['aborted'], ...h, dryRun };
  }
  r.at = isoOf(nowMs);
  r.headAtStart = head;
  r.rpc = net.total - before;
  ALL_RUNS.push(r);
  return r;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REAL = loadSchedule(join(ROOT, 'config', 'rehearsal-schedule.json'));
const NIGHT_IDS = ['77', '78', '79', '80', '86', '93.1', '93.2', '99.1', '99.2', '105.1', '105.2', '116', '117'];
const byId = Object.fromEntries(REAL.entries.map((e) => [e.id, e]));
const idByTag = new Map(REAL.entries.map((e) => [String(stepTag(e.id)), e.id]));

/**
 * Mon 18:00 to Sat 00:00 UTC, a trigger every 15 minutes. Each run starts 20-120 s after its
 * trigger (now and then 3-8 minutes), and the chain head it reads lags its clock by 0-59 s.
 */
async function rehearsalWeek({ seed, model = planModel(), drop = [], forceCalls = [], crash = null, pin = {}, dryRun = false }) {
  const rand = rng(seed);
  const start = ms('2026-10-05T18:00:00Z');
  const end = ms('2026-10-10T00:00:00Z');
  const net = new NightNet({ start: start - 5 * MIN, model });
  const runs = [];
  let crashArmed = crash;
  for (let trigger = start; trigger <= end; trigger += 15 * MIN) {
    let delay = rand() < 0.05 ? 180_000 + rand() * 300_000 : 20_000 + rand() * 100_000;
    let lag = rand() * 59_000;
    if (drop.includes(isoOf(trigger))) continue;
    if (pin[isoOf(trigger)]) ({ delay, lag } = pin[isoOf(trigger)]);
    const now = Math.round(trigger + delay);
    for (const f of forceCalls) {
      if (!f.done && ms(f.at) < now) {
        net.advance(ms(f.at) - 30_000);
        f.tx = net.external(f.at, byId[f.id]);
        f.done = true;
      }
    }
    net.advance(now - lag);
    let crashOn = null;
    if (crashArmed) {
      crashOn = crashArmed.id;
      net.holdNextSendUntil = null;
    }
    // A crash leaves its message in the mpool for crash.pendingFor after the broadcast.
    if (crashOn) {
      const e = byId[crashOn];
      const opensForRun = e.notBeforeMs <= Math.min(now, tsOf(net.head) * 1000);
      if (opensForRun) net.holdNextSendUntil = now + crashArmed.pendingFor;
    }
    const r = await netRun(net, REAL, now, { crashOn, dryRun });
    if (r.crashed) crashArmed = null;
    net.holdNextSendUntil = null;
    runs.push(r);
  }
  return { net, runs };
}

function checkWeek({ net, runs }, { manual = {} } = {}) {
  const problems = [];
  // 1. Every send is a scheduled step, by its tag; each step 77-117 exactly once (or by hand).
  const sendsBy = new Map();
  for (const s of net.sent) {
    const id = idByTag.get(String(s.tx.gasLimit % 100_000n));
    if (!id) problems.push(`a broadcast with gas ${s.tx.gasLimit} names no scheduled step`);
    sendsBy.set(id, [...(sendsBy.get(id) ?? []), s]);
  }
  for (const id of NIGHT_IDS) {
    const n = (sendsBy.get(id) ?? []).length;
    const want = manual[id] ? 0 : 1;
    if (n !== want) problems.push(`step ${id} broadcast ${n} times by the engine (want ${want})`);
  }
  for (const [id] of sendsBy) if (!NIGHT_IDS.includes(id)) problems.push(`step ${id} (outside 77-117) was broadcast`);
  // 2. Never early, never inside the last minute, landed inside the window.
  for (const s of net.sent) {
    const e = byId[idByTag.get(String(s.tx.gasLimit % 100_000n))];
    if (!e) continue;
    const m = net.mined.find((x) => x.tx === s.tx);
    if (s.runNow < e.notBeforeMs) problems.push(`step ${e.id} decided by a run at ${isoOf(s.runNow)}, before ${e.notBefore}`);
    if (m && tsOf(m.block) * 1000 < e.notBeforeMs) problems.push(`step ${e.id} landed at ${isoOf(tsOf(m.block) * 1000)}, before ${e.notBefore}`);
    if (s.clockAtSend + 60_000 >= e.notAfterMs) problems.push(`step ${e.id} started ${(e.notAfterMs - s.clockAtSend) / 1000}s before notAfter`);
    if (m && tsOf(m.block) * 1000 >= e.notAfterMs) problems.push(`step ${e.id} landed after its window`);
  }
  // 3. Every outcome on the record matches the plan; nothing in 77-117 is missed.
  for (const r of runs) {
    for (const a of r.actions) {
      if (['sent', 'already-sent'].includes(a.decision) && a.match === false) problems.push(`${r.at}: step ${a.id} ${a.decision} with match NO (${a.result})`);
      if (a.decision === 'missed' && NIGHT_IDS.includes(a.id)) problems.push(`${r.at}: step ${a.id} missed`);
      if (a.decision === 'sent' && !NIGHT_IDS.includes(a.id)) problems.push(`${r.at}: step ${a.id} sent`);
    }
    // 4. exit 1 <=> an alert.
    if ((r.exitCode === 1) !== (r.alerts.alerts.length > 0)) problems.push(`${r.at}: exit ${r.exitCode} with ${r.alerts.alerts.length} alerts`);
  }
  return problems;
}

// =============================================================================================
describe('QA3: a simulated rehearsal week, steps 77-117 from config/rehearsal-schedule.json', () => {
  for (const seed of [1, 7, 42]) {
    it(`seed ${seed}: two dropped runs, a force_call of 86, a runner killed after broadcasting 99.1 -- every step exactly once, on time, alerts consistent`, async (t) => {
      const forceCalls = [{ id: '86', at: '2026-10-06T08:06:10Z' }];
      const week = await rehearsalWeek({
        seed,
        drop: ['2026-10-06T08:00:00Z', '2026-10-06T19:00:00Z'],
        forceCalls,
        crash: { id: '99.1', pendingFor: 20 * MIN },
        pin: { '2026-10-07T19:00:00Z': { delay: 30_000, lag: 0 } }, // the run that is killed sees 99.1 open
      });
      const { net, runs } = week;
      const problems = checkWeek(week, { manual: { 86: true } });
      assert.deepEqual(problems, []);

      // The person's force_call is what step 86 is credited with.
      const credited86 = runs.flatMap((r) => r.actions).filter((a) => a.id === '86' && a.decision === 'already-sent');
      assert.ok(credited86.length > 0 && credited86.every((a) => a.txHash === forceCalls[0].tx.hash && a.match === true), JSON.stringify(credited86));

      // Exactly the alerts this week should produce: the killed run. (Revised after QA round 3: a
      // message stuck for 20 minutes no longer trips the "stuck" alert, whose threshold is now one
      // 30-minute report window; 99.1 and 99.2 still go out once, on time, once it clears.)
      const alerts = runs.flatMap((r) => r.alerts.alerts.map((a) => `${r.at} ${a.title}`));
      assert.equal(alerts.length, 1, alerts.join('\n'));
      assert.match(alerts[0], /aborted/);

      // The last run of the week has nothing to do and nothing left to report.
      assert.deepEqual(runs.at(-1).actions, []);
      assert.equal(runs.at(-1).next, null);

      const waits = runs.flatMap((r) => r.actions.filter((a) => a.decision === 'waiting').map((a) => a.id));
      const rpc = runs.map((r) => r.rpc);
      t.diagnostic(`${runs.length} runs, ${net.sent.length} broadcasts, ${net.mined.length} cranker messages; ` +
        `steps deferred a run by head lag: ${[...new Set(waits)].join(',') || 'none'}; ` +
        `RPC calls per run: max ${Math.max(...rpc)}, mean ${(rpc.reduce((a, b) => a + b, 0) / rpc.length).toFixed(1)}, total ${net.total}`);
    });
  }

  it('the chain deviates at step 79 (Q6 needs a write, so it reverts inside 78\'s hold): the gate stalls at Q6; every later gate step is held, alerted blocked once and missed once, never sent; the submitShares steps still go once each', async (t) => {
    const week = await rehearsalWeek({ seed: 3, model: planModel({ failQuarters: [] }) });
    const { runs, net } = week;
    const sends = net.sent.map((s) => idByTag.get(String(s.tx.gasLimit % 100_000n)));
    assert.deepEqual(sends, ['77', '78', '79', '93.1', '99.1', '105.1', '116']);
    const titles = runs.flatMap((r) => r.alerts.alerts.map((a) => a.title));
    // With the alert ledger the run that sent 79 alerts its mismatch, and the next run, finding it
    // already sent, does not repeat it.
    assert.equal(titles.filter((x) => /step 79 did not do what the plan expected/.test(x)).length, 1);
    for (const id of ['80', '86', '93.2', '99.2', '105.2', '117']) {
      const q = id.replace('.', '\\.');
      assert.ok(titles.filter((x) => new RegExp(`step ${q} held: the gate`).test(x)).length <= 1, `${id}: ${JSON.stringify(titles)}`);
      assert.equal(titles.filter((x) => new RegExp(`step ${q} was not sent`).test(x)).length, 1, `${id}: ${JSON.stringify(titles)}`);
    }
    for (const r of runs) assert.equal(r.exitCode === 1, r.alerts.alerts.length > 0, r.at);
    t.diagnostic(`one deviation at 79 -> ${titles.length} alerts over the week: ${titles.map((x) => x.replace('Rehearsal step ', '')).join('; ')}`);
  });

  it('the whole week as a dry run (CRANK_DRY_RUN with the key): nothing broadcast, nothing alerted, every step shown (dry-run, or blocked once the unsent week leaves the gate behind)', async () => {
    const { net, runs } = await rehearsalWeek({ seed: 5, dryRun: true });
    assert.equal(net.sent.length, 0);
    assert.deepEqual(runs.filter((r) => r.alerts.alerts.length || r.exitCode).map((r) => r.at), []);
    const seen = new Set(runs.flatMap((r) => r.actions.filter((a) => a.decision === 'dry-run').map((a) => a.id)));
    // Nothing really moves the gate in a dry week, so from Tuesday every gate step is (correctly) blocked.
    const blocked = new Set(runs.flatMap((r) => r.actions.filter((a) => a.decision === 'blocked').map((a) => a.id)));
    assert.deepEqual(NIGHT_IDS.filter((id) => !seen.has(id) && !blocked.has(id)), [], 'a step was never shown');
    for (const id of ['86', '93.2', '99.2', '105.2', '117']) assert.ok(blocked.has(id) && !seen.has(id), id);
  });

  it('117 blocked, and the first run inside its window sees the chain head 30 s short of 19:15: the blocked gate is still alerted while the window is open', async () => {
    // Gate stuck at Q10 (105.2 hit StepsComplete). The 19:15 trigger's runner starts 19:15:40 and its
    // head is 19:14:30 ("waiting"); the 19:30 run sees "blocked"; the window closes at 20:00.
    const net = new NightNet({ start: '2026-10-09T19:00:00Z', initial: { gateNext: 10, steps: 8, holdUntil: 0, lastSubmitted: 11 } });
    const s = schedule(byId['117']);
    const runs = [];
    for (const [now, head] of [['2026-10-09T19:15:40Z', '2026-10-09T19:14:30Z'], ['2026-10-09T19:30:40Z', '2026-10-09T19:30:00Z'], ['2026-10-09T19:45:40Z', '2026-10-09T19:45:00Z']]) {
      net.advance(head);
      runs.push(await netRun(net, s, now));
    }
    assert.deepEqual(runs.map((r) => r.actions.map((a) => a.decision).join()), ['waiting', 'blocked', 'blocked']);
    const titles = runs.flatMap((r) => r.alerts.alerts.map((a) => a.title));
    assert.ok(titles.length > 0, `117 sat blocked from 19:30 to 20:00 and nobody was told until the window had closed (the "missed" alert); runs: ${runs.map(explain).join(' ')}`);
  });
});

// =============================================================================================
describe('QA3: a run killed between broadcast and receipt', () => {
  it('the killed run\'s message did NOT do what the plan expected: some later run must alert (exit 1)', async () => {
    // Step 80 expects StepWeightRecordsFailed. The hold has already ended, so the gate check passes.
    const e80 = byId['80'];
    const net = new NightNet({ start: '2026-10-05T22:26:00Z', initial: { gateNext: 7, steps: 5, holdUntil: 0, lastSubmitted: 7 } });
    net.advance('2026-10-05T22:26:00Z');
    net.holdNextSendUntil = ms('2026-10-05T22:27:00Z'); // the killed run's message lands a block later
    const r1 = await netRun(net, schedule(e80), '2026-10-05T22:26:30Z', { crashOn: '80' });
    assert.equal(r1.crashed, true);
    const later = [];
    for (const t of ['2026-10-05T22:41:00Z', '2026-10-05T22:56:00Z', '2026-10-05T23:11:00Z']) {
      net.advance(t);
      later.push(await netRun(net, schedule(e80), t));
    }
    assert.equal(net.sent.length, 1, 'step 80 was resent');
    assert.deepEqual(decisions(later[0]), [['80', 'already-sent']]);
    assert.equal(later[0].actions[0].match, false);
    const n = later.reduce((k, r) => k + r.alerts.alerts.length, 0);
    assert.ok(n >= 1, `the mismatch (expected ${e80.expect}, got "${later[0].actions[0].result}") was never alerted; ` +
      `the only alert was the abort, which says nothing about the step's outcome; exit codes ${later.map((r) => r.exitCode)}`);
  });

  it('the killed run\'s message never left the mpool (dropped): the next run sends it, once', async () => {
    const e = byId['77'];
    const net = new NightNet({ start: '2026-10-05T19:00:40Z' });
    net.advance('2026-10-05T19:00:40Z');
    net.holdNextSendUntil = Infinity;
    const r1 = await netRun(net, REAL, '2026-10-05T19:01:00Z', { crashOn: '77' });
    assert.equal(r1.crashed, true);
    net.advance('2026-10-05T19:16:00Z');
    const r2 = await netRun(net, REAL, '2026-10-05T19:16:00Z');
    assert.deepEqual(decisions(r2).filter(([id]) => id === '77'), [['77', 'held']], 'pending: held');
    net.mempool.length = 0; // the node dropped it; the key's nonce is free again
    net.nonce -= 1;
    net.advance('2026-10-05T19:31:00Z');
    const r3 = await netRun(net, REAL, '2026-10-05T19:31:00Z');
    assert.deepEqual(decisions(r3).filter(([id]) => id === e.id), [['77', 'sent']]);
    net.advance('2026-10-05T19:44:30Z');
    const r4 = await netRun(net, REAL, '2026-10-05T19:44:30Z');
    assert.deepEqual(decisions(r4).filter(([id]) => id === e.id), []);
    assert.equal(net.mined.length, 1);
  });

  it('the killed run\'s message is still stuck in the mpool when the window closes: the close is not reported "nothing sent -- send it by hand"', async () => {
    // A force_call now would queue behind the stuck message (next nonce) and both would land: a double send.
    const net = new NightNet({ start: '2026-10-05T19:00:40Z' });
    net.advance('2026-10-05T19:00:40Z');
    net.holdNextSendUntil = Infinity; // underpriced, never clears during the window
    assert.equal((await netRun(net, REAL, '2026-10-05T19:01:00Z', { crashOn: '77' })).crashed, true);
    const runs = [];
    for (const t of ['2026-10-05T19:16:00Z', '2026-10-05T19:31:00Z', '2026-10-05T19:46:00Z']) {
      net.advance(t);
      runs.push(await netRun(net, REAL, t));
    }
    assert.deepEqual(runs.slice(0, 2).map((r) => decisions(r).find(([id]) => id === '77')?.[1]), ['held', 'held']);
    const close = runs[2];
    const a = close.actions.find((x) => x.id === '77');
    const bodies = close.alerts.alerts.map((x) => x.body).join(' | ');
    assert.ok(!(a?.result === 'never sent' && /send it by hand/.test(bodies)),
      `with ${net.mempool.length} cranker message(s) still pending, the close run said: ${a?.decision} / ${a?.result}; alert: ${bodies}`);
  });
});

// =============================================================================================
describe('QA3: a dry run never alerts (docs/RUNBOOK.md)', () => {
  it('CRANK_DRY_RUN=1 with an unreadable schedule file: no alert (it fails before any network access)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa3-dry-'));
    try {
      const bad = join(dir, 'schedule.json');
      writeFileSync(bad, '{ not json');
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'crank.mjs')], {
        cwd: ROOT, encoding: 'utf8', timeout: 60_000,
        env: { PATH: process.env.PATH, NETWORK: 'calibnet', CRANK_MODE: 'rehearsal', CRANK_DRY_RUN: '1', CRANK_SCHEDULE_FILE: bad, ALERT_TRANSPORT: 'console', CRANK_PAUSE_FILE: join(dir, 'PAUSED') },
      });
      assert.match(r.stderr, /not valid JSON/);
      const alerts = [...r.stderr.matchAll(/\[ALERT (\w+)\] ([^\n]*)/g)].map((m) => `${m[1]}: ${m[2]}`);
      assert.deepEqual(alerts, [], `a dry run raised ${alerts.join('; ')} (exit ${r.status})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =============================================================================================
// A scripted chain (as in rehearsal-qa.test.mjs) with gas limits and receipt failures
// =============================================================================================
class AmbChain {
  constructor({ at, respond = () => ({ status: 1 }) }) {
    this.headNumber = epochOf(at);
    this.respond = respond;
    this.txs = [];
    this.sends = [];
    this.receiptNull = new Set();
    this.gateNext = 7;
  }
  at(iso) {
    this.headNumber = Math.max(this.headNumber, epochOf(iso));
    return this;
  }
  place(iso, e, result, gasLimit = 100_000_000n) {
    const v = one(e);
    const tx = { hash: `0xmanual${this.txs.length}`, to: TARGETS[v.contract], data: calldataFor(v), gasLimit, blockNumber: epochOf(iso), result };
    this.txs.push(tx);
    this.txs.sort((a, b) => a.blockNumber - b.blockNumber);
    return tx;
  }
  async head() {
    return { number: this.headNumber, timestamp: tsOf(this.headNumber) };
  }
  async nonceAt(tag) {
    if (tag === 'pending' || tag === 'latest') return this.txs.length;
    return this.txs.filter((t) => t.blockNumber <= tag).length;
  }
  async timestampAt(n) {
    return tsOf(n);
  }
  async sentInBlock(n) {
    return this.txs.filter((t) => t.blockNumber === n).map((t, i) => ({ hash: t.hash, to: t.to, data: t.data, nonce: i, gasLimit: t.gasLimit, blockNumber: n, timestamp: tsOf(n) }));
  }
  async gateState(swa, tag = 'latest') {
    const later = tag === 'latest' ? 0 : this.txs.filter((t) => t.blockNumber > tag && t.result?.status === 1 && t.result?.gate).length;
    const next = this.gateNext - later;
    return { next, lastChecked: next - 1, steps: 4, complete: false };
  }
  async receiptOf(hash) {
    if (this.receiptNull.has(hash)) return null;
    const tx = this.txs.find((t) => t.hash === hash);
    if (!tx) return null;
    const r = tx.result;
    const logs = r.gate ? [{ address: TARGETS.swa, ...SWA.encodeEventLog('QuarterlyGateCheckResult', [r.gate.quarter, r.gate.passed, r.gate.steps]) }] : [];
    return { hash, status: r.status, blockNumber: tx.blockNumber, gasUsed: 4_000_000n, logs };
  }
  async estimateGas(req) {
    const r = this.respond(req, this);
    if (r.status === 0) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: r.revert });
    return 1_000_000n;
  }
  async send(req) {
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
    return { data: tx.result.revert ?? null, source: 'fake', exitCode: 33 };
  }
}

async function run(chain, sched, { now, dryRun = false, reportWindowMs = 30 * MIN } = {}) {
  const h = harness();
  const result = await runRehearsal({
    schedule: sched, targets: TARGETS, chain, cranker: CRANKER, nowMs: ms(now), dryRun, pause: NOPAUSE, receiptPollMs: 1,
    gasLimit: 100_000_000n, reportWindowMs, confirmations: 1, alerts: h.alerts, log: h.log,
  });
  const r = { ...result, ...h, dryRun, at: now };
  ALL_RUNS.push(r);
  return r;
}

const AS = (q) => ({ status: 0, revert: revertWith('AlreadySubmitted', [q]) });
const LANDED = { status: 1 };
const E30 = entry({ id: '30.1', step: 30, function: 'submitShares', args: [3], notBefore: '2026-10-06T19:00:00Z', notAfter: '2026-10-06T19:45:00Z', expect: 'pass' });
const E31 = entry({ id: '31', step: 31, function: 'submitShares', args: [3], notBefore: '2026-10-06T19:15:00Z', notAfter: '2026-10-06T20:00:00Z', expect: 'revert:*' });

describe('QA3: "possibly sent already" holds', () => {
  it('a held row stays held for its whole window (runs every 5 minutes); never sent', async () => {
    const s = schedule({ ...E30, status: 'Complete' }, E31);
    const c = new AmbChain({ at: '2026-10-06T19:17:00Z', respond: () => AS(3) });
    c.place('2026-10-06T19:16:00Z', E30, LANDED); // a person's late 30.1, inside 31's window
    for (let t = ms('2026-10-06T19:17:00Z'); t < ms('2026-10-06T19:59:00Z'); t += 5 * MIN) {
      const r = await run(c.at(isoOf(t)), s, { now: isoOf(t) });
      assert.deepEqual(decisions(r), [['31', 'held']], `${isoOf(t)}: ${explain(r)}`);
    }
    assert.equal(c.sends.length, 0);
  });

  it('when its window closes, a held "possibly sent" row is not reported "never sent" with advice to send it by hand', async () => {
    const s = schedule({ ...E30, status: 'Complete' }, E31);
    const c = new AmbChain({ at: '2026-10-06T19:20:00Z', respond: () => AS(3) });
    c.place('2026-10-06T19:16:00Z', E30, LANDED);
    const r1 = await run(c, s, { now: '2026-10-06T19:20:00Z' });
    assert.match(r1.alerts.alerts[0]?.title ?? '', /may already have been sent/);
    const r2 = await run(c.at('2026-10-06T20:01:00Z'), s, { now: '2026-10-06T20:01:00Z' });
    const a = r2.actions.find((x) => x.id === '31');
    const said = `${a?.decision} / ${a?.result} / alert: ${r2.alerts.alerts.map((x) => `${x.title} -- ${x.body}`).join(' | ')}`;
    assert.ok(!(a?.result === 'never sent' || r2.alerts.alerts.some((x) => /nothing sent|send it by hand/.test(x.body))),
      `step 31 was held as possibly sent by ${c.txs[0].hash}, and is now reported: ${said}`);
  });

  it('an unreadable receipt does not turn a held row into a send (no resend on a guess)', async () => {
    // A person's submitShares(3) at 19:16 REVERTED (Q3 was submitted from another wallet): on chain it
    // looks like step 31 (expects a revert), but the engine would have been sending 30.1 then.
    const s = schedule(E30, E31);
    const c = new AmbChain({ at: '2026-10-06T19:20:00Z', respond: () => AS(3) });
    const manual = c.place('2026-10-06T19:16:00Z', E30, AS(3));
    const r1 = await run(c, s, { now: '2026-10-06T19:20:00Z' });
    assert.equal(c.sends.length, 0, explain(r1));
    // Five minutes later the load-balanced node answers null for that receipt.
    c.receiptNull.add(manual.hash);
    const r2 = await run(c.at('2026-10-06T19:25:00Z'), s, { now: '2026-10-06T19:25:00Z' });
    assert.equal(c.sends.length, 0, `run 1 said ${explain(r1)}; with the receipt unreadable run 2 said ${explain(r2)}`);
  });

  it('...and the engine\'s own tagged send is never credited to a row with a different tag', async () => {
    const s = schedule(E30, E31);
    const c = new AmbChain({ at: '2026-10-06T19:20:00Z', respond: () => AS(3) });
    const manual = c.place('2026-10-06T19:16:00Z', E30, AS(3));
    c.receiptNull.add(manual.hash);
    await run(c, s, { now: '2026-10-06T19:20:00Z' }); // sends 31 if the guess is made
    c.receiptNull.clear();
    const r = await run(c.at('2026-10-06T19:35:00Z'), s, { now: '2026-10-06T19:35:00Z' });
    const wrong = r.actions.filter((a) => {
      const tx = c.txs.find((t) => t.hash === a.txHash);
      return a.decision === 'already-sent' && tx && tx.gasLimit % 100_000n !== 0n && tx.gasLimit % 100_000n !== stepTag(a.id);
    });
    assert.deepEqual(wrong.map((a) => [a.id, a.txHash, String(c.txs.find((t) => t.hash === a.txHash).gasLimit)]), [], explain(r));
  });
});

// =============================================================================================
describe('QA3: the gas-limit step tag', () => {
  it('validateSchedule refuses ids whose tags collide, or a tag of 0 (force_call\'s 100,000,000)', () => {
    const gate = (id, nb) => entry({ id, notBefore: nb, notAfter: '2026-10-06T00:40:00Z' });
    const accepted = [];
    for (const [a, b] of [['31', '31.0'], ['1', '10001'], ['80', '080'], ['0', null], ['10000', null]]) {
      const entries = [gate(a, '2026-10-05T22:15:00Z'), ...(b ? [gate(b, '2026-10-05T22:20:00Z')] : [])];
      try {
        validateSchedule({ chainId: 314159, entries });
        accepted.push(`${a}${b ? `/${b}` : ''} (tag ${stepTag(a)})`);
      } catch {
        // refused: good
      }
    }
    assert.deepEqual(accepted, [], 'schedules whose rows cannot be told apart by tag were accepted');
  });

  // Revised after QA round 3: a schedule with id "0" (tag 0, which force_call's limit carries) is
  // now refused outright, as is any pair of ids sharing a tag.
  it('a hand-edited id "0", or two ids sharing a tag, is refused before anything runs', () => {
    assert.throws(() => schedule(entry({ id: '0' })), /step tag 0/);
    assert.throws(() => schedule(entry({ id: '31' }), entry({ id: '31.0' })), /share step tag/);
    assert.throws(() => schedule(entry({ id: '80' }), entry({ id: '080' })), /share step tag/);
  });

  it('a production-mode estimate whose limit ends in 00310 (step 31\'s tag) is taken as 31, and 30.1 is sent again', async () => {
    // src/crank.mjs: gasLimit = estimate * 14 / 10. 42,928,793 * 14 / 10 = 60,100,310.
    const prodLimit = (42_928_793n * 14n) / 10n;
    assert.equal(prodLimit % 100_000n, stepTag('31'));
    const s = schedule(E30, E31);
    const c = new AmbChain({ at: '2026-10-06T19:20:00Z', respond: () => AS(3) });
    c.place('2026-10-06T19:16:00Z', E30, LANDED, prodLimit); // production mode, same key, submitShares(3) lands
    const r = await run(c, s, { now: '2026-10-06T19:20:00Z' });
    // One more submitShares(3) is due either way; with evidence alone the landed one is 30.1's, and 31 (a revert) goes next.
    assert.ok(!decisions(r).some(([id, d]) => id === '30.1' && d === 'sent'), `the production send was taken as 31 by its gas limit, so 30.1 (expects pass) is sent now and will revert: ${explain(r)}`);
  });

  it('force_call\'s untagged 100,000,000 on the real ids is attributed by evidence (tested quarter), correctly', async () => {
    const s = schedule(...['78', '79', '80'].map((id) => ({ ...byId[id] })));
    const c = new AmbChain({ at: '2026-10-05T22:31:00Z', respond: () => ({ status: 0, revert: revertWith('StepWeightRecordsFailed', [16]) }) });
    c.gateNext = 7;
    c.place('2026-10-05T22:16:00Z', byId['78'], { status: 1, gate: { quarter: 5, passed: true, steps: 5 } }, 100_000_780n); // engine
    c.place('2026-10-05T22:21:00Z', byId['79'], { status: 1, gate: { quarter: 6, passed: false, steps: 5 } }, 100_000_000n); // person
    const r = await run(c, s, { now: '2026-10-05T22:31:00Z' });
    assert.deepEqual(r.actions.map((a) => [a.id, a.decision, a.match]), [['78', 'already-sent', true], ['79', 'already-sent', true], ['80', 'sent', true]]);
  });

  it('an odd CRANK_REHEARSAL_GAS_LIMIT still carries the tag', () => {
    for (const [limit, id] of [[5_050_001n, '117'], [21_000n, '93.2'], [99_999n, '13.1'], [100_000_000n, '105.2']]) {
      const g = (((limit + 99_999n) / 100_000n) * 100_000n) + stepTag(id);
      assert.ok(g >= limit && g % 100_000n === stepTag(id), `${limit} ${id} -> ${g}`);
    }
  });
});

// =============================================================================================
describe('QA3: how much the ledger scan reads', () => {
  it('the real schedule: RPC calls per run stay small', async (t) => {
    const week = await rehearsalWeek({ seed: 11 });
    const rpc = week.runs.map((r) => r.rpc);
    const worst = week.runs.reduce((a, b) => (b.rpc > a.rpc ? b : a));
    t.diagnostic(`real schedule, ${week.runs.length} runs: max ${worst.rpc} calls (${worst.at}), mean ${(rpc.reduce((a, b) => a + b, 0) / rpc.length).toFixed(1)}`);
    assert.ok(worst.rpc < 400, `${worst.rpc} RPC calls in the ${worst.at} run`);
  });

  /** n rows, one every `every` minutes, each open `open` minutes; the first `done` already sent and Complete. */
  async function scan60({ n = 60, every, open, done, wide = null }) {
    const start = ms('2026-10-06T00:00:00Z');
    const entries = [];
    for (let i = 0; i < n; i++) {
      const nb = start + i * every * MIN;
      entries.push(entry({ id: String(200 + i), step: 200 + i, function: 'submitShares', args: [20 + i], notBefore: isoOf(nb), notAfter: isoOf(nb + open * MIN), status: i < done ? 'Complete' : 'Pending' }));
    }
    if (wide !== null) entries[wide] = { ...entries[wide], notAfter: isoOf(ms(entries[wide].notBefore) + 3 * 86_400_000) };
    const s = schedule(...entries);
    const net = new NightNet({ start: start - 10 * MIN, model: (req, st) => ({ result: { status: 1 }, next: st }) });
    for (let i = 0; i < done; i++) {
      net.external(isoOf(ms(entries[i].notBefore) + 90_000), entries[i], 100_000_000n + stepTag(entries[i].id));
    }
    const now = ms(entries[done].notBefore) + 60_000;
    net.advance(now);
    const r = await netRun(net, s, now);
    return { r, calls: Object.fromEntries(net.calls), rows: n, now: isoOf(now) };
  }

  it('60 rows, windows chained (every 15 min, open 45): the scan reaches back through every Complete row', async (t) => {
    const { r, calls } = await scan60({ every: 15, open: 45, done: 50 });
    t.diagnostic(`chained windows, 50 Complete rows: ${r.rpc} RPC calls in one run (${JSON.stringify(calls)}); decisions ${JSON.stringify(decisions(r))}`);
    assert.deepEqual(decisions(r), [['250', 'sent']]);
    assert.ok(r.rpc < 2000, `${r.rpc} RPC calls in one run`); // measured, reported; see the diagnostic
  });

  it('60 rows, separate windows (every 60 min, open 45): the scan stays local', async (t) => {
    const { r, calls } = await scan60({ every: 60, open: 45, done: 50 });
    t.diagnostic(`separate windows, 50 Complete rows: ${r.rpc} RPC calls in one run (${JSON.stringify(calls)})`);
    assert.ok(r.rpc < 100, `${r.rpc} RPC calls in one run`);
  });

  it('one Complete row with a 3-day window (a mistyped Closes date) drags every run\'s scan back three days', async (t) => {
    const { r, calls } = await scan60({ every: 60, open: 45, done: 50, wide: 0 });
    t.diagnostic(`one 3-day Complete window: ${r.rpc} RPC calls in one run (${JSON.stringify(calls)})`);
    assert.deepEqual(decisions(r), [['250', 'sent']]);
    assert.ok(r.rpc < 2000, `${r.rpc} RPC calls in one run`); // measured, reported; see the diagnostic
  });
});

// =============================================================================================
describe('QA3: building the schedule from runbook prose', () => {
  it('"doesn\'t revert", "won\'t revert", "no revert expected", "cannot revert", "isn\'t expected to revert" are not expected reverts', () => {
    const got = ["QuarterlyGateCheck(Q7), doesn't revert, weight 35%", "QuarterlyGateCheck(Q7), won't revert now the hold is over",
      'QuarterlyGateCheck(Q7), no revert expected', 'QuarterlyGateCheck(Q7), cannot revert', "QuarterlyGateCheck(Q7), isn't expected to revert"]
      .map((t) => [t, parseActionCalls(t).calls[0]?.expect]).filter(([, e]) => e !== 'pass');
    assert.deepEqual(got, []);
  });

  it('a call followed by "DO NOT SEND", "shouldn\'t be sent", "won\'t be sent", "is skipped", "cancelled" is not a call to send', () => {
    const got = ['QuarterlyGateCheck(Q5): DO NOT SEND', "QuarterlyGateCheck(Q5) shouldn't be sent this weekend", "QuarterlyGateCheck(Q5) won't be sent",
      'QuarterlyGateCheck(Q5) is skipped (weekend)', 'QuarterlyGateCheck(Q5) -- cancelled']
      .map((t) => [t, parseActionCalls(t).calls.length]).filter(([, n]) => n !== 0);
    assert.deepEqual(got, []);
  });

  it('"then at 08:00 X" / "then Tue 08:00: X" / "then after the hold X" points at a later time, not a second call now', () => {
    const got = ['QuarterlyGateCheck(Q7), revert StepWeightRecordsFailed; then at 08:00 QuarterlyGateCheck(Q7), PASS',
      'QuarterlyGateCheck(Q7), revert StepWeightRecordsFailed; then Tue 08:00: QuarterlyGateCheck(Q7), PASS',
      'QuarterlyGateCheck(Q7), revert StepWeightRecordsFailed; then after the hold QuarterlyGateCheck(Q7), PASS']
      .map((t) => [t, parseActionCalls(t).calls.length]).filter(([, n]) => n !== 1);
    assert.deepEqual(got, []);
  });

  it('"Send SubmitShares(Q8), then QuarterlyGateCheck(Q8)" does not schedule the gate check without the shares it depends on', () => {
    const { calls } = parseActionCalls('Send SubmitShares(Q8), then QuarterlyGateCheck(Q8), PASS');
    assert.ok(calls.length !== 1 || calls[0].function !== 'quarterlyGateCheck', `calls: ${JSON.stringify(calls.map((x) => `${x.function}(${x.args})`))}`);
  });

  it('a time with seconds is not rounded down (22:15:30 must not become 22:15:00, 30 s early)', () => {
    const r = parseRunbookTime('Mon 2026-10-05 22:15:30');
    assert.ok(r === null || r.ms >= ms('2026-10-05T22:15:30Z'), `parsed as ${r?.iso}`);
  });

  it('an impossible date (30 September has no 31st) is refused, by the builder and by validateSchedule', () => {
    let built = null;
    try {
      built = parseRunbookTime('2026-09-31 19:00');
    } catch {
      // refused: good
    }
    assert.equal(built, null, `"2026-09-31 19:00" parsed as ${built?.iso} = ${built && isoOf(built.ms)}`);
    assert.throws(() => validateSchedule({ chainId: 314159, entries: [entry({ notBefore: '2026-09-31T19:00:00Z', notAfter: '2026-10-01T19:45:00Z' })] }),
      /real date|ISO/);
  });

  it('the real runbook prose, lightly reformatted (a space before "(", doubled spaces, a trailing full stop) builds the same entries', () => {
    const csv = readFileSync(join(ROOT, 'test', 'fixtures', 'runbook-cranker-rows.csv'), 'utf8');
    const base = buildScheduleFromCsv(csv).doc.entries.map((e) => [e.id, e.function, e.args, e.gateQuarter, e.expect, e.notBefore]);
    const tweaked = csv.replace(/QuarterlyGateCheck\(/g, 'QuarterlyGateCheck (').replace(/PASS, weight/g, 'PASS,  weight').replace(',SubmitShares(Q7),', ',SubmitShares(Q7).,');
    const again = buildScheduleFromCsv(tweaked).doc.entries.map((e) => [e.id, e.function, e.args, e.gateQuarter, e.expect, e.notBefore]);
    assert.deepEqual(again, base);
  });
});

describe('QA3: build --check stability', () => {
  const TMP = mkdtempSync(join(tmpdir(), 'qa3-build-'));
  after(() => rmSync(TMP, { recursive: true, force: true }));
  const FIXTURE = join(ROOT, 'test', 'fixtures', 'runbook-cranker-rows.csv');
  const CSV = readFileSync(FIXTURE, 'utf8');
  const build = (csvPath, out, check) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-rehearsal-schedule.mjs'), '--csv', csvPath, '--out', out, ...(check ? ['--check'] : [])], { encoding: 'utf8', env: { PATH: process.env.PATH } });

  it('filling in "Notes / actual" and editing non-Cranker rows during the rehearsal does not make the file stale', () => {
    const out = join(TMP, 'fresh.json');
    assert.equal(build(FIXTURE, out, false).status, 0);
    const lines = CSV.split('\n');
    const edited = lines.map((l, i) => (i > 0 && /,Cranker,/.test(l) ? l.replace(/,$/, ',"sent 22:16, tx 0xabc, matched"') : l));
    edited.splice(3, 0, '901,Q9,Synthetic,SWA FF,"QuarterlyGateCheck(Q9) by hand",,Wed 2026-10-07 19:05,Wed 2026-10-07 19:20,Pending,');
    const f = join(TMP, 'edited.csv');
    writeFileSync(f, edited.join('\n'));
    const r = build(f, out, true);
    assert.equal(r.status, 0, r.stderr.split('\n').slice(-3).join(' / '));
  });

  it('marking a Cranker row Complete makes it stale (the cranker must learn of it)', () => {
    const out = join(TMP, 'fresh2.json');
    assert.equal(build(FIXTURE, out, false).status, 0);
    const f = join(TMP, 'complete.csv');
    writeFileSync(f, CSV.replace('Mon 2026-10-05 19:15,Pending', 'Mon 2026-10-05 19:15,Complete'));
    assert.equal(build(f, out, true).status, 1);
  });
});

// =============================================================================================
describe('QA3: invariant over every engine run above', () => {
  it('exit 1 <=> at least one alert; dry runs never alert', () => {
    assert.ok(ALL_RUNS.length > 1000, `only ${ALL_RUNS.length} runs`);
    const bad = ALL_RUNS.filter((r) => (r.dryRun ? r.alerts.alerts.length || r.exitCode : (r.exitCode === 1) !== (r.alerts.alerts.length > 0)))
      .map((r) => ({ at: r.at, exit: r.exitCode, alerts: r.alerts.alerts.map((a) => a.title) }));
    assert.deepEqual(bad, []);
  });
});
