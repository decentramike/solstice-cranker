#!/usr/bin/env node
/**
 * The second pair of eyes (solstice#68, task 3).
 *
 * The cranker alerts when a run of its own fails. It cannot alert when it never runs at
 * all -- a disabled workflow, a GitHub incident, an expired token, a repo gone quiet past
 * the 60-day scheduled-workflow cutoff. This checks the only thing that actually matters:
 * did the events land on chain?
 *
 * It looks at state rather than logs, so it is true regardless of who sent the
 * transactions. These cranks are permissionless, and a human firing them by hand is a
 * perfectly good outcome that the watchdog should read as healthy.
 *
 * Exit 0 healthy, exit 1 overdue.
 */
import { loadConfig } from '../src/config.mjs';
import {
  connect, currentEpoch, hasCode, observeLatestBoundQuarter,
  readChainGeometry, readSraQuarterState, readSwaGateState,
} from '../src/chain.mjs';
import { AlertSink } from '../src/alerts/index.mjs';
import { bindingEpoch, buildSchedule, epochsToDuration, expiryEpoch } from '../src/schedule.mjs';
import { log, writeJobSummary } from '../src/logger.mjs';

/**
 * How long after a quarter binds before a missing crank counts as overdue.
 *
 * `null` means "use the default". Written out rather than `Number(x) || null` because that
 * idiom turns an explicit 0 -- alert immediately, a perfectly reasonable setting -- into the
 * default, and turns a typo into NaN and then into the default, silently.
 */
