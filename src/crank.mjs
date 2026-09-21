/**
 * The crank.
 *
 * Deterministic timing decides *what* to send and *when*: the schedule in schedule.mjs is
 * computed from the quarter geometry and the contracts' own progress counters, and that is
 * what drives the run.
 *
 * Two cheap safety nets sit around it, neither of which changes the timing:
 *
 *   1. A free eth_call before every broadcast. If the call would revert, nothing is sent
 *      and no gas is burnt. This is a gas guard, not a scheduler.
 *   2. One probe of the chain's own view of the latest bound quarter. POST_PERIOD and
 *      VERIFICATION_WINDOW are private immutables upstream, so the computed schedule rests
 *      on config that cannot be verified any other way. If config and chain disagree, the
 *      chain wins and the discrepancy is alerted -- a wrong config then costs an email
 *      rather than a quarter's share map.
 */
import { randomBytes } from 'node:crypto';

import { AlertSink } from './alerts/index.mjs';
import {
  connect,
  currentEpoch,
  hasCode,
  observeLatestBoundQuarter,
  readBalance,
  readChainGeometry,
  readSraQuarterState,
  readSwaGateState,
} from './chain.mjs';
import { classifyRevert, isTransportFailure } from './errors.mjs';
import { resolvePause } from './config.mjs';
import { log, persistRun } from './logger.mjs';
import { bindingEpoch, buildSchedule, compareWithChain, epochsToDuration, expiryEpoch } from './schedule.mjs';

/** Filecoin gas estimation runs tight; a little headroom is cheaper than a stuck quarter. */
const GAS_LIMIT_MULTIPLIER = 14n; // /10

function newRunId() {
  return `${new Date().toISOString()}-${randomBytes(2).toString('hex')}`;
}

function explorerUrl(config, txHash) {
  return config.explorerTxUrl && txHash ? `${config.explorerTxUrl}${txHash}` : null;
}

/**
 * Simulates, then sends.
 *
 * @returns an action record shaped by docs/DATA-CONTRACT.md
 */
async function attempt({ contract, method, args = [], call, quarter, config, ctx }) {
  const label = quarter === null || quarter === undefined ? `${call}()` : `${call}(${quarter})`;
  const fn = contract.getFunction(method);

  // ---- 1. simulate (free) --------------------------------------------------
  try {
    await fn.staticCall(...args);
  } catch (err) {
    if (isTransportFailure(err)) throw err;
    const verdict = classifyRevert(err);
    const severity = verdict.severity;
    (severity === 'critical' ? log.error : severity === 'warn' ? log.warn : log.info)(
      `${label}: ${verdict.message}`
    );
    return {
      call,
      quarter: quarter ?? null,
      decision: verdict.kind === 'critical' || verdict.kind === 'fault' ? 'failed' : 'skipped',
      outcome: verdict.outcome,
      reason: verdict.reason,
      txHash: null,
      gasUsed: null,
      severity,
      message: verdict.message,
    };
  }

  if (config.dryRun) {
    log.info(`${label}: would send (dry run)`);
    return {
      call, quarter: quarter ?? null, decision: 'dry-run', outcome: 'landed',
      reason: null, txHash: null, gasUsed: null, severity: 'info',
      message: 'simulation succeeded; not broadcast because CRANK_DRY_RUN is set',
    };
  }

  // ---- 2. broadcast --------------------------------------------------------
  try {
    let overrides = {};
    try {
      const estimate = await fn.estimateGas(...args);
      overrides.gasLimit = (estimate * GAS_LIMIT_MULTIPLIER) / 10n;
    } catch (err) {
      // Estimation is a convenience; the node can still price the message itself.
      log.debug('gas estimation failed, letting the node decide', { error: err.shortMessage ?? err.message });
    }

    const tx = await fn(...args, overrides);
    log.info(`${label}: broadcast`, { tx: tx.hash });

    const receipt = await tx.wait(config.confirmations);

    if (receipt.status === 1) {
      log.info(`${label}: landed`, { block: receipt.blockNumber, gas: String(receipt.gasUsed) });
      return {
        call, quarter: quarter ?? null, decision: 'sent', outcome: 'landed',
        reason: null, txHash: tx.hash, gasUsed: String(receipt.gasUsed),
        severity: 'info', message: `landed in block ${receipt.blockNumber}`,
      };
    }

    // Simulation passed but the transaction reverted, so the state moved underneath us
    // between the call and the send. The common cause is benign: somebody else cranked
    // first. Ask the chain before deciding this is a problem.
    const raced = await didSomeoneElseDoIt({ call, quarter, ctx });
    return {
      call, quarter: quarter ?? null,
      decision: raced ? 'skipped' : 'failed',
      outcome: raced ? 'already-done' : 'error',
      reason: null, txHash: tx.hash, gasUsed: String(receipt.gasUsed),
      severity: raced ? 'info' : 'critical',
      message: raced
        ? 'reverted on chain because another sender got there first, which is the permissionless design working'
        : `reverted on chain after a successful simulation (block ${receipt.blockNumber})`,
    };
  } catch (err) {
    if (isTransportFailure(err)) throw err;
    const verdict = classifyRevert(err);

    // Classify by the same rule the simulation uses. Lotus applies a message when it is
    // pushed to the mpool and rejects it there, so on Filecoin a benign race -- somebody
    // else cranked between our eth_call and our sendRawTransaction -- arrives as a thrown
    // AlreadySubmitted rather than a status-0 receipt. Hardcoding 'failed' here would turn
    // the most ordinary outcome of a permissionless design into a red run and an email.
    const fatal = verdict.kind === 'critical' || verdict.kind === 'fault';
    (fatal ? log.error : log.info)(`${label}: ${verdict.message}`);

    return {
      call, quarter: quarter ?? null,
      decision: fatal ? 'failed' : 'skipped',
      outcome: verdict.outcome,
      reason: verdict.reason, txHash: err?.transaction?.hash ?? null, gasUsed: null,
      severity: verdict.severity,
      message: verdict.message,
    };
  }
}

