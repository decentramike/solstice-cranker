/**
 * Rehearsal mode: send what the plan says, when the plan says, once.
 *
 * Production mode decides for itself -- it simulates each call and sends the ones that would
 * succeed, as soon as they would. That is right for keeping quarters from being lost, and wrong
 * for a rehearsal, where the point is to put specific calls on chain at specific times,
 * including calls that are supposed to revert. Here the cranker decides nothing:
 *
 *   - only calls in the schedule file are ever sent
 *   - each one no earlier than its notBefore, judged by the runner's clock AND the chain head's
 *     timestamp -- so a 19:00 submitShares cannot land before 19:00's binding epoch is on chain
 *   - and only while its window is comfortably open: neither clock may be within a minute of
 *     notAfter, checked again immediately before each send
 *   - each one at most once. The chain is the ledger: before sending, the run finds every
 *     transaction the cranker sent since the earliest relevant window opened (by bisecting its
 *     nonce history) and attributes each to a schedule entry. quarterlyGateCheck() has no
 *     argument, so its calldata cannot say which step a transaction was; the quarter it actually
 *     tested (from its QuarterlyGateCheckResult event, or the gate state at the block before)
 *     does. Nothing is stored between runs.
 *   - an expected revert is sent with no eth_call or estimateGas pre-check and an explicit gas
 *     limit, and lands on chain with a non-zero exit code, as the runbook wants
 *   - every send is recorded with its tx hash, epoch, decoded result, and whether it matched
 *
 * Every chain access goes through the `chain` adapter, so the decisions can be tested without a
 * node; ethersChain() below is the real one.
 */
import { Interface } from 'ethers';

import { readBalance, readSwaGateState, withRetry } from '../chain.mjs';
import { classifyRevert, isTransportFailure } from '../errors.mjs';
import { CALLS, callLabel, REHEARSAL_CHAIN_ID } from './schedule.mjs';

/**
 * The explicit gas limit for a call sent without a pre-check, in FEVM gas units.
 *
 * Same reasoning and number as scripts/crank-force.mjs: real calls to these proxies on calibnet
 * used up to ~61,000,000, a revert stops early and uses less, and under-gassing is the worse
 * error -- the message would fail SYS_OUT_OF_GAS instead of reverting for the reason the step
 * is testing. At calibnet's base fee all 100M costs about 0.00000001 FIL.
 */
export const DEFAULT_REHEARSAL_GAS_LIMIT = 100_000_000n;

/** Headroom on an estimate for a call expected to land. Same as production. */
const GAS_MULTIPLIER_TENTHS = 14n;

/** How far before the earliest relevant window to start looking for earlier sends. */
const LOOKBACK_MARGIN_SECONDS = 120;

/**
 * No send starts within this long of notAfter, by either clock: a message takes an epoch or two
 * to land, and one that lands after its window would be reported missed and then resent by hand.
 */
export const SEND_MARGIN_MS = 60_000;

/** A transaction that landed this soon after notAfter still belongs to its entry. */
const MATCH_SLACK_MS = 5 * 60_000;

/** Lotus null rounds have no block; walk at most a day of them. */
const MAX_NULL_WALK = 2880;

const INTERFACES = Object.fromEntries(Object.entries(CALLS).map(([fn, c]) => [fn, new Interface(c.abi)]));
const SWA_IFACE = INTERFACES.quarterlyGateCheck;
const GATE_CALLDATA = SWA_IFACE.encodeFunctionData('quarterlyGateCheck', []).toLowerCase();

export const calldataFor = (entry) => INTERFACES[entry.function].encodeFunctionData(entry.function, entry.args);

export class RehearsalRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'RehearsalRefused';
  }
}

/** Refuses rehearsal mode on anything but calibnet. Called before connecting and again after. */
export function assertRehearsalChain(chainId, where) {
  if (BigInt(chainId) !== BigInt(REHEARSAL_CHAIN_ID)) {
    throw new RehearsalRefused(
      `rehearsal mode is calibnet-only (chain id ${REHEARSAL_CHAIN_ID}), but ${where} is chain ${chainId}. ` +
        'Refusing to start. Unset CRANK_MODE to run the production cranker.'
    );
  }
}

