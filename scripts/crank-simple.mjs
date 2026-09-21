#!/usr/bin/env node
/**
 * The simple cranker.
 *
 * Fires both quarterly calls on a clock and nothing else. It reads no contract state: no
 * storage slots, no aggregatedFilecoinPayVolume, no quarterStart, no gate, not even a
 * simulation. Every quarter boundary is arithmetic over four numbers that are already in
 * config/networks.json, anchored to the chain's genesis timestamp.
 *
 *     bindingTime(Q) = genesisUnix
 *                    + (activationEpoch + Q * epochsPerQuarter + postPeriod + verificationWindow)
 *                      * epochSeconds
 *
 * When the clock says quarter Q is bound, it sends submitShares(Q) and quarterlyGateCheck().
 * That is the whole program.
 *
 * WHY THIS EXISTS, next to scripts/crank.mjs:
 *
 * The main cranker reads chain state to decide precisely what is due, which makes it
 * accurate, quiet, and gas-free when nothing is due -- and gives it more ways to be stopped
 * by an RPC that will not answer a read. This one cannot be stopped that way, because it
 * never asks. If the read path is degraded but writes still land, this still cranks.
 *
 * WHAT YOU GIVE UP, honestly:
 *
 *   - It burns gas on reverts. Not simulating first means a call that is not due costs a
 *     reverted transaction instead of nothing. At Filecoin gas prices that is a rounding
 *     error, but it is not zero.
 *   - It cannot tell you a quarter was lost. That detection needs lastSubmittedQuarter,
 *     which is a chain read. Use the watchdog, or the main cranker, for that.
 *   - It trusts config completely. If postPeriod or verificationWindow is wrong for the
 *     deployment, it sends at the wrong time and the reverts are its only feedback.
 *
 * So: this is the fallback and the belt-and-braces option, not the default. Run both if you
 * like -- these calls are permissionless and idempotent, and the second sender simply gets
 * AlreadySubmitted.
 */
import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers';

import sraAbi from '../abi/ServiceRewardsActor.json' with { type: 'json' };
import swaAbi from '../abi/StreamWeightActor.json' with { type: 'json' };
import { loadConfig, resolvePause, NETWORKS } from '../src/config.mjs';
import { classifyRevert } from '../src/errors.mjs';
import { log, persistRun, writeJobSummary } from '../src/logger.mjs';

/**
 * How long after a quarter binds the cranker keeps trying, in hours.
 *
 * Wider than one hour on purpose. The cron fires hourly, so a single missed run -- a GitHub
 * incident, a slow runner, a rate-limited RPC -- would otherwise lose the quarter outright.
 * Inside the window a call that already landed just reverts AlreadySubmitted, which costs a
 * little gas and nothing else. The whole window sits inside the one-quarter deadline.
 */
const DEFAULT_WINDOW_HOURS = 6;

const iso = (unix) => new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Wall-clock second at which quarter q's volumes bind and submitShares(q) becomes callable. */
function bindingTime(net, q) {
  const epoch =
    net.activationEpoch + q * net.epochsPerQuarter + net.postPeriod + net.verificationWindow;
  return net.genesisUnix + epoch * net.epochSeconds;
}

/**
 * The latest quarter bound at `now`, or null before the first one.
 *
 * Binding is monotonic in q, so this is a direct calculation rather than a search. Quarter 0
 * is never submittable -- the SRA rejects it -- so the floor is 1.
 */
function dueQuarterAt(net, now) {
  const first = bindingTime(net, 1);
  if (now < first) return null;
  const quarterSeconds = net.epochsPerQuarter * net.epochSeconds;
  return 1 + Math.floor((now - first) / quarterSeconds);
}