/**
 * After a post-simulation revert: did the work get done anyway, by someone else?
 *
 * The comparison must be exact. `lastSubmittedQuarter` holds only the quarter last passed
 * to submitShares, and the SRA accepts nothing but the latest bound quarter -- so
 * `lastSubmittedQuarter > quarter` does NOT mean somebody did our work. It means a later
 * quarter bound and was submitted instead, and quarter `quarter` is gone for good. Reading
 * that as benign would report the one outcome this cranker exists to prevent as healthy.
 */
async function didSomeoneElseDoIt({ call, quarter, ctx }) {
  try {
    if (call === 'submitShares') {
      const s = await readSraQuarterState(ctx.provider, ctx.config.addresses.sra);
      return s.lastSubmittedQuarter === quarter;
    }
    // The gate advances strictly one quarter per call, so reaching or passing our target
    // does mean the work landed -- ours or someone else's.
    const g = await readSwaGateState(ctx.provider, ctx.config.addresses.swa);
    return g.lastCheckedQuarter >= quarter || g.complete;
  } catch {
    return false;
  }
}

/**
 * One full pass.
 *
 * @returns {{record: object, exitCode: number, alerts: AlertSink}}
 */
export async function runCrank(config) {
  const runId = newRunId();
  const startedAt = new Date();
  const alerts = new AlertSink(config);
  const actions = [];

  log.section(`Solstice cranker -- ${config.label}`);

  // ---- connect and sanity-check the deployment -----------------------------
  if (!config.deployed) {
    log.warn('SRA and/or SWA address is the zero address; the contracts are not deployed on this network yet');
    const record = baseRecord({ runId, startedAt, config, epoch: null, address: null, balanceFil: null });
    record.actions = [{
      call: 'preflight', quarter: null, decision: 'skipped', outcome: 'not-due',
      reason: null, txHash: null, gasUsed: null, severity: 'info',
      message: 'contracts not deployed on this network; nothing to crank',
    }];
    record.exitCode = 0;
    record.finishedAt = new Date().toISOString();
    persistRun(record);
    return { record, exitCode: 0, alerts };
  }

  const { provider, wallet, sra, swa, address } = await connect(config);
  const ctx = { provider, config };

  // Everything from here to the submitShares attempt is best-effort.
  //
  // submitShares(Q) is the only call in this system with a hard deadline, and missing it
  // destroys a quarter's share map for good. Nothing optional may stand between the run
  // starting and that call being attempted: not a flaky RPC on a cross-check, not an
  // unreadable SWA, not a balance lookup. `tolerate` degrades each of those to a warning
  // and carries on. The SRA itself is the only hard requirement -- without it there is
  // nothing to submit to.
  const degraded = [];
  const tolerate = async (what, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      const message = err?.shortMessage ?? err?.message ?? String(err);
      log.warn(`${what} failed; continuing without it`, { error: message });
      degraded.push({ what, error: message });
      return fallback;
    }
  };

  const sraHasCode = await hasCode(provider, config.addresses.sra);
  if (!sraHasCode) {
    throw new Error(
      `no contract code at SRA ${config.addresses.sra}. The address is wrong, or points at ` +
        'a different chain. Run `npm run sync:deployments`.'
    );
  }
  const swaHasCode = await tolerate('SWA code check', () => hasCode(provider, config.addresses.swa), false);

  const epoch = await currentEpoch(provider);
  const balance = address
    ? await tolerate('wallet balance read', () => readBalance(provider, address), { wei: null, fil: 'unknown' })
    : { wei: null, fil: 'n/a (no signer)' };

  log.info('connected', {
    network: config.networkName, epoch: String(epoch), cranker: address, balance: `${balance.fil} FIL`,
  });

  // ---- geometry: chain first, config for what the chain will not say --------
  // If the chain will not answer, config still describes the geometry well enough to
  // resolve a due quarter, and the pre-send simulation is the real guard against sending
  // the wrong thing. Falling back beats not cranking.
  const chainGeometry = await tolerate('chain geometry read', () => readChainGeometry(sra), {
    activationEpoch: config.quarters.activationEpoch,
    epochsPerQuarter: config.quarters.epochsPerQuarter,
  });
  const geometry = {
    activationEpoch: chainGeometry.activationEpoch,
    epochsPerQuarter: chainGeometry.epochsPerQuarter,
    postPeriod: config.quarters.postPeriod,
    verificationWindow: config.quarters.verificationWindow,
  };

  for (const [key, chainValue] of Object.entries(chainGeometry)) {
    const configured = config.quarters[key];
    // 0 is the committed placeholder for activationEpoch on every network -- it is not
    // knowable before deployment, and the chain is the source of truth for it anyway.
    // Warning about it would fire on every single run and teach people to ignore the one
    // alert class that catches genuinely stale config.
    if (configured === 0n) continue;
    if (configured !== chainValue) {
      alerts.raise({
        severity: 'warn',
        title: `config/networks.json has a stale ${key}`,
        body:
          `config says ${configured} but ${config.label} reports ${chainValue}. ` +
          'Using the chain value. Update config/networks.json, or run `npm run sync:deployments`.',
        context: { epoch: String(epoch), cranker: address, balanceFil: balance.fil },
      });
      log.warn(`${key} differs from config`, { config: String(configured), chain: String(chainValue) });
    }
  }

  // ---- contract progress ---------------------------------------------------
  // The SRA's progress counter is required -- it is what says whether this quarter's map is
  // already installed. The SWA's is not: a gate we cannot read is a gate we skip, and the
  // gate has no deadline.
  const sraState = await readSraQuarterState(provider, config.addresses.sra);
  const gateState = swaHasCode
    ? await tolerate('SWA gate state read', () => readSwaGateState(provider, config.addresses.swa), null)
    : null;

  const schedule = buildSchedule(geometry, epoch, {
    lastSubmittedQuarter: sraState.lastSubmittedQuarter,
    lastCheckedQuarter: gateState?.lastCheckedQuarter ?? null,
    gateComplete: gateState?.complete ?? false,
  });

  log.info('schedule', {
    quarter: schedule.currentQuarter,
    phase: schedule.phase,
    nextPhaseIn: epochsToDuration(schedule.epochsUntilNextPhase, config.epochSeconds),
    latestBound: schedule.dueQuarter ?? 'none',
    lastSubmitted: sraState.lastSubmittedQuarter,
    gate: gateState ? `${gateState.steps}/${gateState.gateSteps} steps, last checked Q${gateState.lastCheckedQuarter}` : 'unreadable',
  });

  // ---- cross-check the computed schedule against the chain ------------------
  // A cross-check that cannot run is not a reason to skip the crank. The deterministic
  // schedule already names the due quarter, and the pre-send simulation still refuses to
  // broadcast anything the contract would reject -- so falling back here costs a warning,
  // not correctness.
  const observed = await tolerate(
    'chain cross-check of the due quarter',
    () => observeLatestBoundQuarter(sra, schedule.dueQuarter),
    { quarter: schedule.dueQuarter, probes: 0, unchecked: true }
  );
  const comparison = observed.unchecked
    ? { agrees: true, divergence: null }
    : compareWithChain(schedule.dueQuarter, observed.quarter);
  if (!comparison.agrees) {
    log.warn('computed schedule disagrees with the chain', { message: comparison.message });
    alerts.raise({
      severity: comparison.severity,
      title: 'Cranker schedule does not match the chain',
      body: comparison.message,
      detail:
        'POST_PERIOD and VERIFICATION_WINDOW are private immutables on the SRA and cannot be read ' +
        'on chain, so they come from config/networks.json alone. One of them is wrong for this ' +
        'deployment. The cranker is proceeding on the chain\'s answer.',
      context: { epoch: String(epoch), cranker: address, balanceFil: balance.fil },
    });
  }

  // The chain is ground truth; the computed schedule is how we got here. When the two
  // disagree, the submit window has to be recomputed for the quarter we are actually going
  // to send, or the deadline we report and warn against belongs to a different quarter.
  const resolvedDueQuarter = observed.quarter ?? schedule.dueQuarter;

  // CRANK_TARGET_QUARTER overrides all of that. It exists for rehearsal and diagnosis --
  // proving that a missed quarter really does revert NotLatestQuarter needs a way to aim
  // at one. Left set by accident it would point every run at a quarter that can never be
  // due again, so it is impossible to miss in the log, the alert stream and the record.
  const effectiveDueQuarter = config.targetQuarter ?? resolvedDueQuarter;
  if (config.targetQuarter !== null) {
    log.warn('CRANK_TARGET_QUARTER is set: overriding the resolved schedule', {
      resolved: resolvedDueQuarter ?? 'none',
      forced: config.targetQuarter,
    });
    alerts.raise({
      severity: 'warn',
      title: 'Cranker is running with a forced target quarter',
      body:
        `CRANK_TARGET_QUARTER=${config.targetQuarter} is overriding the resolved due quarter ` +
        `(${resolvedDueQuarter ?? 'none'}). This is a diagnostic setting. If this is not a ` +
        'rehearsal or a deliberate recovery attempt, unset it now: while it is set the cranker ' +
        'will not submit the quarter that is actually due.',
      context: { epoch: String(epoch), cranker: address, balanceFil: balance.fil },
    });
  }
  const window = effectiveDueQuarter === null
    ? { dueAtEpoch: null, expiresAtEpoch: null, marginEpochs: null, atRisk: false }
    : (() => {
        const dueAtEpoch = bindingEpoch(geometry, effectiveDueQuarter);
        const expiresAtEpoch = expiryEpoch(geometry, effectiveDueQuarter);
        return {
          dueAtEpoch,
          expiresAtEpoch,
          marginEpochs: expiresAtEpoch - epoch,
          atRisk: expiresAtEpoch - epoch < geometry.epochsPerQuarter / 5n,
        };
      })();

  // Quarters between the last submission and the one now due are gone for good: their
  // binding windows closed while nothing was sent.
  //
  // This is the gap visible RIGHT NOW, and it is only visible for about one quarter. The
  // contracts do not remember holes -- lastSubmittedQuarter stores only the most recent
  // submission -- so once a later quarter lands, this reads empty again and no chain state
  // anywhere records the loss. Nor can SharesSubmitted events recover it: an all-zero
  // quarter submits legitimately and emits nothing, so a missing event is not a missing
  // submission. The durable record is the run log and the alert that fires below; consumers
  // that need history accumulate the union across runs (see docs/DATA-CONTRACT.md).
  //
  // Logged rather than re-alerted: the critical alert fired when the window closed, and
  // repeating it hourly forever would only teach people to ignore it.
  const missedQuarters = [];
  if (effectiveDueQuarter !== null) {
    for (let q = sraState.lastSubmittedQuarter + 1; q < effectiveDueQuarter; q++) missedQuarters.push(q);
  }

  // The fact and the alarm are separate. lastSubmittedQuarter == 0 is the never-submitted
  // sentinel, so on a cranker switched on at quarter 5 of a running deployment the gap
  // [1..4] is real and belongs in the record -- but it is not news this run should page
  // somebody about, because nothing was lost on this cranker's watch and no action follows.
  const coldStart = sraState.lastSubmittedQuarter === 0;
  if (missedQuarters.length && coldStart) {
    log.warn('quarters with no share map, from before this cranker was running', {
      quarters: missedQuarters.join(','),
      note: 'recorded, not alerted: nothing was submitted on this deployment yet',
    });
  }

  if (missedQuarters.length && !coldStart) {
    log.error('quarters whose submit window closed with nothing submitted', {
      quarters: missedQuarters.join(','),
      note: 'permanently lost; see docs/RUNBOOK.md',
    });
    alerts.raise({
      severity: 'critical',
      title: `Solstice: quarter${missedQuarters.length > 1 ? 's' : ''} ${missedQuarters.join(', ')} never submitted`,
      body:
        `The SRA last recorded a submission for quarter ${sraState.lastSubmittedQuarter}, and quarter ` +
        `${effectiveDueQuarter} is now the latest bound. Quarter${missedQuarters.length > 1 ? 's' : ''} ` +
        `${missedQuarters.join(', ')} passed out of the submittable window with nothing sent. ` +
        "Those share maps cannot be installed now and cannot be recovered by retrying. " +
        'Escalate and record the loss per docs/RUNBOOK.md.',
      detail:
        'This is the only notification you will get. The cranker never attempts a stale quarter -- ' +
        'submitShares only accepts the latest bound one -- so no NotLatestQuarter revert is ever ' +
        'raised for it. And the gap is visible in contract state only until the next submission ' +
        'lands, after which lastSubmittedQuarter jumps over it and nothing on chain remembers.',
      context: { epoch: String(epoch), cranker: address, balanceFil: balance.fil },
    });
  }

  // ---- pause ----------------------------------------------------------------
  const pause = resolvePause(startedAt);
  if (pause.paused) {
    log.warn(`paused: ${pause.reason}; reading state but sending nothing`);
  }

  // ---- submitShares ---------------------------------------------------------
  // A forced target always gets attempted. Short-circuiting on lastSubmittedQuarter would
  // defeat the override's only purpose: aiming at a quarter the cranker would never choose
  // by itself, which by definition is one the ordinary guard rejects.
  const needsSubmit =
    config.targetQuarter !== null ||
    (effectiveDueQuarter !== null && sraState.lastSubmittedQuarter < effectiveDueQuarter);

  if (!needsSubmit) {
    const why = effectiveDueQuarter === null
      ? 'no quarter is bound yet'
      : `quarter ${effectiveDueQuarter} is already submitted`;
    log.info(`submitShares: nothing to do -- ${why}`);
    actions.push({
      call: 'submitShares', quarter: effectiveDueQuarter, decision: 'skipped',
      outcome: effectiveDueQuarter === null ? 'not-due' : 'already-done',
      reason: null, txHash: null, gasUsed: null, severity: 'info', message: why,
    });
  } else if (pause.paused) {
    actions.push({
      call: 'submitShares', quarter: effectiveDueQuarter, decision: 'skipped', outcome: 'not-due',
      reason: null, txHash: null, gasUsed: null, severity: 'info',
      message: `due for quarter ${effectiveDueQuarter} but the cranker is paused: ${pause.reason}`,
    });
  } else {
    let action = await attempt({
      contract: sra, method: 'submitShares', args: [effectiveDueQuarter],
      call: 'submitShares', quarter: effectiveDueQuarter, config, ctx,
    });
    actions.push(action);

    // A quarter can bind between our simulation and our message landing -- a real race on any
    // chain, and a certainty when the run starts in the last epoch before a boundary. The
    // quarter we aimed at is then genuinely lost, but the one that just bound is now
    // submittable and nothing else in this run will reach for it. Giving up here would turn
    // one lost quarter into two, every time, so re-resolve and take one more shot.
    if (action.outcome === 'missed-window' && config.targetQuarter === null) {
      const fresh = await readSraQuarterState(provider, config.addresses.sra);
      const reobserved = await observeLatestBoundQuarter(sra, (action.quarter ?? 0) + 1);
      const nowDue = reobserved.quarter;

      if (nowDue !== null && nowDue > effectiveDueQuarter && fresh.lastSubmittedQuarter < nowDue) {
        log.warn('a later quarter bound mid-run; submitting that one instead', {
          lost: effectiveDueQuarter,
          nowDue,
        });
        action = await attempt({
          contract: sra, method: 'submitShares', args: [nowDue],
          call: 'submitShares', quarter: nowDue, config, ctx,
        });
        actions.push(action);
      }
    }

    if (actions.some((a) => a.call === 'submitShares' && a.outcome === 'missed-window')) {
      const missedAction = actions.find((a) => a.call === 'submitShares' && a.outcome === 'missed-window');
      alerts.raise({
        severity: 'critical',
        title: `Solstice: submitShares(${missedAction.quarter}) missed its window`,
        body:
          `The share map for quarter ${missedAction.quarter} can no longer be submitted. ` +
          'A later quarter has already bound, so the SRA rejects it with NotLatestQuarter. ' +
          'This is not retryable and the quarter\'s share map is permanently lost. ' +
          'Escalate per docs/RUNBOOK.md; do not re-run the cranker expecting it to fix itself.',
        detail: missedAction.message,
        context: {
          epoch: String(epoch), cranker: address, balanceFil: balance.fil,
          txHash: missedAction.txHash, explorerUrl: explorerUrl(config, missedAction.txHash),
        },
      });
    }

    if (action.decision === 'failed' && action.outcome !== 'missed-window') {
      alerts.raise({
        severity: action.severity,
        title: `Solstice: submitShares(${effectiveDueQuarter}) failed`,
        body: action.message,
        context: {
          epoch: String(epoch), cranker: address, balanceFil: balance.fil,
          txHash: action.txHash, explorerUrl: explorerUrl(config, action.txHash),
        },
      });
    }
  }

  // Warn while there is still time to act, not after.
  if (needsSubmit && window.atRisk && !actions.some((a) => a.call === 'submitShares' && a.decision === 'sent')) {
    alerts.raise({
      severity: 'warn',
      title: `Solstice: submitShares(${effectiveDueQuarter}) is running out of window`,
      body:
        `Quarter ${effectiveDueQuarter} has not been submitted and the window closes at epoch ` +
        `${window.expiresAtEpoch} (${epochsToDuration(window.marginEpochs, config.epochSeconds)} from now). ` +
        'After that the share map is lost permanently.',
      context: { epoch: String(epoch), cranker: address, balanceFil: balance.fil },
    });
  }

  // ---- quarterlyGateCheck ---------------------------------------------------
  // Each call advances the gate by exactly one quarter, so a gap needs several. The loop
  // stops on the first non-send, which covers NotBound, StepsComplete and the SWA hold.
  if (pause.paused) {
    actions.push({
      call: 'quarterlyGateCheck', quarter: gateState ? gateState.lastCheckedQuarter + 1 : null, decision: 'skipped',
      outcome: 'not-due', reason: null, txHash: null, gasUsed: null, severity: 'info',
      message: `paused: ${pause.reason}`,
    });
  } else if (!gateState) {
    // The gate has no deadline, so skipping it for one run costs an hour, not a quarter.
    log.warn('quarterlyGateCheck: the SWA gate state could not be read; skipping the gate this run');
    actions.push({
      call: 'quarterlyGateCheck', quarter: null, decision: 'skipped', outcome: 'not-due',
      reason: null, txHash: null, gasUsed: null, severity: 'warn',
      message: 'SWA gate state unreadable this run; the gate has no deadline and the next run retries',
    });
  } else if (gateState.complete) {
    log.info('quarterlyGateCheck: gate has taken all 8 steps and is closed for good');
    actions.push({
      call: 'quarterlyGateCheck', quarter: null, decision: 'skipped', outcome: 'gate-closed',
      reason: 'StepsComplete()', txHash: null, gasUsed: null, severity: 'info',
      message: 'the gate reached its 8-step cap; nothing further to check',
    });
  } else {
    let target = gateState.lastCheckedQuarter + 1;
    try {
      for (let i = 0; i < config.maxGateCatchup; i++) {
      const action = await attempt({
        contract: swa, method: 'quarterlyGateCheck', args: [],
        call: 'quarterlyGateCheck', quarter: target, config, ctx,
      });
      actions.push(action);

      if (action.decision === 'failed') {
        alerts.raise({
          severity: action.severity,
          title: 'Solstice: quarterlyGateCheck failed',
          body: action.message,
          context: {
            epoch: String(epoch), cranker: address, balanceFil: balance.fil,
            txHash: action.txHash, explorerUrl: explorerUrl(config, action.txHash),
          },
        });
        break;
      }
      // Only a landed transaction advances lastCheckedQuarter, so only a landed
      // transaction justifies another pass. A dry run in particular must stop here:
      // nothing moved, and looping would re-simulate the same quarter forever.
      if (action.decision !== 'sent') break;
      target += 1;
      }
    } catch (err) {
      // submitShares has already been attempted by this point. The gate is the call with no
      // deadline, so a transport failure here is a warning and a retry next hour -- never a
      // reason to lose the run record or the alerts gathered above.
      const message = err?.shortMessage ?? err?.message ?? String(err);
      log.warn('gate catch-up stopped early', { error: message });
      degraded.push({ what: 'quarterlyGateCheck catch-up', error: message });
    }
    if (actions.filter((a) => a.call === 'quarterlyGateCheck' && a.decision === 'sent').length >= config.maxGateCatchup) {
      log.warn('hit the gate catch-up cap for this run; the next scheduled run continues', {
        cap: config.maxGateCatchup,
      });
    }
  }

  // ---- balance --------------------------------------------------------------
  const balanceAfter = address
    ? await tolerate('post-run wallet balance read', () => readBalance(provider, address), balance)
    : balance;
  if (balanceAfter.wei !== null && balanceAfter.wei < config.minBalanceWei) {
    alerts.raise({
      severity: 'warn',
      title: 'Solstice: cranker wallet is low on gas',
      body:
        `${address} holds ${balanceAfter.fil} FIL, below the ${config.minBalanceFil} FIL threshold. ` +
        'Top it up before the next quarter boundary. See docs/WALLET.md.',
      context: { epoch: String(epoch), cranker: address, balanceFil: balanceAfter.fil },
    });
    log.warn('wallet below threshold', { balance: balanceAfter.fil, threshold: config.minBalanceFil });
  }

  // ---- what we had to do without ---------------------------------------------
  if (degraded.length) {
    alerts.raise({
      severity: 'warn',
      title: `Cranker ran degraded: ${degraded.length} read(s) failed`,
      body:
        'The crank went ahead anyway, which is the intended behaviour -- submitShares has a ' +
        'hard deadline and nothing optional is allowed to block it. But these reads failed ' +
        'and are worth looking at:\n\n' +
        degraded.map((d) => `  - ${d.what}: ${d.error}`).join('\n'),
      context: { epoch: String(epoch), cranker: address, balanceFil: balanceAfter.fil },
    });
  }

  // ---- result ---------------------------------------------------------------
  // The exit code and the alerts have to tell the same story. A run that emails a critical
  // while showing green in the Actions tab teaches people that green means nothing, and a
  // red run with nothing worth reading teaches them that red means nothing either.
  const failed = actions.some((a) => a.decision === 'failed');
  const exitCode = failed || alerts.worst === 'critical' ? 1 : 0;

  const record = baseRecord({ runId, startedAt, config, epoch, address, balanceFil: balanceAfter.fil });
  record.paused = pause.paused;
  record.pauseReason = pause.reason;
  record.actions = actions;
  record.schedule = {
    currentQuarter: schedule.currentQuarter,
    phase: schedule.phase,
    submitDueQuarter: effectiveDueQuarter,
    submitDueAtEpoch: window.dueAtEpoch === null ? null : Number(window.dueAtEpoch),
    submitDeadlineEpoch: window.expiresAtEpoch === null ? null : Number(window.expiresAtEpoch),
    missedQuarters,
    forcedTargetQuarter: config.targetQuarter,
    degraded: degraded.map((d) => d.what),
    gateDueQuarter: schedule.gate.quarter,
    gateDueAtEpoch: schedule.gate.dueAtEpoch === null ? null : Number(schedule.gate.dueAtEpoch),
    chainAgreesWithConfig: comparison.agrees,
    divergence: comparison.divergence ?? null,
  };
  record.exitCode = exitCode;
  record.finishedAt = new Date().toISOString();
  record.durationMs = Date.now() - startedAt.getTime();

  persistRun(record);
  return { record, exitCode, alerts };
}

function baseRecord({ runId, startedAt, config, epoch, address, balanceFil }) {
  return {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: 0,
    network: config.networkName,
    chainId: Number(config.chainId),
    epoch: epoch === null ? null : Number(epoch),
    cranker: address,
    balanceFil,
    paused: false,
    pauseReason: null,
    actions: [],
    schedule: null,
    exitCode: 0,
  };
}