/** The QuarterlyGateCheckResult a receipt carries, if any. */
export function gateResultOf(receipt, swa) {
  for (const lg of receipt?.logs ?? []) {
    if (String(lg.address).toLowerCase() !== String(swa).toLowerCase()) continue;
    try {
      const ev = SWA_IFACE.parseLog(lg);
      if (ev?.name === 'QuarterlyGateCheckResult') {
        return { quarter: Number(ev.args.quarter), passed: Boolean(ev.args.passed), steps: Number(ev.args.steps) };
      }
    } catch {
      // another event
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The real chain
// ---------------------------------------------------------------------------------------------

const NULL_ROUND = Symbol('null round');
const isNullRound = (err) => /null round/i.test(`${err?.shortMessage ?? ''} ${err?.message ?? ''} ${err?.info?.error?.message ?? ''}`);

/** CBOR byte string -> 0x hex. Lotus returns an FEVM call's output (or revert data) this way. */
export function cborBytesToHex(base64) {
  if (!base64) return null;
  const buf = Buffer.from(base64, 'base64');
  if (buf.length === 0 || buf[0] >> 5 !== 2) return null;
  const info = buf[0] & 0x1f;
  let len;
  let off;
  if (info < 24) [len, off] = [info, 1];
  else if (info === 24) [len, off] = [buf[1], 2];
  else if (info === 25) [len, off] = [buf.readUInt16BE(1), 3];
  else if (info === 26) [len, off] = [buf.readUInt32BE(1), 5];
  else return null;
  if (buf.length < off + len) return null;
  return '0x' + buf.subarray(off, off + len).toString('hex');
}

/**
 * @param {{provider, wallet, address: string|null, epochSeconds?: number}} p
 *   wallet may be null: then nothing can be sent, and the engine is only ever run as a dry run.
 */
export function ethersChain({ provider, wallet, address, epochSeconds = 30 }) {
  const nonceCache = new Map();
  const tsCache = new Map();
  let headRef = null;

  /** One read with transport retries; a Lotus null round comes back as NULL_ROUND, unretried. */
  const read = (fn, what) =>
    withRetry(async () => {
      try {
        return await fn();
      } catch (err) {
        if (isNullRound(err)) return NULL_ROUND;
        throw err;
      }
    }, { what });

  const chain = {
    address,

    async head() {
      const b = await withRetry(() => provider.getBlock('latest'), { what: 'eth_getBlockByNumber(latest)' });
      headRef = { number: b.number, timestamp: b.timestamp };
      return headRef;
    },

    /** The cranker's nonce after block `tag` (a number), or at 'latest' / 'pending'. */
    async nonceAt(tag) {
      if (typeof tag !== 'number') {
        return read(() => provider.getTransactionCount(address, tag), `eth_getTransactionCount(${tag})`);
      }
      if (nonceCache.has(tag)) return nonceCache.get(tag);
      // A null round has no state of its own; the nonce there is the previous block's.
      for (let b = tag; b >= 0 && b > tag - MAX_NULL_WALK; b--) {
        if (nonceCache.has(b)) {
          nonceCache.set(tag, nonceCache.get(b));
          return nonceCache.get(b);
        }
        const n = await read(() => provider.getTransactionCount(address, b), 'eth_getTransactionCount');
        if (n !== NULL_ROUND) {
          nonceCache.set(tag, n);
          return n;
        }
      }
      throw new Error(`no non-null block within ${MAX_NULL_WALK} epochs below ${tag}`);
    },

    /**
     * Timestamp of block `n`. A Lotus null round has no block, but every epoch has a time:
     * epochSeconds apart, counted back from the head.
     */
    async timestampAt(n) {
      if (tsCache.has(n)) return tsCache.get(n);
      const blk = await read(() => provider.getBlock(n), 'eth_getBlockByNumber');
      let ts;
      if (blk && blk !== NULL_ROUND) {
        ts = blk.timestamp;
      } else {
        const h = headRef ?? (await chain.head());
        ts = h.timestamp - (h.number - n) * epochSeconds;
      }
      tsCache.set(n, ts);
      return ts;
    },

    /** Every transaction `address` sent in block `n`, in nonce order. */
    async sentInBlock(n) {
      const blk = await read(() => provider.getBlock(n, true), 'eth_getBlockByNumber(full)');
      if (!blk || blk === NULL_ROUND) return [];
      const me = address.toLowerCase();
      return blk.prefetchedTransactions
        .filter((t) => t.from?.toLowerCase() === me)
        .map((t) => ({ hash: t.hash, to: t.to, data: t.data, nonce: t.nonce, gasLimit: t.gasLimit, blockNumber: n, timestamp: blk.timestamp }))
        .sort((a, b) => a.nonce - b.nonce);
    },

    receiptOf: (hash) => withRetry(() => provider.getTransactionReceipt(hash), { what: 'eth_getTransactionReceipt' }),

    async gateState(swa, blockTag = 'latest') {
      const g = await readSwaGateState(provider, swa, blockTag);
      return { next: g.lastCheckedQuarter + 1, lastChecked: g.lastCheckedQuarter, steps: g.steps, complete: g.complete };
    },

    estimateGas: (req) =>
      withRetry(() => provider.estimateGas(address ? { from: address, ...req } : req), { what: 'eth_estimateGas' }),

    /** Broadcasts. Never retried: a second attempt could be a second message. */
    send(req) {
      if (!wallet) throw new Error('no signer: this session cannot send');
      return wallet.sendTransaction(req);
    },

    /** ethers v6 throws on a status-0 receipt and attaches it; on FEVM that is a landed revert. */
    async wait(tx, confirmations) {
      try {
        return await tx.wait(confirmations);
      } catch (err) {
        if (err?.code === 'CALL_EXCEPTION' && err.receipt) return err.receipt;
        throw err;
      }
    },

    /**
     * The revert data of a mined, reverted message.
     *
     * A receipt carries none. Lotus keeps the message's own return value -- the exact revert
     * bytes, CBOR-wrapped, with exit code 33 for an EVM revert -- and hands it back for a recent
     * message. When that is not available (Hardhat, an old message, a gateway without the
     * Filecoin namespace), replaying the call at the parent block gives the reason the call would
     * revert with there, which is the same one unless an earlier message in the same block
     * changed the outcome.
     */
    async revertData(req, receipt) {
      try {
        const cid = await provider.send('Filecoin.EthGetMessageCidByTransactionHash', [receipt.hash]);
        if (cid) {
          const found = await provider.send('Filecoin.StateSearchMsg', [[], cid, -1, true]);
          const exitCode = found?.Receipt?.ExitCode ?? null;
          const data = cborBytesToHex(found?.Receipt?.Return);
          if (data && data.length >= 10) return { data, source: 'lotus-receipt', exitCode };
          if (exitCode !== null && exitCode !== 33) return { data: null, source: 'lotus-receipt', exitCode };
        }
      } catch {
        // Not Lotus, or the message is outside its lookback. Fall through to the replay.
      }
      try {
        await provider.call({ from: address, to: req.to, data: req.data, gasLimit: req.gasLimit, blockTag: receipt.blockNumber - 1 });
        return { data: null, source: 'replay-passed', exitCode: null };
      } catch (err) {
        const v = classifyRevert(err);
        return { data: v.raw, source: 'replay', exitCode: null, verdict: v };
      }
    },

    balance: () => readBalance(provider, address),
  };
  return chain;
}

// ---------------------------------------------------------------------------------------------
// The ledger: what did the cranker already send, and for which step?
// ---------------------------------------------------------------------------------------------

/** The first block whose timestamp is >= t, or head + 1 when none is yet. */
export async function firstBlockAtOrAfter(chain, tSec, head) {
  if (head.timestamp < tSec) return head.number + 1;
  let hi = head.number;
  let lo = null;
  for (let step = 1; ; step *= 2) {
    const b = Math.max(0, hi - step);
    if ((await chain.timestampAt(b)) < tSec) {
      lo = b;
      break;
    }
    hi = b;
    if (b === 0) return 0;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await chain.timestampAt(mid)) < tSec) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Every transaction the cranker sent from the first block at or after `fromSec` to `head`.
 *
 * Bisects on the nonce: each increment is found in about log2(range) reads, and only the blocks
 * that actually hold one of the cranker's transactions are fetched in full. On Glif the nonce at
 * block N includes block N's own transactions (checked against the cranker's 5 Oct sends); a
 * node that answered with the parent state instead would put the increment one block late, so an
 * empty block there is followed by a look at the block before.
 *
 * @returns {{txs: object[], complete: boolean, missing: number}}
 *   complete is false when the blocks hold fewer of the cranker's transactions than its nonce
 *   says it sent. Then nobody can say which entries are done, and the run must not send.
 */
export async function findSentSince(chain, fromSec, head) {
  const start = await firstBlockAtOrAfter(chain, fromSec, head);
  if (start > head.number) return { txs: [], complete: true, missing: 0 };
  const base = start === 0 ? 0 : await chain.nonceAt(start - 1);
  const top = await chain.nonceAt(head.number);
  const txs = [];
  const seen = new Set();
  let n = base;
  let lo = start;
  while (n < top) {
    let a = lo;
    let z = head.number;
    while (a < z) {
      const mid = Math.floor((a + z) / 2);
      if ((await chain.nonceAt(mid)) > n) z = mid;
      else a = mid + 1;
    }
    let found = await chain.sentInBlock(a);
    if (found.length === 0 && a > 0) found = await chain.sentInBlock(a - 1);
    for (const t of found) {
      if (!seen.has(t.hash)) {
        seen.add(t.hash);
        txs.push(t);
      }
    }
    n = await chain.nonceAt(a);
    lo = a + 1;
  }
  const missing = top - base - txs.length;
  return { txs, complete: missing === 0, missing };
}

/**
 * Works out which quarter each of the cranker's gate checks tested.
 *
 * A gate check that landed says so in its QuarterlyGateCheckResult event. One that reverted
 * tested whatever quarter was next at the block before it (plus any of the cranker's own gate
 * checks that landed earlier in the same block). Sets tx.receipt and tx.testedQuarter.
 *
 * @returns {boolean} false if a quarter could not be established -- then the run must not send
 */
export async function resolveGateQuarters(chain, txs, swa) {
  const landedInBlock = new Map();
  for (const tx of txs) {
    if (String(tx.to).toLowerCase() !== swa.toLowerCase() || String(tx.data).toLowerCase() !== GATE_CALLDATA) continue;
    try {
      tx.receipt = await chain.receiptOf(tx.hash);
      const ev = tx.receipt?.status === 1 ? gateResultOf(tx.receipt, swa) : null;
      if (ev) {
        tx.testedQuarter = ev.quarter;
        landedInBlock.set(tx.blockNumber, ev.quarter);
      } else {
        const earlier = landedInBlock.get(tx.blockNumber);
        const last = earlier ?? (await chain.gateState(swa, tx.blockNumber - 1)).lastChecked;
        tx.testedQuarter = last + 1;
      }
    } catch {
      tx.testedQuarter = undefined;
      return false;
    }
  }
  return true;
}

/**
 * Attributes sent transactions to schedule entries.
 *
 * Each transaction goes, in nonce order, to the earliest-opening unmatched entry with the same
 * target and calldata whose window holds the block it landed in -- and, for a gate check whose
 * tested quarter is known, only to an entry naming that quarter. Entries the runbook marks done
 * take part as claimants, so their transactions are never credited to a later step.
 */
export function assignSends(entries, txs, targets) {
  const key = (to, data) => `${String(to).toLowerCase()}:${String(data).toLowerCase()}`;
  const ordered = [...entries].sort((a, b) => a.notBeforeMs - b.notBeforeMs || a.index - b.index);
  const keys = new Map(ordered.map((e) => [e.id, key(targets[e.contract], calldataFor(e))]));
  const sentFor = new Map();
  for (const tx of txs) {
    const k = key(tx.to, tx.data);
    const at = tx.timestamp * 1000;
    const e = ordered.find(
      (x) =>
        !sentFor.has(x.id) &&
        keys.get(x.id) === k &&
        at >= x.notBeforeMs &&
        at < x.notAfterMs + MATCH_SLACK_MS &&
        (tx.testedQuarter === undefined || x.gateQuarter === null || x.gateQuarter === tx.testedQuarter)
    );
    if (e) sentFor.set(e.id, tx);
  }
  return sentFor;
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/** What happened on chain, decoded. */
export async function readOutcome({ chain, entry, req, receipt, targets }) {
  const out = {
    status: receipt.status === 1 ? 'landed' : 'reverted',
    epoch: Number(receipt.blockNumber),
    gasUsed: receipt.gasUsed === undefined || receipt.gasUsed === null ? null : String(receipt.gasUsed),
    gate: null,
    revert: null,
    revertSource: null,
    exitCode: null,
  };
  if (out.status === 'landed') {
    if (entry.function === 'quarterlyGateCheck') out.gate = gateResultOf(receipt, targets.swa);
    return out;
  }
  const rd = await chain.revertData(req, receipt);
  out.revertSource = rd.source;
  out.exitCode = rd.exitCode;
  const v = rd.verdict ?? (rd.data ? classifyRevert({ data: rd.data }) : null);
  if (v && (v.name || v.reason)) out.revert = { name: v.name, reason: v.reason ?? v.name };
  return out;
}

export function describeOutcome(o) {
  if (o.status === 'landed') {
    if (o.gate) return `landed, gate ${o.gate.passed ? 'passed' : 'failed'} for Q${o.gate.quarter} (steps ${o.gate.steps})`;
    return 'landed';
  }
  if (o.exitCode !== null && o.exitCode !== 33) return `failed on chain, exit code ${o.exitCode}${o.revert?.reason ? ` (${o.revert.reason})` : ''}`;
  if (o.revert?.reason) return `reverted ${o.revert.reason}`;
  return 'reverted (reason not recoverable)';
}

/**
 * Does what happened match what the schedule expected?
 *
 * A revert means a contract revert: exit code 33 on FEVM, or a decoded revert where the exit code
 * is not known. Out of gas (exit 7) is not the revert a row was testing. A gate check's result
 * counts only for the quarter the row names.
 */
export function matches(entry, o) {
  const { kind, error } = entry.expectParsed;
  const rightQuarter = (g) => g !== null && (entry.gateQuarter === null || g.quarter === entry.gateQuarter);
  if (kind === 'pass') {
    if (o.status !== 'landed') return false;
    return entry.function !== 'quarterlyGateCheck' || (rightQuarter(o.gate) && o.gate.passed === true);
  }
  if (kind === 'fail') return o.status === 'landed' && rightQuarter(o.gate) && o.gate.passed === false;
  if (o.status !== 'reverted') return false;
  if (o.exitCode !== null && o.exitCode !== 33) return false;
  if (error !== null) return o.revert?.name === error;
  return o.revert !== null || o.exitCode === 33;
}

// ---------------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------------

const quote = (s) => (/\s/.test(String(s)) ? JSON.stringify(String(s)) : String(s));

/** The one log line per action: step, function, tx, epoch, result, match. */
export function actionLine(a) {
  return [
    `step=${a.id}`,
    `fn=${a.call}`,
    `tx=${a.txHash ?? '-'}`,
    `epoch=${a.epoch ?? '-'}`,
    `decision=${a.decision}`,
    `result=${quote(a.result ?? '-')}`,
    `expect=${a.expect}`,
    `match=${a.match === null || a.match === undefined ? '-' : a.match ? 'yes' : 'NO'}`,
  ].join(' ');
}

/**
 * @param {object} p
 * @param {object} p.schedule        validated schedule (validateSchedule)
 * @param {{sra:string, swa:string}} p.targets  from deployments.json
 * @param {object} p.chain           ethersChain() or a test double
 * @param {string|null} p.cranker    sender address; null for a keyless dry run
 * @param {number} p.nowMs           the run's start
 * @param {() => number} [p.clock]   the time now, re-read just before each send
 * @param {boolean} p.dryRun
 * @param {{paused:boolean, reason:string|null}} p.pause
 * @param {bigint} p.gasLimit        explicit gas for calls sent without a pre-check
 * @param {number} p.reportWindowMs  a problem is alerted on runs inside this long after it starts;
 *                                   set it to the trigger interval so each is alerted about once
 * @param {number} p.confirmations
 * @param {{raise:Function}} p.alerts
 * @param {object} p.log
 */
export async function runRehearsal(p) {
  const { schedule, targets, chain, cranker, nowMs, dryRun, pause, gasLimit, reportWindowMs, confirmations, alerts, log } = p;
  const clock = p.clock ?? (() => nowMs);
  const actions = [];
  const needsPerson = [];
  const base = (e) => ({
    id: e.id, step: e.step, call: callLabel(e), function: e.function, args: e.args,
    notBefore: e.notBefore, notAfter: e.notAfter, expect: e.expect,
    decision: null, txHash: null, epoch: null, result: null, match: null, message: null,
  });
  const record = (a, level = 'info') => {
    actions.push(a);
    log[level](`rehearsal ${actionLine(a)}`);
    if (a.message) log[level === 'info' ? 'debug' : level](`  ${a.message}`);
    return a;
  };
  /** Alerts and fails the run. A dry run reports, but does not page anyone. */
  const flag = (a, title, body) => {
    if (dryRun) return;
    needsPerson.push(a.id);
    alerts.raise({ severity: 'warn', title, body, context: { step: a.id, call: a.call, txHash: a.txHash } });
  };
  /** Alerts only on runs inside [anchor, anchor + reportWindow): about once, with no stored state. */
  const flagOnce = (anchorMs, a, title, body) => {
    if (nowMs >= anchorMs && nowMs < anchorMs + reportWindowMs) flag(a, title, body);
  };

  const head = await chain.head();
  const chainMs = head.timestamp * 1000;
  const openUntilMs = Math.min(nowMs, chainMs);
  const latestMs = Math.max(nowMs, chainMs);
  const live = schedule.entries.filter((e) => !e.done);

  const inWindow = (e) => e.notBeforeMs <= openUntilMs && latestMs + SEND_MARGIN_MS < e.notAfterMs;
  const eligible = live.filter(inWindow);
  const chainBehind = live.filter((e) => e.notBeforeMs <= nowMs && e.notBeforeMs > chainMs && nowMs < e.notAfterMs);
  const closing = live.filter((e) => e.notBeforeMs <= openUntilMs && !inWindow(e) && nowMs < e.notAfterMs);
  const justClosed = live.filter((e) => e.notAfterMs <= nowMs && nowMs < e.notAfterMs + reportWindowMs);
  const upcoming = live.filter((e) => e.notBeforeMs > nowMs);

  for (const e of chainBehind) {
    record({ ...base(e), decision: 'waiting', epoch: head.number,
      result: 'chain head is behind notBefore',
      message: `the head (epoch ${head.number}, ${new Date(chainMs).toISOString()}) has not reached ${e.notBefore} yet` });
  }

  if (pause.paused) {
    for (const e of [...eligible, ...closing]) {
      record({ ...base(e), decision: 'paused', epoch: head.number, result: 'not sent', message: `paused: ${pause.reason}` });
    }
    return finish();
  }

  // ---- what was already sent, and for which step ------------------------------------------
  // Scanned to the block before the head: on a load-balanced endpoint the next request can land
  // on a node one epoch behind, which refuses a query about a block it has not seen.
  let sentFor = new Map();
  let ledger = { complete: true, missing: 0 };
  let inFlight = false;
  const tracked = [...eligible, ...closing, ...justClosed];
  if (tracked.length && cranker) {
    const fromMs = Math.min(...tracked.map((e) => e.notBeforeMs));
    const scanHead = { number: Math.max(0, head.number - 1), timestamp: await chain.timestampAt(Math.max(0, head.number - 1)) };
    const found = await findSentSince(chain, Math.floor(fromMs / 1000) - LOOKBACK_MARGIN_SECONDS, scanHead);
    ledger = found;
    // Anything newer than the scanned block -- landed in the head block, or still in the mpool -- is
    // a send the ledger has not seen. Try to read the head block too; if that fails, or a message
    // is still pending, hold every send until a later run can see it.
    const pending = await chain.nonceAt('pending');
    if (ledger.complete && pending > (await chain.nonceAt(scanHead.number))) {
      try {
        const tail = await findSentSince(chain, scanHead.timestamp + 1, head);
        if (!tail.complete) throw new Error('head block incomplete');
        found.txs.push(...tail.txs.filter((t) => !found.txs.some((x) => x.hash === t.hash)));
        inFlight = pending > (await chain.nonceAt(head.number));
      } catch {
        inFlight = true;
      }
    }
    if (ledger.complete && !(await resolveGateQuarters(chain, found.txs, targets.swa))) {
      ledger = { complete: false, missing: 0, reason: 'could not tell which quarter one of its gate checks tested' };
    }
    // Done entries are claimants too: a transaction sent for a Complete row is never a later step's.
    const claimants = schedule.entries.filter((e) => e.notAfterMs + MATCH_SLACK_MS > fromMs && e.notBeforeMs <= latestMs);
    sentFor = assignSends(claimants, found.txs, targets);
  }

  for (const e of justClosed) {
    if (sentFor.has(e.id)) continue;
    const a = record({ ...base(e), decision: 'missed', epoch: head.number, result: 'never sent',
      message: `its window closed at ${e.notAfter} with nothing sent` }, 'warn');
    if (cranker && ledger.complete) {
      flagOnce(e.notAfterMs, a, `Rehearsal step ${e.id} was not sent`,
        `${a.call} (expect ${e.expect}) was scheduled for ${e.notBefore} and its window closed at ${e.notAfter} ` +
          'with nothing sent. The cranker will not send it late. If the step still matters, send it by hand ' +
          '(Run workflow -> force_call) and record it in the runbook.');
    }
  }

  if (!ledger.complete) {
    const msg = ledger.reason
      ? `${ledger.reason}; cannot tell which steps are done, so nothing is sent this run`
      : `the cranker's nonce says it sent ${ledger.missing} more transaction(s) than the blocks show; ` +
        'cannot tell which steps are done, so nothing is sent this run';
    log.warn(msg);
    if (!dryRun) {
      alerts.raise({ severity: 'warn', title: 'Rehearsal cranker cannot account for its own transactions', body: msg });
      needsPerson.push('ledger');
    }
  }

  for (const e of closing) {
    if (sentFor.has(e.id)) continue;
    record({ ...base(e), decision: 'too-late', epoch: head.number, result: 'not sent',
      message: `less than ${SEND_MARGIN_MS / 1000}s left before ${e.notAfter}; not started, so it cannot land after its window` }, 'warn');
  }

  // ---- send, in plan order ----------------------------------------------------------------
  let stopReason = null;
  let virtualGateNext = null; // a dry run's picture of the gate, advanced by the passes it would send
  for (const e of eligible) {
    const a = base(e);
    const already = sentFor.get(e.id);
    if (already) {
      const r = { ...a, decision: 'already-sent', txHash: already.hash, epoch: already.blockNumber, result: 'sent earlier',
        message: `sent at epoch ${already.blockNumber}; never sent twice` };
      try {
        // Read the outcome again so the record is complete even when the run that sent it never
        // got to (it crashed, or its receipt read failed). The alert, if any, was that run's.
        const receipt = already.receipt ?? (await chain.receiptOf(already.hash));
        if (receipt) {
          const o = await readOutcome({ chain, entry: e, req: { to: already.to, data: already.data, gasLimit: already.gasLimit }, receipt, targets });
          Object.assign(r, { result: describeOutcome(o), match: matches(e, o), revert: o.revert, gate: o.gate });
        }
      } catch (err) {
        r.message += `; outcome not readable (${err.shortMessage ?? err.message})`;
      }
      record(r, r.match === false ? 'warn' : 'info');
      continue;
    }
    if (!ledger.complete) {
      record({ ...a, decision: 'held', epoch: head.number, result: 'not sent', message: 'ledger incomplete; see above' }, 'warn');
      continue;
    }
    if (stopReason) {
      record({ ...a, decision: 'held', epoch: head.number, result: 'not sent', message: stopReason }, 'warn');
      continue;
    }
    if (inFlight) {
      const r = record({ ...a, decision: 'held', epoch: head.number, result: 'not sent',
        message: 'a transaction from the cranker is still pending; the next run decides once it has landed' }, 'warn');
      flagOnce(e.notBeforeMs + reportWindowMs, r, `Rehearsal step ${e.id} held: a cranker transaction is stuck`,
        `${r.call} has been due since ${e.notBefore}, but a transaction from the cranker is still pending, so ` +
          'nothing is sent until it lands. Check the cranker address on an explorer for a stuck message.');
      continue;
    }

    // The runbook labels each gate check with the quarter it tests. quarterlyGateCheck() takes no
    // argument -- it checks whatever quarter is next -- so if the chain has moved past the plan,
    // sending would test a different quarter and could consume a later step's check.
    if (e.function === 'quarterlyGateCheck' && e.gateQuarter !== null) {
      let next = virtualGateNext;
      if (next === null) {
        try {
          next = (await chain.gateState(targets.swa)).next;
        } catch (err) {
          stopReason = `could not read the SWA gate state (${err.shortMessage ?? err.message}); later steps wait for the next run`;
          const r = record({ ...a, decision: 'held', epoch: head.number, result: 'not sent', message: stopReason }, 'warn');
          flag(r, `Rehearsal step ${e.id} could not be checked`, stopReason);
          continue;
        }
        if (dryRun) virtualGateNext = next;
      }
      if (next !== e.gateQuarter) {
        const r = record({ ...a, decision: 'blocked', epoch: head.number,
          result: `gate would check Q${next}, plan says Q${e.gateQuarter}`,
          message: `the SWA has checked up to Q${next - 1}; this call would test Q${next}, not Q${e.gateQuarter}. Not sent.` }, 'warn');
        flagOnce(e.notBeforeMs, r, `Rehearsal step ${e.id} held: the gate is not where the plan expects`,
          `${r.message} If the plan is wrong, fix the runbook row and rebuild the schedule; if the chain is, ` +
            `catch the gate up by hand. The cranker keeps checking until the window closes at ${e.notAfter}.`);
        continue;
      }
    }

    const to = targets[e.contract];
    const data = calldataFor(e);
    const expectsRevert = e.expectParsed.kind === 'revert';
    let limit = gasLimit;
    let precheck = 'skipped: expected revert, sent as planned';
    if (!expectsRevert) {
      try {
        const est = await chain.estimateGas({ to, data });
        limit = (BigInt(est) * GAS_MULTIPLIER_TENTHS) / 10n;
        precheck = 'estimateGas ok';
      } catch (err) {
        if (isTransportFailure(err)) {
          stopReason = `the node did not answer eth_estimateGas (${err.shortMessage ?? err.code}); nothing was broadcast`;
          const r = record({ ...a, decision: 'failed', epoch: head.number, result: 'not sent', message: stopReason }, 'warn');
          flag(r, `Rehearsal step ${e.id} could not be sent`, stopReason);
          continue;
        }
        const v = classifyRevert(err);
        precheck = `node predicts revert ${v.reason ?? v.message}; sending anyway, as scheduled`;
      }
    }

    if (dryRun) {
      record({ ...a, decision: 'dry-run', epoch: head.number, result: 'would send',
        message: `to ${to}, gas ${limit}, pre-check: ${precheck}` });
      if (e.function === 'quarterlyGateCheck' && virtualGateNext !== null && e.expectParsed.kind !== 'revert') virtualGateNext += 1;
      continue;
    }

    // The window is checked again here: an earlier send's receipt wait can take a while.
    if (Math.max(clock(), chainMs) + SEND_MARGIN_MS >= e.notAfterMs) {
      record({ ...a, decision: 'too-late', epoch: head.number, result: 'not sent',
        message: `the window closes at ${e.notAfter}; too close to start a send` }, 'warn');
      continue;
    }

    let tx;
    try {
      tx = await chain.send({ to, data, gasLimit: limit });
    } catch (err) {
      stopReason = `step ${e.id} could not be broadcast (${err.shortMessage ?? err.message}); later steps wait for the next run`;
      const r = record({ ...a, decision: 'failed', epoch: head.number, result: 'not sent', message: stopReason }, 'warn');
      flag(r, `Rehearsal step ${e.id} could not be sent`, `${a.call}: ${err.shortMessage ?? err.message}`);
      continue;
    }
    log.info(`rehearsal step=${e.id} broadcast ${tx.hash} (gas ${limit}; ${precheck})`);

    let receipt;
    try {
      receipt = await chain.wait(tx, confirmations);
    } catch (err) {
      stopReason = `step ${e.id} was broadcast as ${tx.hash} but its receipt could not be read; it is not resent`;
      const r = record({ ...a, decision: 'sent', txHash: tx.hash, epoch: head.number, result: 'receipt unknown', message: stopReason }, 'warn');
      flag(r, `Rehearsal step ${e.id}: outcome unknown`, `${stopReason}. The next run reads the outcome; or check ${tx.hash} on an explorer.`);
      continue;
    }

    const req = { to, data, gasLimit: limit };
    const o = await readOutcome({ chain, entry: e, req, receipt, targets });
    const ok = matches(e, o);
    const r = record({
      ...a, decision: 'sent', txHash: tx.hash, epoch: o.epoch, result: describeOutcome(o), match: ok,
      revert: o.revert, revertSource: o.revertSource, exitCode: o.exitCode, gate: o.gate,
      gasLimit: String(limit), gasUsed: o.gasUsed, precheck,
      message: ok ? null : `expected ${e.expect}, got ${describeOutcome(o)}`,
    }, ok ? 'info' : 'warn');
    if (!ok) {
      flag(r, `Rehearsal step ${e.id} did not do what the plan expected`,
        `${r.call} was sent as scheduled (tx ${tx.hash}, epoch ${o.epoch}). The plan expected ${e.expect}; ` +
          `the chain says ${describeOutcome(o)}.`);
    }
  }

  return finish();

  function finish() {
    const next = upcoming[0] ?? null;
    if (next) log.info(`rehearsal next: step ${next.id} ${callLabel(next)} at ${next.notBefore} (expect ${next.expect})`);
    return {
      epoch: head.number,
      chainTime: new Date(chainMs).toISOString(),
      actions,
      next: next ? { id: next.id, call: callLabel(next), notBefore: next.notBefore, expect: next.expect } : null,
      needsPerson,
      exitCode: needsPerson.length ? 1 : 0,
    };
  }
}