const GRACE_EPOCHS = (() => {
  const raw = process.env.WATCHDOG_GRACE_EPOCHS;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`WATCHDOG_GRACE_EPOCHS must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
})();

async function main() {
  // Read-only: the watchdog inspects chain state and never sends a transaction, so it
  // runs without a wallet key at all. See loadConfig's requireKey option.
  const config = loadConfig(process.env, { requireKey: false });

  if (!config.deployed) {
    log.info('contracts are not deployed on this network yet; nothing to watch');
    return;
  }

  const { provider, sra, swa } = await connect(config);
  // Both, not just the SRA: the gate state is read straight out of SWA storage, and a wrong
  // address reads as all zeros rather than failing -- which shows up as a permanent,
  // confident "the gate is N quarters behind" against a contract that does not exist.
  for (const [name, address] of [['SRA', config.addresses.sra], ['SWA', config.addresses.swa]]) {
    if (!(await hasCode(provider, address))) {
      throw new Error(`no contract code at ${name} ${address} -- wrong address, or wrong chain`);
    }
  }

  const epoch = await currentEpoch(provider);
  const chain = await readChainGeometry(sra);
  const geometry = {
    activationEpoch: chain.activationEpoch,
    epochsPerQuarter: chain.epochsPerQuarter,
    postPeriod: config.quarters.postPeriod,
    verificationWindow: config.quarters.verificationWindow,
  };

  // Default grace is a quarter of the verification window, floored at 1 epoch: long enough
  // that an hourly cranker gets several attempts, short enough to leave room to act.
  // Math.floor, not bare division: BigInt() throws RangeError on a fractional argument, so
  // any verificationWindow not divisible by 4 would crash the watchdog rather than run it.
  const grace = BigInt(GRACE_EPOCHS ?? Math.max(1, Math.floor(Number(config.quarters.verificationWindow) / 4)));

  const [sraState, gateState] = await Promise.all([
    readSraQuarterState(provider, config.addresses.sra),
    readSwaGateState(provider, config.addresses.swa),
  ]);

  const schedule = buildSchedule(geometry, epoch, {
    lastSubmittedQuarter: sraState.lastSubmittedQuarter,
    lastCheckedQuarter: gateState.lastCheckedQuarter,
    gateComplete: gateState.complete,
  });

  const observed = await observeLatestBoundQuarter(sra, schedule.dueQuarter);
  const dueQuarter = observed.quarter ?? schedule.dueQuarter;

  // Recompute the windows for the quarter actually in question. buildSchedule computed its
  // submit/gate blocks for ITS OWN dueQuarter, and when config's postPeriod or
  // verificationWindow is off those are a different quarter's epochs. Using them would make
  // the watchdog stay at "warn, N left" past a deadline that has already passed, or declare
  // a live quarter lost -- and when the computed dueQuarter is null while the chain has one,
  // boundAt would be null, overdueBy would be 0, and the watchdog would report nothing at
  // all in precisely the case it exists for.
  const submitBoundAt = dueQuarter === null ? null : bindingEpoch(geometry, dueQuarter);
  const submitExpiresAt = dueQuarter === null ? null : expiryEpoch(geometry, dueQuarter);
  const gateTargetQuarter = gateState.lastCheckedQuarter + 1;
  const gateBoundAt = bindingEpoch(geometry, gateTargetQuarter);

  const findings = [];

  // ---- submitShares --------------------------------------------------------
  if (dueQuarter !== null && sraState.lastSubmittedQuarter < dueQuarter) {
    const boundAt = submitBoundAt;
    const overdueBy = epoch - (boundAt ?? epoch);
    const expiresAt = submitExpiresAt;

    if (overdueBy > grace) {
      findings.push({
        severity: epoch >= (expiresAt ?? 0n) ? 'critical' : 'warn',
        title:
          epoch >= (expiresAt ?? 0n)
            ? `submitShares(${dueQuarter}) window has CLOSED and nothing landed`
            : `submitShares(${dueQuarter}) is overdue`,
        body:
          `Quarter ${dueQuarter} bound at epoch ${boundAt} and it is now epoch ${epoch} ` +
          `(${epochsToDuration(overdueBy, config.epochSeconds)} later). ` +
          `The SRA still reports lastSubmittedQuarter = ${sraState.lastSubmittedQuarter}. ` +
          (epoch >= (expiresAt ?? 0n)
            ? "That quarter's share map is permanently lost. Escalate per docs/RUNBOOK.md."
            : `The window closes at epoch ${expiresAt} (${epochsToDuration(expiresAt - epoch, config.epochSeconds)} left). ` +
              'Fire the Solstice Crank workflow manually now, from the Actions tab.'),
      });
    }
  }

  // ---- quarterlyGateCheck --------------------------------------------------
  if (!gateState.complete && dueQuarter !== null && gateState.lastCheckedQuarter < dueQuarter) {
    const target = gateTargetQuarter;
    const boundAt = gateBoundAt;
    const overdueBy = epoch - boundAt;
    if (overdueBy > grace) {
      findings.push({
        severity: 'warn',
        title: `quarterlyGateCheck is ${dueQuarter - gateState.lastCheckedQuarter} quarter(s) behind`,
        body:
          `The SWA last checked quarter ${gateState.lastCheckedQuarter}; quarter ${target} became ` +
          `checkable at epoch ${boundAt}, ${epochsToDuration(overdueBy, config.epochSeconds)} ago. ` +
          'There is no hard deadline, but the w2 weight step is delayed until it runs, and f02 ' +
          'burns the difference in the meantime.',
      });
    }
  }

  // ---- report --------------------------------------------------------------
  const healthy = findings.length === 0;

  log.info('watchdog', {
    epoch: String(epoch),
    dueQuarter: dueQuarter ?? 'none',
    lastSubmitted: sraState.lastSubmittedQuarter,
    lastChecked: gateState.lastCheckedQuarter,
    gate: `${gateState.steps}/${gateState.gateSteps}`,
    verdict: healthy ? 'healthy' : `${findings.length} finding(s)`,
  });

  writeJobSummary(
    [
      `### Solstice watchdog — ${config.networkName}`,
      '',
      `Epoch **${epoch}** · latest bound quarter **${dueQuarter ?? '—'}** · ` +
        `last submitted **${sraState.lastSubmittedQuarter}** · ` +
        `gate **${gateState.steps}/${gateState.gateSteps}**, last checked Q${gateState.lastCheckedQuarter}`,
      '',
      healthy
        ? '**Healthy.** Both cranks are up to date on chain.'
        : findings.map((f) => `- **${f.severity}** — ${f.title}\n  ${f.body}`).join('\n'),
    ].join('\n')
  );

  if (healthy) {
    process.stdout.write('healthy\n');
    return;
  }

  const sink = new AlertSink(config);
  for (const f of findings) {
    sink.raise({
      severity: f.severity,
      title: `Solstice watchdog: ${f.title}`,
      body: f.body,
      context: { epoch: String(epoch), cranker: '(watchdog, no wallet used)', balanceFil: '—' },
    });
  }
  await sink.flush({ minSeverity: 'warn' });

  process.stdout.write(JSON.stringify({ healthy: false, findings }, null, 2) + '\n');
  process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  log.error('watchdog aborted', { error: err.message });
  process.exitCode = 1;
}
