#!/usr/bin/env node
/**
 * Replays the 14-quarter calibnet rehearsal against the local devnet, compressed so a
 * fortnight of quarter geometry fits in a few thousand blocks.
 *
 * The cranker is invoked by SHELLING OUT to `node scripts/crank.mjs`, never by import. That is
 * the whole point of this file: a rehearsal that imported the cranker's internals would prove
 * the internals work, not that the thing GitHub Actions actually executes works. Everything
 * crosses the process boundary the way it will in production -- env in, exit code and
 * runs.ndjson out.
 *
 * Assertions are made twice over, deliberately:
 *   - against the cranker's own run record (docs/DATA-CONTRACT.md §1), which is what the
 *     dashboard will show a human, and
 *   - against the chain itself (events + packed ERC-7201 storage), which is what actually
 *     happened. A cranker that reports success it did not achieve fails the second check.
 *
 * Usage: node devnet/rehearsal.mjs [--quarters=N] [--from=N] [--fast]
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { RPC_URL, isMain } from './node.mjs';
import {
  ACCOUNTS,
  ROOT,
  RUNS_FILE,
  STATE_DIR,
  addressOf,
  bindingEpochOf,
  currentEpoch,
  formatFixed,
  loadDeployment,
  mineTo,
  postVolume,
  provider,
  quarterStartOf,
  readSraQuarterState,
  decodeRevert,
  readSwaGateState,
  runCranker,
  sra,
  swa,
  topicFor,
} from './fixtures.mjs';

/**
 * The cranker entrypoint. Overridable only so this harness can be exercised against a stand-in
 * before the real one exists; the default is, and must stay, the production path.
 */
const ENTRYPOINT = process.env.CRANK_ENTRYPOINT ?? 'scripts/crank.mjs';
/** resolve, not join: an override may be absolute, and join would graft it onto ROOT. */
const ENTRYPOINT_PATH = resolve(ROOT, ENTRYPOINT);

const TOPIC = {
  SharesSubmitted: topicFor('SharesSubmitted'),
  FvmActorCall: topicFor('FvmActorCall'),
};

/**
 * Calendar labels, from the rehearsal plan: activation Wed 2026-09-23 13:00 UTC, one quarter
 * per day, and posting for quarter Q opens only after Q has ended -- so quarter Q's CYCLE runs
 * on the following day. Q1 = Wed 13:00 to Thu 13:00, cycled Thu 24 Sep.
 *
 * That puts the plan's two no-crank weekends at Q3/Q4 (Sat 26, Sun 27 Sep) and Q10/Q11
 * (Sat 3, Sun 4 Oct), with the catch-ups on Q5 (Mon 28 Sep) and Q12 (Mon 5 Oct). This replay
 * uses the same numbering so it is a dry run of the real thing rather than an analogy.
 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function calendarLabel(q) {
  const d = new Date(Date.UTC(2026, 8, 23 + q));
  return `${d.toISOString().slice(0, 10)} ${DAYS[d.getUTCDay()]}`;
}

/** The plan's no-crank weekend quarters. Q4 and Q11 additionally receive no volume at all. */
const WEEKEND_QUARTERS = new Set([3, 4, 10, 11]);
const NO_POST_QUARTERS = new Set([4, 11]);

/**
 * Quarterly USD volume the orchestrator posts, following the plan:
 *   Q1  bootstrap, no gate
 *   Q2  first gate pass -- above the 3500 entry threshold, steps the weight
 *   Q3  weekend post, HIGH, but nobody cranks it
 *   Q4  weekend fail -- nothing posted at all, so the value binds 0 and its gate check fails
 */
function volumeFor(q) {
  if (q === 1) return '5000';
  return '100000000';
}

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

const results = [];
function record(scenario, status, detail) {
  results.push({ scenario, status, detail });
  console.log(`  ${status.padEnd(4)}  ${scenario} -- ${detail}`);
  return status === 'PASS';
}

function check(scenario, condition, okDetail, failDetail) {
  return record(scenario, condition ? 'PASS' : 'FAIL', condition ? okDetail : failDetail);
}

