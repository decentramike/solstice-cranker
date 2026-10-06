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
import { CALLS, callLabel, REHEARSAL_CHAIN_ID, stepTag, TAG_MOD } from './schedule.mjs';

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

/** With an alert ledger, a problem is still alerted on the first run that sees it up to a day late. */
const ALERT_HORIZON_MS = 24 * 3_600_000;

/** After a dropped receipt wait: ask again this many times, this far apart. */
const RECEIPT_POLLS = 6;
const RECEIPT_POLL_MS = Number(process.env.CRANK_RECEIPT_POLL_MS || 10_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INTERFACES = Object.fromEntries(Object.entries(CALLS).map(([fn, c]) => [fn, new Interface(c.abi)]));
const SWA_IFACE = INTERFACES.quarterlyGateCheck;
const GATE_CALLDATA = SWA_IFACE.encodeFunctionData('quarterlyGateCheck', []).toLowerCase();

export const calldataFor = (entry) => INTERFACES[entry.function].encodeFunctionData(entry.function, entry.args);

/**
 * Every send carries its step in the last five digits of its gas limit: step 31 goes out with
 * 100,000,310, step 93.2 with 100,000,932 (stepTag, in schedule.mjs, where the schedule is checked
 * for two rows sharing a tag). quarterlyGateCheck() and a repeated submitShares(q) are
 * byte-identical, so nothing else on chain says which row the cranker meant; this does, without
 * touching the calldata, and it is readable on any explorer. The limit is first rounded up to a
 * whole million, so only a limit whose last six digits ARE a tag counts: a production estimate
 * x1.4 such as 60,100,310 is not read as step 31. The extra limit is under 1,100,000 gas, inside
 * Filecoin's 10% over-estimation allowance for these calls.
 */
const TAG_ROUND = 1_000_000n; // the limit is rounded up to a whole million, then the tag added
export const tagGasLimit = (limit, id) => ((BigInt(limit) + TAG_ROUND - 1n) / TAG_ROUND) * TAG_ROUND + stepTag(id);
export { stepTag };

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

    /** The last real block at or before `n`. Lotus has no state at a null round; its state is this one's. */
    async realBlockAtOrBefore(n) {
      for (let b = n; b >= 0 && b > n - MAX_NULL_WALK; b--) {
        const blk = await read(() => provider.getBlock(b), 'eth_getBlockByNumber');
        if (blk && blk !== NULL_ROUND) return b;
      }
      throw new Error(`no non-null block within ${MAX_NULL_WALK} epochs below ${n}`);
    },

    async gateState(swa, blockTag = 'latest') {
      const at = typeof blockTag === 'number' ? await chain.realBlockAtOrBefore(blockTag) : blockTag;
      const g = await readSwaGateState(provider, swa, at);
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
        const parent = await chain.realBlockAtOrBefore(Number(receipt.blockNumber) - 1);
        await provider.call({ from: address, to: req.to, data: req.data, gasLimit: req.gasLimit, blockTag: parent });
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
      if (!tx.receipt) return false; // mined, by the nonce, yet no receipt: do not guess its quarter
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
 * 1. The engine's own sends name their row in the gas limit (stepTag). A tag that names exactly
 *    one schedule row with the same call is final for any message that landed at or after that
 *    row opened -- even after its window closed, if it sat in the mpool.
 * 2. Anything else is someone else's send: a person's force_call, or production mode. It can only
 *    be credited by evidence. It may belong to any row with the same call whose window holds the
 *    block it landed in (for a gate check, only a row naming the quarter it tested, or none). It
 *    is credited to the row whose expectation its outcome fits, when exactly one does. Every other
 *    live row it could belong to is returned in `ambiguous` -- and so is the only candidate when
 *    its outcome does not fit. The engine holds those rows and tells a person. A wrong guess then
 *    costs a hold and an alert, never a second message and never a silent skip.
 *
 * Entries the runbook marks done take part, so a transaction sent for a Complete row is never
 * credited to a later step.
 *
 * @param {object[]} entries      the rows whose windows reach into the scan
 * @param {object[]} everyEntry   the whole schedule, for tags
 * @param {(tx, entry) => Promise<object|null>} outcomeOf  the decoded outcome of `tx`, or null
 * @returns {Promise<{sentFor: Map, ambiguous: Map}>}
 */
export async function assignSends(entries, txs, targets, outcomeOf = async () => null, everyEntry = entries) {
  const key = (to, data) => `${String(to).toLowerCase()}:${String(data).toLowerCase()}`;
  const ordered = [...entries].sort((a, b) => a.notBeforeMs - b.notBeforeMs || a.index - b.index);
  const keyOf = (e) => key(targets[e.contract], calldataFor(e));
  const keys = new Map([...everyEntry, ...ordered].map((e) => [e.id, keyOf(e)]));
  const sentFor = new Map();
  const ambiguous = new Map();
  const tagOf = (tx) => {
    if (tx.gasLimit === undefined || tx.gasLimit === null) return null;
    const low = BigInt(tx.gasLimit) % TAG_ROUND;
    return low < TAG_MOD ? low : null;
  };
  // Tagged transactions first: a tag is proof, and evidence must never take a row a tag names.
  const byProof = [...txs.filter((t) => tagOf(t) !== null && tagOf(t) !== 0n), ...txs.filter((t) => tagOf(t) === null || tagOf(t) === 0n)];
  for (const tx of byProof) {
    const k = key(tx.to, tx.data);
    const at = tx.timestamp * 1000;

    const tag = tagOf(tx);
    // At or after the row opened: the engine never sends early, so an older message with the same
    // tag is from some earlier schedule, not this row. No upper bound: a message that sat in the
    // mpool can land after its window and is still that row's.
    const own = tag === null || tag === 0n ? [] : everyEntry.filter((x) => keys.get(x.id) === k && stepTag(x.id) === tag && at >= x.notBeforeMs);
    if (own.length === 1) {
      if (!sentFor.has(own[0].id)) sentFor.set(own[0].id, tx);
      continue;
    }

    let candidates = ordered.filter(
      (x) =>
        !sentFor.has(x.id) &&
        keys.get(x.id) === k &&
        at >= x.notBeforeMs &&
        at < x.notAfterMs + MATCH_SLACK_MS &&
        (tx.testedQuarter === undefined || x.gateQuarter === null || x.gateQuarter === tx.testedQuarter)
    );
    if (candidates.length === 0) continue;
    if (tx.testedQuarter !== undefined) {
      const exact = candidates.filter((x) => x.gateQuarter === tx.testedQuarter);
      if (exact.length) candidates = exact;
    }
    const o = await outcomeOf(tx, candidates[0]);
    const fits = o ? candidates.filter((x) => matches(x, o)) : [];
    const credited = fits.length === 1 ? fits[0] : null;
    if (credited) sentFor.set(credited.id, tx);
    for (const x of candidates) {
      if (x !== credited && !x.done && !ambiguous.has(x.id)) ambiguous.set(x.id, tx);
    }
  }
  for (const id of sentFor.keys()) ambiguous.delete(id);
  return { sentFor, ambiguous };
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
 * @param {number} p.reportWindowMs  without an alert ledger, a problem is alerted on runs inside
 *                                   this long after it starts
 * @param {{has: Function, add: Function}} [p.alertState]  alert keys already sent, across runs
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
  /**
   * Alerts a problem once. With an alert ledger (p.alertState, carried between runs in the
   * Actions cache), "once" is exact: the first run that sees it after `anchorMs`, within a day.
   * Without one, it falls back to the runs inside [anchor, anchor + reportWindow).
   */
  const flagOnce = (anchorMs, a, title, body) => {
    if (dryRun || nowMs < anchorMs) return;
    const state = p.alertState;
    if (state) {
      const k = `${title}@${new Date(anchorMs).toISOString()}`;
      let seen;
      try {
        seen = state.has(k);
        if (!seen && nowMs < anchorMs + ALERT_HORIZON_MS) state.add(k);
      } catch {
        seen = undefined; // a broken ledger must never stop a run: fall back to the time window
      }
      if (seen === false) {
        if (nowMs < anchorMs + ALERT_HORIZON_MS) flag(a, title, body);
        return;
      }
      if (seen === true) return;
    }
    if (nowMs < anchorMs + reportWindowMs) flag(a, title, body);
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
  // Closed windows are looked at for one report window only. Looking further back would widen the
  // scan the send decisions rely on, so a problem reading an old row could hold a current send.
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
    // Deliberate, so not alerted -- but on the record, so a forgotten pause is visible in every run.
    for (const e of justClosed) {
      record({ ...base(e), decision: 'paused', epoch: head.number, result: 'window closed while paused',
        message: `its window closed at ${e.notAfter} while the cranker was paused (${pause.reason})` }, 'warn');
    }
    return finish();
  }

  // ---- what was already sent, and for which step ------------------------------------------
  // Scanned to the block before the head: on a load-balanced endpoint the next request can land
  // on a node one epoch behind, which refuses a query about a block it has not seen.
  let sentFor = new Map();
  let ambiguous = new Map();
  let ledger = { complete: true, missing: 0 };
  let nextNonce = null; // pinned on every send: if anything else used it first, the node refuses
  let inFlight = false;
  const tracked = [...eligible, ...closing, ...justClosed];
  if (tracked.length && cranker) {
    // Every row whose window reaches into the scan may claim a transaction, Complete rows included.
    // Each must see its OWN transaction, or it would claim a later row's identical one and that
    // row would be sent again. So the scan reaches back to the earliest such row's opening, and
    // again from there, until no row opens earlier. Windows are bounded, so this stops.
    let fromMs = Math.min(...tracked.map((e) => e.notBeforeMs));
    let claimants;
    for (;;) {
      claimants = schedule.entries.filter((e) => e.notAfterMs + MATCH_SLACK_MS > fromMs && e.notBeforeMs <= latestMs);
      const earliest = Math.min(...claimants.map((e) => e.notBeforeMs));
      if (earliest >= fromMs) break;
      fromMs = earliest;
    }
    const scanHead = { number: Math.max(0, head.number - 1), timestamp: await chain.timestampAt(Math.max(0, head.number - 1)) };
    const found = await findSentSince(chain, Math.floor(fromMs / 1000) - LOOKBACK_MARGIN_SECONDS, scanHead);
    ledger = found;
    // Anything newer than the scanned block -- landed in the head block, or still in the mpool -- is
    // a send the ledger has not seen. Try to read the head block too; if that fails, or a message
    // is still pending, hold every send until a later run can see it.
    if (ledger.complete) {
      try {
        const tail = await findSentSince(chain, scanHead.timestamp + 1, head);
        if (!tail.complete) throw new Error('head block incomplete');
        found.txs.push(...tail.txs.filter((t) => !found.txs.some((x) => x.hash === t.hash)));
        const atHead = await chain.nonceAt(head.number);
        // 'pending' covers the mpool; 'latest' covers a block that landed after the head was read.
        // Either one ahead of the scanned head is a send the ledger has not seen.
        inFlight = (await chain.nonceAt('pending')) > atHead || (await chain.nonceAt('latest')) > atHead;
        nextNonce = atHead;
      } catch {
        inFlight = true;
      }
    }
    if (ledger.complete && !(await resolveGateQuarters(chain, found.txs, targets.swa))) {
      ledger = { complete: false, missing: 0, reason: 'could not tell which quarter one of its gate checks tested' };
    }
    const outcomeOf = async (tx, entry) => {
      const receipt = tx.receipt ?? (await chain.receiptOf(tx.hash).catch(() => null));
      if (!receipt) return null;
      tx.receipt = receipt;
      return readOutcome({ chain, entry, req: { to: tx.to, data: tx.data, gasLimit: tx.gasLimit }, receipt, targets }).catch(() => null);
    };
    ({ sentFor, ambiguous } = await assignSends(claimants, found.txs, targets, outcomeOf, schedule.entries));
  }

  for (const e of justClosed) {
    const sent = sentFor.get(e.id);
    if (sent) {
      // A message that landed as its window closed -- it sat in the mpool -- was never checked by
      // the run that sent it. Check it now.
      if (sent.timestamp * 1000 >= e.notAfterMs - SEND_MARGIN_MS) {
        const r = { ...base(e), decision: 'already-sent', txHash: sent.hash, epoch: sent.blockNumber, result: 'sent earlier',
          message: 'landed as its window closed' };
        try {
          const receipt = sent.receipt ?? (await chain.receiptOf(sent.hash));
          if (receipt) {
            const o = await readOutcome({ chain, entry: e, req: { to: sent.to, data: sent.data, gasLimit: sent.gasLimit }, receipt, targets });
            Object.assign(r, { result: describeOutcome(o), match: matches(e, o) });
          }
        } catch {
          // the record says "sent earlier"; the outcome is on any explorer
        }
        record(r, r.match === false ? 'warn' : 'info');
        if (r.match === false) {
          flagOnce(sent.timestamp * 1000, r, `Rehearsal step ${e.id} did not do what the plan expected`,
            `${r.call} (tx ${sent.hash}, epoch ${sent.blockNumber}) expected ${e.expect}; the chain says ${r.result}.`);
        }
      }
      continue;
    }
    if (inFlight || ambiguous.has(e.id)) {
      // Its message may be in the mpool, or may be someone else's send we could not attribute.
      // "Send it by hand" would then be the wrong advice: it could spend a later step's check.
      const r = record({ ...base(e), decision: 'held', epoch: head.number, result: 'window closed; outcome not yet known',
        message: inFlight ? 'a cranker message is still pending; the next run will know' : 'a send in its window may have been this step' }, 'warn');
      // Not after the row was already reported missed: a message pending now is a later step's.
      let reportedMissed = false;
      try {
        reportedMissed = Boolean(p.alertState?.has(`Rehearsal step ${e.id} was not sent@${new Date(e.notAfterMs).toISOString()}`));
      } catch {
        // the ledger is for alerts only
      }
      if (cranker && ledger.complete && !reportedMissed) {
        flagOnce(e.notAfterMs, r, `Rehearsal step ${e.id}: window closed, outcome unknown`,
          `${r.message}. Check the cranker address on an explorer before any manual send: ` +
            'a second message could use up a later step\'s check.');
      }
      continue;
    }
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
  // The gate only moves forward. After one of this run's own gate checks lands, its event says where
  // the gate is; a load-balanced node one epoch behind must not make the next step look blocked.
  let gateFloor = null;
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
      if (r.match === false) {
        // The run that sent it alerted -- unless it was killed first. So say it again, once, from
        // the landing: a second email about a mismatch is cheaper than none.
        flagOnce(already.timestamp * 1000, r, `Rehearsal step ${e.id} did not do what the plan expected`,
          `${r.call} (tx ${already.hash}, epoch ${already.blockNumber}) expected ${e.expect}; the chain says ${r.result}. ` +
            'If the run that sent it already reported this, nothing is new.');
      }
      continue;
    }
    if (!ledger.complete) {
      record({ ...a, decision: 'held', epoch: head.number, result: 'not sent', message: 'ledger incomplete; see above' }, 'warn');
      continue;
    }
    const maybe = ambiguous.get(e.id);
    if (maybe) {
      const r = record({ ...a, decision: 'held', txHash: maybe.hash, epoch: maybe.blockNumber, result: 'possibly sent already',
        message: `${maybe.hash} (epoch ${maybe.blockNumber}) has this step's call but was not sent by the rehearsal ` +
          'cranker, and its outcome does not settle which row it was for; not sending this step on a guess' }, 'warn');
      flagOnce(maybe.timestamp * 1000, r, `Rehearsal step ${e.id} held: it may already have been sent`,
        `${r.message}. If ${maybe.hash} was not this step, send it by hand (Run workflow -> force_call).`);
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
    if (dryRun && e.function === 'quarterlyGateCheck' && virtualGateNext === null) {
      try {
        virtualGateNext = (await chain.gateState(targets.swa)).next;
      } catch {
        // the labelled check below reports it
      }
    }
    if (e.function === 'quarterlyGateCheck' && e.gateQuarter !== null) {
      let next = virtualGateNext;
      if (next === null) {
        try {
          next = Math.max((await chain.gateState(targets.swa)).next, gateFloor ?? 0);
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

    limit = tagGasLimit(limit, e.id);

    if (dryRun) {
      record({ ...a, decision: 'dry-run', epoch: head.number, result: 'would send',
        message: `to ${to}, gas ${limit}, pre-check: ${precheck}` });
      if (e.function === 'quarterlyGateCheck' && virtualGateNext !== null && e.expectParsed.kind !== 'revert') virtualGateNext += 1;
      continue;
    }

    // The window is checked again here: an earlier send's receipt wait can take a while.
    const nowAgain = clock();
    if (Math.max(nowAgain, chainMs + (nowAgain - nowMs)) + SEND_MARGIN_MS >= e.notAfterMs) {
      record({ ...a, decision: 'too-late', epoch: head.number, result: 'not sent',
        message: `the window closes at ${e.notAfter}; too close to start a send` }, 'warn');
      continue;
    }

    let tx;
    try {
      tx = await chain.send(nextNonce === null ? { to, data, gasLimit: limit } : { to, data, gasLimit: limit, nonce: nextNonce });
      if (nextNonce !== null) nextNonce += 1;
    } catch (err) {
      stopReason = `step ${e.id} could not be broadcast (${err.shortMessage ?? err.message}); later steps wait for the next run`;
      const r = record({ ...a, decision: 'failed', epoch: head.number, result: 'not sent', message: stopReason }, 'warn');
      flag(r, `Rehearsal step ${e.id} could not be sent`, `${a.call}: ${err.shortMessage ?? err.message}`);
      continue;
    }
    log.info(`rehearsal step=${e.id} broadcast ${tx.hash} (gas ${limit}; ${precheck})`);

    let receipt = null;
    try {
      receipt = await chain.wait(tx, confirmations);
    } catch {
      // The node dropped the wait. The message is out; keep asking for its receipt a while longer.
      for (let i = 0; i < RECEIPT_POLLS && !receipt; i++) {
        await sleep(p.receiptPollMs ?? RECEIPT_POLL_MS);
        receipt = await chain.receiptOf(tx.hash).catch(() => null);
      }
    }
    if (!receipt) {
      stopReason = `step ${e.id} was broadcast as ${tx.hash} but its receipt could not be read; it is not resent`;
      const r = record({ ...a, decision: 'sent', txHash: tx.hash, epoch: head.number, result: 'receipt unknown', message: stopReason }, 'warn');
      flag(r, `Rehearsal step ${e.id}: outcome unknown`,
        `${stopReason}. Check ${tx.hash} on an explorer and compare it with the plan (expect ${e.expect}). Later runs ` +
          'record its outcome in their run record but do not alert on it again.');
      continue;
    }

    const req = { to, data, gasLimit: limit };
    const o = await readOutcome({ chain, entry: e, req, receipt, targets });
    if (o.gate) gateFloor = Math.max(gateFloor ?? 0, o.gate.quarter + 1);
    const ok = matches(e, o);
    const r = record({
      ...a, decision: 'sent', txHash: tx.hash, epoch: o.epoch, result: describeOutcome(o), match: ok,
      revert: o.revert, revertSource: o.revertSource, exitCode: o.exitCode, gate: o.gate,
      gasLimit: String(limit), gasUsed: o.gasUsed, precheck,
      message: ok ? null : `expected ${e.expect}, got ${describeOutcome(o)}`,
    }, ok ? 'info' : 'warn');
    if (!ok) {
      // Anchored at the landing, as the next run's "found already sent" check is, so with an alert
      // ledger the two are one alert.
      const landedMs = (await chain.timestampAt(o.epoch).catch(() => Math.floor(nowMs / 1000))) * 1000;
      const title = `Rehearsal step ${e.id} did not do what the plan expected`;
      const body = `${r.call} was sent as scheduled (tx ${tx.hash}, epoch ${o.epoch}). The plan expected ${e.expect}; ` +
        `the chain says ${describeOutcome(o)}.`;
      try {
        p.alertState?.add(`${title}@${new Date(landedMs).toISOString()}`);
      } catch {
        // the ledger is for alerts only; a broken one changes nothing here
      }
      flag(r, title, body);
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
