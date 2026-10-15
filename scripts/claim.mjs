#!/usr/bin/env node
/**
 * Entrypoint for the Claim workflow (.github/workflows/solstice-claim.yml).
 *
 * Exit 0: the run is healthy -- Claims landed, or none was worth sending. Exit 1: something
 * needs a person, and an alert has gone out.
 */
import { loadClaimConfig, redactRpcUrl } from '../src/config.mjs';
import { runClaim } from '../src/claim.mjs';
import { log, writeJobSummary } from '../src/logger.mjs';

function summarise(record) {
  const rows = record.actions.map((a) =>
    `| ${a.wallets.length || '—'} | ${a.decision} | ${a.outcome ?? '—'} | ${a.payoutFil ?? '—'} | ${a.maxFeeFil ?? '—'} | ${a.cid ? `\`${a.cid.slice(0, 16)}…\`` : '—'} | ${a.message} |`
  );
  return [
    `### Solstice Claim — ${record.network} (${record.mode})`,
    '',
    `Sender **${record.sender ?? '—'}** · balance **${record.senderBalanceFil ?? '—'} FIL**` +
      (record.crankerBalanceFil ? ` · cranker **${record.crankerBalanceFil} FIL**` : '') +
      (record.dryRun ? ` · **dry run** (${record.dryRunReason})` : '') +
      (record.paused ? ' · **paused**' : ''),
    '',
    '| wallets | decision | outcome | pays (FIL) | max fee (FIL) | message | detail |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    record.exitCode === 0 ? '**Healthy.**' : '**Failed.** See the alert and `docs/RUNBOOK.md`, "Claim".',
  ].join('\n');
}

async function main() {
  let config;
  try {
    config = loadClaimConfig(process.env, { requireKey: false });
  } catch (err) {
    log.error(err.message);
    process.exitCode = 1;
    return;
  }

  try {
    const { record, exitCode, alerts } = await runClaim(config);
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
    writeJobSummary(summarise(record));
    await alerts.flush({ minSeverity: 'warn' });
    log.section(exitCode === 0 ? 'Claim run healthy' : 'Claim run failed');
    process.exitCode = exitCode;
  } catch (err) {
    const message = redactRpcUrl(err.message, config.rpcUrl);
    log.error('claim aborted', { error: message });
    try {
      const { AlertSink } = await import('../src/alerts/index.mjs');
      const sink = new AlertSink(config);
      sink.raise({ severity: 'critical', title: `Solstice Claim aborted on ${config.networkName}`, body: message, context: { epoch: '—', cranker: '—', balanceFil: '—' } });
      await sink.flush({ minSeverity: 'warn' });
    } catch (alertErr) {
      log.error('could not send the abort alert either', { error: alertErr.message });
    }
    process.exitCode = 1;
  }
}

await main();