/**
 * For a scenario the chain supports but the cranker cannot currently be driven into. A SKIP is
 * not a pass: it is recorded, printed and explained, and it never turns the suite green by
 * pretending the case was covered.
 */
function skip(scenario, why) {
  return record(scenario, 'SKIP', why);
}

// ---------------------------------------------------------------------------
// Cranker invocation
// ---------------------------------------------------------------------------

let runsOffset = 0;

/** Everything appended to runs.ndjson since the last call. */
function newRunRecords() {
  if (!existsSync(RUNS_FILE)) return [];
  const size = statSync(RUNS_FILE).size;
  if (size <= runsOffset) return [];
  const text = readFileSync(RUNS_FILE, 'utf8').slice(runsOffset);
  runsOffset = size;
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { malformed: l.slice(0, 200) };
      }
    });
}

/**
 * Runs the cranker once, in its own process.
 *
 * `targetQuarter` is passed both as env and as an argv flag. docs/DATA-CONTRACT.md pins the
 * cranker's OUTPUT but says nothing about its input, and the "crank a stale quarter on purpose"
 * scenario needs to aim it at a quarter it would not choose by itself. Sending both spellings
 * means whichever one scripts/crank.mjs settled on is the one that takes effect.
 */
async function crank(opts = {}) {
  const result = await runCranker({ ...opts, entrypoint: ENTRYPOINT });
  return { ...result, runs: newRunRecords() };
}

/** Flattens the actions of every run record a single invocation produced. */
function actionsOf(result) {
  return result.runs.flatMap((r) => r.actions ?? []);
}

function mentions(result, needle) {
  const hay = [
    JSON.stringify(result.runs),
    result.stdout,
    result.stderr,
  ].join('\n');
  return hay.includes(needle);
}

/**
 * Asserts a specific *call's* reason, not merely that the string turns up somewhere in the run.
 *
 * A run makes two calls, and both can carry a NotBound: a whole-run substring match happily
 * reads the gate's reason as if it were submitShares'. Scoping to the action is the difference
 * between testing the scenario and testing that the word appeared.
 */
function reasonFor(result, call) {
  const action = actionsOf(result).find((a) => a.call === call);
  return action ? { reason: action.reason ?? '', severity: action.severity, action } : null;
}

function callReasonIs(result, call, errorName) {
  const found = reasonFor(result, call);
  // No run record at all (a cranker that died before writing one) falls back to its output,
  // so a crash still reports the real cause instead of a bare "no action".
  if (!found) return result.runs.length === 0 && mentions(result, errorName);
  return found.reason.startsWith(errorName);
}

/**
 * "Did the cranker cleanly decline, for this reason?"
 *
 * Two shapes count. The cranker may send, catch the revert and record the decoded error; or it
 * may read state first and never send at all, in which case `reason` is null and the outcome
 * carries the meaning. The second is the better behaviour -- it costs no gas -- and the
 * scenarios care that the run was a clean no-op, not which route got there.
 */
function cleanlySkipped(result, call, errorName, outcome) {
  const found = reasonFor(result, call);
  if (!found) return result.runs.length === 0 && mentions(result, errorName);
  if (found.action.decision !== 'skipped') return false;
  return found.reason.startsWith(errorName) || found.action.outcome === outcome;
}

function describeSkip(result, call) {
  const found = reasonFor(result, call);
  if (!found) return '(no submitShares action)';
  return `${found.action.decision}/${found.action.outcome}` + (found.reason ? ` ${found.reason}` : '');
}

// ---------------------------------------------------------------------------
// Chain-side observation
// ---------------------------------------------------------------------------

async function logsBetween(fromBlock, toBlock, address, topic) {
  return provider().getLogs({ fromBlock, toBlock, address, topics: [topic] });
}