async function main() {
  const wantsKey = !process.env.CRANK_DRY_RUN;
  const config = loadConfig(process.env, { requireKey: wantsKey });
  const net = NETWORKS[config.networkName];

  if (net.genesisUnix === null || net.genesisUnix === undefined) {
    throw new Error(
      `${config.networkName} has no genesisUnix in config/networks.json, so its epochs are ` +
        'not wall-clock time. The simple cranker only works on a real Filecoin network; ' +
        'use scripts/crank.mjs against the devnet.'
    );
  }

  // `|| DEFAULT`, not `?? DEFAULT`: an undefined GitHub Actions variable arrives as the
  // empty string, and Number('') is 0, which would fail the check below on every run.
  const windowHours = Number(process.env.CRANK_SIMPLE_WINDOW_HOURS || DEFAULT_WINDOW_HOURS);
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error(`CRANK_SIMPLE_WINDOW_HOURS must be a positive number, got ${windowHours}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const q = dueQuarterAt(net, now);

  log.section(`Solstice cranker (simple) -- ${config.label}`);

  // The pause is honoured here too, even though this cranker ignores every other condition.
  // CRANK_PAUSED and CRANK_DISABLED_DAYS are not conditions to be clever about -- they are a
  // person having decided the cranker must not send. The rehearsal's Q3/Q4 and Q10/Q11
  // scenarios depend on exactly that, and a "simple" cranker that quietly overrode it would
  // invalidate them with no warning.
  const pause = resolvePause(new Date());
  if (pause.paused) {
    log.warn(`paused: ${pause.reason}; sending nothing`);
    return report({ config, now, q, actions: [], exitCode: 0 });
  }

  if (q === null) {
    log.info('no quarter has bound yet', {
      firstBinds: iso(bindingTime(net, 1)),
      inHours: ((bindingTime(net, 1) - now) / 3600).toFixed(1),
    });
    return report({ config, now, q: null, actions: [], exitCode: 0 });
  }

  const boundAt = bindingTime(net, q);
  const closesAt = boundAt + windowHours * 3600;
  const expiresAt = bindingTime(net, q + 1);

  log.info('clock', {
    quarter: q,
    boundAt: iso(boundAt),
    sendWindowEnds: iso(closesAt),
    deadline: iso(expiresAt),
  });

  if (now >= closesAt) {
    // Past this run's window but still inside the deadline: the next quarter's window will
    // pick up whatever is outstanding, because submitShares only ever takes the latest.
    log.info(`quarter ${q} bound ${((now - boundAt) / 3600).toFixed(1)}h ago, outside the ` +
      `${windowHours}h send window -- nothing to do this run`);
    return report({ config, now, q, actions: [], exitCode: 0 });
  }

  // ---- send, without asking the chain anything first ------------------------
  const provider = new JsonRpcProvider(config.rpcUrl, Number(config.chainId), {
    staticNetwork: true,
    batchMaxCount: 1,
    cacheTimeout: -1, // never reuse a cached nonce between the two sends
  });

  if (config.dryRun) {
    log.warn(`CRANK_DRY_RUN is set: would send submitShares(${q}) and quarterlyGateCheck()`);
    return report({
      config, now, q, exitCode: 0,
      actions: [
        { call: 'submitShares', quarter: q, decision: 'dry-run', outcome: 'landed', reason: null, txHash: null, gasUsed: null, severity: 'info', message: 'would send' },
        { call: 'quarterlyGateCheck', quarter: null, decision: 'dry-run', outcome: 'landed', reason: null, txHash: null, gasUsed: null, severity: 'info', message: 'would send' },
      ],
    });
  }

  const wallet = new Wallet(config.privateKey, provider);
  const sra = new Contract(config.addresses.sra, sraAbi, wallet);
  const swa = new Contract(config.addresses.swa, swaAbi, wallet);

  const actions = [];
  actions.push(await send('submitShares', () => sra.submitShares(q), q, config));
  actions.push(await send('quarterlyGateCheck', () => swa.quarterlyGateCheck(), null, config));

  // Balance is the one read worth attempting, because running dry is the failure that
  // silently ends everything. It is best-effort: never allowed to affect the outcome.
  let balanceFil = null;
  try {
    balanceFil = formatEther(await provider.getBalance(wallet.address));
    if (balanceFil !== null && Number(balanceFil) < Number(config.minBalanceFil)) {
      log.warn('wallet is low on gas', { balance: balanceFil, threshold: config.minBalanceFil });
    }
  } catch {
    log.warn('balance read failed; ignoring');
  }

  // Only a send that never reached the chain is a failure. A revert is an answer: this
  // cranker deliberately does not know whether a call was due, so "already done" and "not
  // yet" are both expected and both fine.
  const exitCode = actions.some((a) => a.decision === 'failed') ? 1 : 0;
  return report({ config, now, q, actions, exitCode, balanceFil, cranker: wallet.address });
}

/** Sends one call and turns whatever comes back into an action record. */
async function send(name, fn, quarter, config) {
  const label = quarter === null ? `${name}()` : `${name}(${quarter})`;
  try {
    const tx = await fn();
    log.info(`${label}: broadcast`, { tx: tx.hash });
    const receipt = await tx.wait(config.confirmations);

    if (receipt.status === 1) {
      log.info(`${label}: landed`, { block: receipt.blockNumber, gas: String(receipt.gasUsed) });
      return action(name, quarter, 'sent', 'landed', null, tx.hash, String(receipt.gasUsed), 'info',
        `landed in block ${receipt.blockNumber}`);
    }

    log.info(`${label}: reverted on chain, which usually just means it was not due`);
    return action(name, quarter, 'skipped', 'not-due', null, tx.hash, String(receipt.gasUsed), 'info',
      `reverted in block ${receipt.blockNumber}; this cranker sends without checking, so a ` +
      'revert is the normal answer when the call was not due');
  } catch (err) {
    const verdict = classifyRevert(err);

    // A reverted send is expected here and is not a failure. The one exception is the
    // revert that means a quarter is gone, which is worth shouting about even though this
    // cranker could not have known in advance.
    if (verdict.name && verdict.kind !== 'fault') {
      const critical = verdict.kind === 'critical';
      (critical ? log.error : log.info)(`${label}: ${verdict.message}`);
      return action(name, quarter, critical ? 'failed' : 'skipped', verdict.outcome, verdict.reason,
        null, null, verdict.severity, verdict.message);
    }

    log.error(`${label}: could not send -- ${verdict.message}`);
    return action(name, quarter, 'failed', 'error', verdict.reason, null, null, 'critical',
      verdict.message);
  }
}

const action = (call, quarter, decision, outcome, reason, txHash, gasUsed, severity, message) =>
  ({ call, quarter, decision, outcome, reason, txHash, gasUsed, severity, message });

function report({ config, now, q, actions, exitCode, balanceFil = null, cranker = null }) {
  const record = {
    runId: `${new Date().toISOString()}-simple`,
    mode: 'simple',
    startedAt: new Date(now * 1000).toISOString(),
    finishedAt: new Date().toISOString(),
    network: config.networkName,
    chainId: Number(config.chainId),
    epoch: null, // deliberately not read
    cranker,
    balanceFil,
    actions,
    schedule: { submitDueQuarter: q },
    exitCode,
  };

  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  persistRun(record);

  writeJobSummary(
    [
      `### Solstice crank (simple) — ${config.networkName}`,
      '',
      q === null ? 'No quarter has bound yet.' : `Quarter **${q}**`,
      '',
      ...(actions.length
        ? ['| call | result | detail |', '|---|---|---|',
           ...actions.map((a) => `| ${a.call}${a.quarter === null ? '' : `(${a.quarter})`} | ${a.decision} | ${a.message} |`)]
        : ['Nothing to send this run.']),
    ].join('\n')
  );

  process.exitCode = exitCode;
}

try {
  await main();
} catch (err) {
  log.error('simple cranker aborted', { error: err.message });
  process.exitCode = 1;
}
