#!/usr/bin/env node
/**
 * Entrypoint. This is the only file the hourly GitHub Actions job runs.
 *
 * Exit 0 means the run is healthy: either the cranks landed, or they were correctly not
 * due. Exit 1 means something needs a person, and an alert has already gone out.
 */
import { loadConfig, describeConfig, redactRpcUrl } from '../src/config.mjs';
import { runCrank } from '../src/crank.mjs';
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

/**
 * A run that cannot even load its configuration still exits 1, so it still has to tell someone:
 * a deleted CRANKER_PRIVATE_KEY secret or a mistyped variable otherwise shows only as a red run
 * nobody is watching. The alert settings need no key, so they are loaded on their own. If they
 * cannot be loaded either, the log line above is all there is.
 */
async function alertConfigError(err) {
  try {
    const partial = loadConfig(process.env, { requireKey: false });
    const { AlertSink } = await import('../src/alerts/index.mjs');
    const sink = new AlertSink(partial);
    sink.raise({
      severity: 'critical',
      title: `Solstice cranker could not start on ${partial.networkName}`,
      body: `${redactRpcUrl(err.message, partial.rpcUrl)}\n\nNothing was sent. Fix the repository secret or variable named above.`,
      context: { epoch: '—', cranker: '—', balanceFil: '—' },
    });
    await sink.flush({ minSeverity: 'warn' });
  } catch {
    // The configuration is broken beyond the key; the log line is the only signal.
  }
}

async function main() {
  let config;
  try {
    // A dry run broadcasts nothing, so it does not need a signing key. That lets the whole
    // decision path be exercised against a live deployment before the key is anywhere near
    // CI -- which is the order you want to do it in.
    config = loadConfig(process.env, { requireKey: !process.env.CRANK_DRY_RUN });
  } catch (err) {
    log.error(redactRpcUrl(err.message, process.env.RPC_URL));
    process.exitCode = 1;
    await alertConfigError(err);
    return;
  }

  log.info('configuration', describeConfig(config));
  if (config.dryRun) log.warn('CRANK_DRY_RUN is set: simulating only, nothing will be broadcast');

  try {
    // CRANK_MODE=rehearsal: send exactly what config/rehearsal-schedule.json lists, when it says.
    // Calibnet only; runRehearsalFromEnv refuses anything else before it touches the node.
    // Loaded only in rehearsal mode: nothing in it can stop a production run from starting.
    const rehearsal = config.mode === 'rehearsal' ? await import('../src/rehearsal/run.mjs') : null;
    const { record, exitCode, alerts } = rehearsal ? await rehearsal.runRehearsalFromEnv(config) : await runCrank(config);

    // The run record is the machine-readable output; stdout carries it alone.
    process.stdout.write(JSON.stringify(record, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2) + '\n');
    writeJobSummary(rehearsal ? rehearsal.summariseRehearsal(record, config.explorerTxUrl) : summarise(record));

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