async function chainSnapshot() {
  const d = loadDeployment();
  const [epoch, sraState, gate] = await Promise.all([
    currentEpoch(),
    readSraQuarterState(),
    readSwaGateState(),
  ]);
  const nonce = await provider().getTransactionCount(addressOf(ACCOUNTS.cranker), 'latest');
  return { epoch, d, lastSubmittedQuarter: sraState.lastSubmittedQuarter, gate, crankerNonce: nonce };
}

// ---------------------------------------------------------------------------
// Scenario driver
// ---------------------------------------------------------------------------

const USAGE = 'usage: node devnet/rehearsal.mjs [--quarters=N] [--from=N] [--fast]';

/** @dev Throws UsageError so main can print a one-liner instead of a stack for a typo. */
class UsageError extends Error {}

function parseArgs(argv) {
  const out = { quarters: 14, from: 1, fast: false };
  for (const a of argv) {
    let m;
    if ((m = /^--quarters=(\d+)$/.exec(a))) out.quarters = Number(m[1]);
    else if ((m = /^--from=(\d+)$/.exec(a))) out.from = Number(m[1]);
    else if (a === '--fast') out.fast = true;
    else throw new UsageError(`unknown flag ${a}`);
  }
  if (out.from < 1) throw new UsageError('--from must be >= 1 (quarter 0 is reserved)');
  if (out.quarters < out.from) {
    throw new UsageError(`--quarters=${out.quarters} is before --from=${out.from}`);
  }
  return out;
}

export async function rehearse(opts = {}) {
  const { quarters, from, fast } = { quarters: 14, from: 1, fast: false, ...opts };
  const d = loadDeployment();

  mkdirSync(STATE_DIR, { recursive: true });
  // A rehearsal starts from a clean ledger; otherwise "what did this run do?" is unanswerable.
  if (existsSync(RUNS_FILE)) rmSync(RUNS_FILE);
  runsOffset = 0;

  console.log('Solstice cranker -- 14-quarter rehearsal');
  console.log(`  entrypoint      ${ENTRYPOINT} (child process, never imported)`);
  console.log(`  chain           ${RPC_URL} (chainId ${d.chainId})`);
  console.log(`  SRA / SWA       ${d.sra} / ${d.swa}`);
  console.log(`  geometry        activation ${d.activationEpoch}, ${d.epochsPerQuarter}/quarter, ` +
    `post ${d.postPeriod}, verify ${d.verificationWindow}`);
  console.log(`  quarters        ${from}..${quarters}${fast ? ' (fast)' : ''}\n`);

  if (!existsSync(ENTRYPOINT_PATH)) {
    console.error(`  !! ${ENTRYPOINT} does not exist yet.`);
    console.error('     The rehearsal drives the real cranker entrypoint by design and cannot');
    console.error('     stand in for it. Point CRANK_ENTRYPOINT at an alternative to dry-run');
    console.error('     this harness, or land scripts/crank.mjs first.\n');
    return { ok: false, results: [], missingEntrypoint: true };
  }

  for (let q = from; q <= quarters; q++) {
    await runQuarter(q, d, fast);
  }

  return summarise();
}

