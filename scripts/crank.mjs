#!/usr/bin/env node
/**
 * Entrypoint. This is the only file the hourly GitHub Actions job runs.
 *
 * Exit 0 means the run is healthy: either the cranks landed, or they were correctly not
 * due. Exit 1 means something needs a person, and an alert has already gone out.
 */
import { loadConfig, describeConfig, redactRpcUrl } from '../src/config.mjs';
import { runCrank } from '../src/crank.mjs';
import { runRehearsalFromEnv, summariseRehearsal } from '../src/rehearsal/run.mjs';
import { log, writeJobSummary } from '../src/logger.mjs';

const ICON = { sent: 'sent', skipped: 'skipped', failed: 'FAILED', 'dry-run': 'dry run' };

function summarise(record) {
  const rows = record.actions.map((a) => {
    const target = a.quarter === null ? a.call : `${a.call}(${a.quarter})`;
    const tx = a.txHash ? `\`${a.txHash.slice(0, 10)}…\`` : '—';
    return `| ${target} | ${ICON[a.decision] ?? a.decision} | ${a.reason ?? '—'} | ${tx} | ${a.message} |`;
  });

  return [
    `### Solstice crank — ${record.network}`,
    '',
    `Epoch **${record.epoch ?? '—'}** · quarter **${record.schedule?.currentQuarter ?? '—'}**` +
      ` (${record.schedule?.phase ?? '—'}) · wallet **${record.balanceFil ?? '—'} FIL**` +
      (record.paused ? ` · **paused** (${record.pauseReason})` : ''),
    '',
    '| call | result | revert | tx | detail |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    record.exitCode === 0
      ? '**Healthy.** Nothing needs attention.'
      : '**Failed.** See the alert and `docs/RUNBOOK.md`.',
  ].join('\n');
}

async function main() {
  let config;
  try {
    // A dry run broadcasts nothing, so it does not need a signing key. That lets the whole
    // decision path be exercised against a live deployment before the key is anywhere near
    // CI -- which is the order you want to do it in.
    config = loadConfig(process.env, { requireKey: !process.env.CRANK_DRY_RUN });
  } catch (err) {
    log.error(err.message);
    process.exitCode = 1;
    return;
  }

  log.info('configuration', describeConfig(config));
  if (config.dryRun) log.warn('CRANK_DRY_RUN is set: simulating only, nothing will be broadcast');

  try {
    // CRANK_MODE=rehearsal: send exactly what config/rehearsal-schedule.json lists, when it says.
    // Calibnet only; runRehearsalFromEnv refuses anything else before it touches the node.
    const rehearsal = config.mode === 'rehearsal';
    const { record, exitCode, alerts } = rehearsal ? await runRehearsalFromEnv(config) : await runCrank(config);

    // The run record is the machine-readable output; stdout carries it alone.
    process.stdout.write(JSON.stringify(record, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2) + '\n');
    writeJobSummary(rehearsal ? summariseRehearsal(record, config.explorerTxUrl) : summarise(record));

    await alerts.flush({ minSeverity: 'warn' });

    log.section(exitCode === 0 ? 'Run healthy' : 'Run failed');
    process.exitCode = exitCode;
  } catch (err) {
    // Anything reaching here is unexpected: an RPC that stayed down through its retries,
    // a wrong address, a chain-id mismatch. Alert on it rather than dying quietly in a log
    // nobody is watching.
    // ethers puts the full RPC URL into message and stack for a 429 or a 5xx; the alert goes to an
    // inbox or a webhook that Actions' secret masking never sees.
    const message = redactRpcUrl(err.message, config.rpcUrl);
    const stack = redactRpcUrl(err.stack ?? null, config.rpcUrl);
    log.error('crank aborted', { error: message });
    if (stack) log.debug(stack);

    try {
      const { AlertSink } = await import('../src/alerts/index.mjs');
      const sink = new AlertSink(config);
      sink.raise({
        severity: 'critical',
        title: `Solstice cranker aborted on ${config.networkName}`,
        body: message,
        detail: stack,
        context: { epoch: '—', cranker: '—', balanceFil: '—' },
      });
      await sink.flush({ minSeverity: 'warn' });
    } catch (alertErr) {
      log.error('could not send the abort alert either', { error: alertErr.message });
    }

    process.exitCode = 1;
  }
}

await main();