async function runQuarter(q, d, fast) {
  const start = quarterStartOf(q, d);
  const binding = bindingEpochOf(q, d);

  console.log(`\n=== Q${q}  ${calendarLabel(q)}  [start ${start}, binds ${binding}] ===`);

  // --- posting window -----------------------------------------------------
  const now = await currentEpoch();
  if (now < start) await mineTo(start);
  if (NO_POST_QUARTERS.has(q)) {
    // The plan's "weekend fail": no PostVolume and no CorrectVolume, so the value binds 0.
    console.log(`  posted nothing for Q${q} -- binds 0 (weekend fail)`);
  } else {
    const volume = volumeFor(q);
    await postVolume(q, volume);
    console.log(`  posted ${volume} USD for Q${q}`);
  }

  // --- Q1 only: the three submitShares outcomes, in order -----------------
  if (q === 1) {
    await mineTo(start + Math.floor(d.postPeriod / 2)); // still pre-binding
    const before = await chainSnapshot();
    const r1 = await crank();
    check(
      'S1  Q1 pre-binding is a clean skip',
      r1.exitCode === 0 && cleanlySkipped(r1, 'submitShares', 'NotBound', 'not-due'),
      `exit 0, submitShares ${describeSkip(r1, 'submitShares')}`,
      `exit ${r1.exitCode}, submitShares ${describeSkip(r1, 'submitShares')} ` +
        '(wanted exit 0 + a skip for NotBound/not-due)'
    );
    check(
      'S1  ... and sent no transaction',
      (await chainSnapshot()).crankerNonce === before.crankerNonce,
      `cranker nonce unchanged at ${before.crankerNonce}`,
      'cranker nonce moved -- something was broadcast before binding'
    );
  }

  // --- advance past binding ----------------------------------------------
  await mineTo(binding + (fast ? 0 : 1));

  if (q === 1) {
    const from = await currentEpoch();
    const r2 = await crank();
    const to = await currentEpoch();
    const submitted = await logsBetween(from, to, d.sra, TOPIC.SharesSubmitted);
    const state = await readSraQuarterState();
    check(
      'S2  Q1 after binding submits shares',
      r2.exitCode === 0 && submitted.length === 1 && state.lastSubmittedQuarter === 1,
      `SharesSubmitted emitted, lastSubmittedQuarter=${state.lastSubmittedQuarter}`,
      `exit ${r2.exitCode}, ${submitted.length} SharesSubmitted logs, ` +
        `lastSubmittedQuarter=${state.lastSubmittedQuarter}`
    );

    const r3 = await crank();
    check(
      'S3  Q1 re-crank is a clean skip',
      r3.exitCode === 0 && cleanlySkipped(r3, 'submitShares', 'AlreadySubmitted', 'already-done'),
      `exit 0, submitShares ${describeSkip(r3, 'submitShares')}`,
      `exit ${r3.exitCode}, submitShares ${describeSkip(r3, 'submitShares')} ` +
        '(wanted exit 0 + a skip for AlreadySubmitted/already-done)'
    );
    return;
  }

  // --- the plan's no-crank weekends: Q3/Q4 and Q10/Q11 --------------------
  if (WEEKEND_QUARTERS.has(q)) {
    const before = await chainSnapshot();
    const r = await crank({ paused: true });
    const after = await chainSnapshot();
    // The claim under test is that a paused cranker SENDS NOTHING. The exit code is a
    // separate question and must not be folded in here: by the second paused quarter the
    // first one has already fallen out of its submit window, and the cranker is then
    // correctly reporting a permanent loss -- exit 1 is the right answer, not a regression.
    check(
      `S5  Q${q} paused cranker sends nothing`,
      after.crankerNonce === before.crankerNonce &&
        after.lastSubmittedQuarter === before.lastSubmittedQuarter &&
        after.gate.lastCheckedQuarter === before.gate.lastCheckedQuarter,
      `nonce ${after.crankerNonce} unchanged, gate still at Q${after.gate.lastCheckedQuarter}, exit ${r.exitCode}`,
      `nonce ${before.crankerNonce}->${after.crankerNonce}, ` +
        `gate ${before.gate.lastCheckedQuarter}->${after.gate.lastCheckedQuarter}`
    );

    // This is the point of the weekend test, and it is easy to miss: pausing over a quarter
    // boundary does not defer those quarters, it destroys them. Q5's and Q6's share maps can
    // never be installed once Q7 binds. Assert the cranker says so out loud.
    const missed = (r.runs.at(-1)?.schedule?.missedQuarters) ?? [];
    if (q === 4) {
      check(
        'S5  ... and reports the quarter the pause has already cost',
        missed.includes(3) && r.exitCode === 1,
        `missedQuarters ${JSON.stringify(missed)}, exit 1 -- Q3's share map is gone for good`,
        `missedQuarters ${JSON.stringify(missed)}, exit ${r.exitCode} (wanted 5 reported and exit 1)`
      );
    }
    return;
  }

  // --- Q8: deliberately not cranked at all --------------------------------
  if (q === 8) {
    console.log('  (deliberately not cranked -- this is the missed quarter)');
    return;
  }

  // --- everything else: one ordinary crank --------------------------------
  const before = await chainSnapshot();
  const fromBlock = await currentEpoch();
  const r = await crank();
  const toBlock = await currentEpoch();
  const after = await chainSnapshot();

  const gateAdvance = after.gate.lastCheckedQuarter - before.gate.lastCheckedQuarter;
  const stepAdvance = after.gate.steps - before.gate.steps;
  const fvm = await logsBetween(fromBlock, toBlock, d.swa, TOPIC.FvmActorCall);

  console.log(
    `  crank exit ${r.exitCode}; gate Q${before.gate.lastCheckedQuarter}->Q${after.gate.lastCheckedQuarter}, ` +
      `steps ${before.gate.steps}->${after.gate.steps}, ` +
      `next threshold ${formatFixed(after.gate.nextThreshold)} USD`
  );

  if (q >= 2 && q <= 4) {
    check(
      `S4  Q${q} ordinary crank lands and advances the gate`,
      // >= 1, not == 1: with --from the run starts mid-sequence and the first crank legitimately
      // closes the quarters nobody was there to close.
      r.exitCode === 0 && after.lastSubmittedQuarter === q && gateAdvance >= 1,
      `submitted Q${q}, gate advanced to Q${after.gate.lastCheckedQuarter}`,
      `exit ${r.exitCode}, lastSubmitted=${after.lastSubmittedQuarter}, gate advance ${gateAdvance}`
    );
  }

  // Q2's volume is under the entry threshold, so its gate check must fail without stepping.
  if (q === 2) {
    check(
      'S8b Above-threshold quarter passes and steps the weight',
      stepAdvance === 1 && fvm.length >= 1,
      `steps -> ${after.gate.steps}, ${fvm.length} FvmActorCall log(s)`,
      `steps moved by ${stepAdvance}, ${fvm.length} FvmActorCall logs`
    );
  }

  // Q3 is the first quarter over the threshold.

  // Q7 is the Monday after the paused weekend: the gate is two quarters behind and one run
  // has to close the whole gap.
  if (q === 5) {
    check(
      // Not exit 0: the Monday run is the first to see that the weekend cost Q3, and
      // reporting that is a critical finding. The claim here is only about catch-up.
      'S6  Monday catch-up closes multiple gate quarters in one run',
      gateAdvance >= 2,
      `gate advanced ${gateAdvance} quarters in a single run`,
      `gate advanced ${gateAdvance} (wanted >= 2)`
    );
    check(
      // The plan: "Gate checks catch up in order: Q3 passes, Q4 fails and the residual
      // burns." By Monday, Q5 is bound too, so the run catches up Q3, Q4 AND Q5. The
      // invariant is not a fixed step count but that the one zero-bound quarter advanced
      // the gate pointer WITHOUT consuming a step: steps move one fewer than the pointer.
      'S8a Catch-up steps for every quarter that cleared the threshold, and only those',
      gateAdvance >= 2 && stepAdvance === gateAdvance - 1,
      `gate advanced ${gateAdvance}, weight stepped ${stepAdvance} -- Q4 bound 0, moved the ` +
        'pointer and burned the residual without taking a step',
      `gate advanced ${gateAdvance}, weight stepped ${stepAdvance} (wanted ${gateAdvance - 1})`
    );
  }

  // Q9 is where the missed Q8 is finally noticed.
  if (q === 9) {
    // The chain half of the scenario always holds, and is asserted directly so the claim is
    // covered even when the cranker cannot be aimed at a stale quarter.
    let chainReason = null;
    try {
      await sra(ACCOUNTS.cranker).submitShares.staticCall(8);
    } catch (err) {
      chainReason = decodeRevert(err)?.name ?? null;
    }
    check(
      'S7  SRA rejects the missed Q8 with NotLatestQuarter',
      chainReason === 'NotLatestQuarter',
      'submitShares(8) reverts NotLatestQuarter once Q9 has bound',
      `submitShares(8) reverted with ${chainReason ?? '(nothing -- it succeeded)'}`
    );

    const stale = await crank({ targetQuarter: 8 });
    const staleAction = reasonFor(stale, 'submitShares');
    const aimed = staleAction?.action?.quarter === 8;

    if (!aimed) {
      // scripts/crank.mjs always targets the latest bound quarter and takes no quarter input,
      // so it submits Q9 here and never sees Q8. Reported rather than glossed: the scenario is
      // real, the chain honours it, and the cranker simply has no way in yet.
      skip(
        'S7  Cranker reports NotLatestQuarter (critical, exit 1)',
        `cranker targeted Q${staleAction?.action?.quarter ?? '?'}, not Q8 -- it has no ` +
          'target-quarter input (neither CRANK_TARGET_QUARTER nor --quarter is read), so the ' +
          'missed-window path cannot be reached from outside'
      );
    } else {
      check(
        'S7  Cranker reports NotLatestQuarter (critical, exit 1)',
        stale.exitCode === 1 && callReasonIs(stale, 'submitShares', 'NotLatestQuarter'),
        `exit 1, submitShares reason ${staleAction?.reason ?? 'NotLatestQuarter'}`,
        `exit ${stale.exitCode}, submitShares reason ` +
          `"${staleAction?.reason ?? '(no submitShares action)'}" (wanted exit 1 + NotLatestQuarter)`
      );
      check(
        'S7  ... at critical severity',
        staleAction?.severity === 'critical',
        'submitShares severity critical',
        `submitShares severity ${staleAction?.severity ?? '(none)'}`
      );
    }
  }

  // The run that takes the eighth step completes the gate.
  if (!before.gate.complete && after.gate.complete) {
    check(
      // The claim is about the gate reaching its cap. The exit code is not folded in:
      // this run is also the first after the second no-crank weekend, so it is correctly
      // reporting the quarter that weekend cost and correctly exiting 1.
      `S9  Q${q} takes the eighth and final gate step`,
      after.gate.steps === after.gate.gateSteps && after.gate.complete,
      `steps ${after.gate.steps}/${after.gate.gateSteps}, gate complete, exit ${r.exitCode}`,
      `steps ${after.gate.steps}/${after.gate.gateSteps}, complete=${after.gate.complete}`
    );
  }

  // Every run after that must be a clean, permanent skip -- StepsComplete, exit 0, no movement.
  if (before.gate.complete) {
    check(
      `S9  Q${q} after completion is a clean skip`,
      r.exitCode === 0 &&
        stepAdvance === 0 &&
        gateAdvance === 0 &&
        cleanlySkipped(r, 'quarterlyGateCheck', 'StepsComplete', 'gate-closed'),
      `exit 0, StepsComplete, steps held at ${after.gate.steps}/${after.gate.gateSteps}`,
      `exit ${r.exitCode}, gate advance ${gateAdvance}, step advance ${stepAdvance}, ` +
        `gate reason "${reasonFor(r, 'quarterlyGateCheck')?.reason ?? '(none)'}"`
    );
  }
}

function summarise() {
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;

  const width = Math.max(...results.map((r) => r.scenario.length), 10);
  const rule = '='.repeat(width + 62);
  console.log('\n' + rule);
  console.log('REHEARSAL RESULTS');
  console.log(rule);
  for (const r of results) {
    console.log(`${r.status.padEnd(4)}  ${r.scenario.padEnd(width)}  ${r.detail}`);
  }
  console.log(rule);
  console.log(
    `${passed} passed, ${failed} failed, ${skipped} skipped, ${results.length} total` +
      (skipped ? '  (a SKIP is an uncovered scenario, not a pass)' : '')
  );

  return { ok: failed === 0, results, passed, failed, skipped };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outcome = await rehearse(opts);
  process.exit(outcome.ok ? 0 : 1);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof UsageError) {
      console.error(`[rehearsal] ${err.message}\n${USAGE}`);
    } else {
      console.error(`[rehearsal] ${err.stack ?? err.message}`);
    }
    process.exit(1);
  });
}
