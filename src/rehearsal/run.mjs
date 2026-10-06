/**
 * Rehearsal mode, wired to the real world: config, schedule file, deployments.json, the node,
 * the wallet, alerts. The decisions themselves live in engine.mjs.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AlertSink } from '../alerts/index.mjs';
import { connect, hasCode } from '../chain.mjs';
import { resolvePause } from '../config.mjs';
import { log } from '../logger.mjs';
import { DEFAULT_DEPLOYMENTS, loadDeployments } from './deployments.mjs';
import { assertRehearsalChain, ethersChain, runRehearsal } from './engine.mjs';
import { loadSchedule, REHEARSAL_CHAIN_ID } from './schedule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_DAYS = 7;

/**
 * The alert ledger: which alerts have already gone out. Only alerts read it -- every send decision
 * comes from the chain. In Actions it lives in .crank-state/, carried from run to run by the cache
 * steps in the workflow; when it is missing the engine falls back to a time window, which can
 * repeat an alert but never drops one it would otherwise send.
 */
export function openAlertLedger(file, nowMs) {
  let keys = {};
  try {
    keys = JSON.parse(readFileSync(file, 'utf8')).keys ?? {};
  } catch {
    // first run, evicted cache, or no ledger at all
  }
  for (const [k, at] of Object.entries(keys)) {
    if (nowMs - Date.parse(at) > LEDGER_DAYS * 86_400_000) delete keys[k];
  }
  return {
    has: (k) => k in keys,
    add: (k) => {
      keys[k] = new Date(nowMs).toISOString();
    },
    save() {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ keys }, null, 1) + '\n');
      } catch (err) {
        log.warn('could not save the alert ledger; the next run may repeat an alert', { error: err.message });
      }
    },
  };
}

/**
 * @returns {Promise<{record: object, exitCode: number, alerts: AlertSink}>}
 * @throws RehearsalRefused off calibnet, ScheduleError / DeploymentsError on bad inputs
 */
export async function runRehearsalFromEnv(config, { now = () => Date.now() } = {}) {
  const startedAt = new Date(now());
  const runId = `${startedAt.toISOString()}-${randomBytes(2).toString('hex')}`;

  // Refuse before anything else -- before reading the schedule, before touching the node.
  assertRehearsalChain(config.chainId, `NETWORK=${config.networkName}`);

  log.section(`Solstice cranker -- REHEARSAL mode -- ${config.label}`);
  const schedule = loadSchedule(config.rehearsal.scheduleFile);
  log.info('schedule', { file: config.rehearsal.scheduleFile, entries: schedule.entries.length, crankerRowsSha256: schedule.source?.crankerRowsSha256?.slice(0, 12) ?? '-' });

  const source = config.rehearsal.deploymentsSource ?? DEFAULT_DEPLOYMENTS;
  const targets = await loadDeployments(source, REHEARSAL_CHAIN_ID);
  log.info('contracts, from deployments.json', { source, sra: targets.sra, swa: targets.swa });
  for (const key of ['sra', 'swa']) {
    if (config.addresses[key] !== targets[key]) {
      // Rehearsal mode follows deployments.json; the production path still uses config. Say so.
      log.warn(`${key.toUpperCase()} in deployments.json differs from the production config; rehearsal mode uses deployments.json`,
        { deployments: targets[key], config: config.addresses[key] });
    }
  }

  const pause = resolvePause(startedAt);
  if (pause.paused) log.warn(`paused: ${pause.reason}. Nothing will be sent.`);
  if (config.dryRun) log.warn('CRANK_DRY_RUN is set: deciding only, nothing will be broadcast');

  const { provider, wallet, address } = await connect(config);
  // connect() already compared the node's chain id with NETWORK's; ask again, for this mode.
  assertRehearsalChain(BigInt(await provider.send('eth_chainId', [])), 'the RPC endpoint');
  for (const key of ['sra', 'swa']) {
    if (!(await hasCode(provider, targets[key]))) {
      throw new Error(`no contract code at ${key.toUpperCase()} ${targets[key]} (from ${source})`);
    }
  }
  if (!address) log.warn('no CRANKER_PRIVATE_KEY: cannot check what this wallet already sent; showing the plan only');

  const alerts = new AlertSink(config);
  const chain = ethersChain({ provider, wallet, address, epochSeconds: config.epochSeconds });
  const dryRun = config.dryRun || !address;
  const ledgerFile = process.env.CRANK_ALERT_LEDGER || join(ROOT, '.crank-state', 'alerted.json');
  const alertState = dryRun ? null : openAlertLedger(ledgerFile, now());
  const result = await runRehearsal({
    schedule,
    targets,
    chain,
    cranker: address,
    nowMs: now(),
    clock: now,
    dryRun,
    alertState,
    pause,
    gasLimit: config.rehearsal.gasLimit,
    reportWindowMs: config.rehearsal.reportWindowMinutes * 60_000,
    confirmations: config.confirmations,
    alerts,
    log,
  });

  alertState?.save();

  let balanceFil = null;
  if (address) {
    try {
      const b = await chain.balance();
      balanceFil = b.fil;
      if (b.wei < config.minBalanceWei && !dryRun) {
        alerts.raise({ severity: 'warn', title: 'Solstice: cranker wallet is low on gas',
          body: `${address} holds ${b.fil} FIL, below the ${config.minBalanceFil} FIL threshold. See docs/WALLET.md.` });
      }
    } catch (err) {
      log.warn('balance read failed', { error: err.shortMessage ?? err.message });
    }
  }

  const record = {
    mode: 'rehearsal',
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date(now()).toISOString(),
    network: config.networkName,
    chainId: Number(config.chainId),
    epoch: result.epoch,
    chainTime: result.chainTime,
    cranker: address,
    balanceFil,
    dryRun,
    paused: pause.paused,
    pauseReason: pause.reason,
    schedule: { file: config.rehearsal.scheduleFile, entries: schedule.entries.length, crankerRowsSha256: schedule.source?.crankerRowsSha256 ?? null },
    contracts: { source, sra: targets.sra, swa: targets.swa },
    actions: result.actions,
    next: result.next,
    needsPerson: result.needsPerson,
    exitCode: result.exitCode,
  };
  return { record, exitCode: result.exitCode, alerts };
}

/** The Actions job summary for a rehearsal run. */
export function summariseRehearsal(record, explorerTxUrl) {
  const tx = (h) => (h ? (explorerTxUrl ? `[\`${h.slice(0, 10)}…\`](${explorerTxUrl}${h})` : `\`${h.slice(0, 10)}…\``) : '—');
  const rows = record.actions.map((a) =>
    `| ${a.id} | \`${a.call}\` | ${a.decision} | ${tx(a.txHash)} | ${a.epoch ?? '—'} | ${a.result ?? '—'} | ${a.expect} | ${a.match === null || a.match === undefined ? '—' : a.match ? 'yes' : '**NO**'} |`);
  return [
    `### Solstice crank — rehearsal — ${record.network}`,
    '',
    `Epoch **${record.epoch}** · wallet **${record.balanceFil ?? '—'} FIL**` +
      (record.paused ? ` · **paused** (${record.pauseReason})` : '') + (record.dryRun ? ' · **dry run**' : ''),
    '',
    rows.length ? '| step | call | decision | tx | epoch | result | expected | match |' : '_No scheduled step is open right now._',
    rows.length ? '|---|---|---|---|---|---|---|---|' : '',
    ...rows,
    '',
    record.next ? `Next: step **${record.next.id}** \`${record.next.call}\` at ${record.next.notBefore} (expect ${record.next.expect}).` : 'Nothing further is scheduled.',
    '',
    record.exitCode !== 0
      ? '**Needs a person.** See the alert and `docs/RUNBOOK.md` → "Rehearsal mode".'
      : record.actions.some((a) => a.match === false)
        ? '**A step on the record did not match the plan.** It was alerted by the run that sent it; see the table.'
        : record.actions.some((a) => ['blocked', 'held', 'missed', 'too-late', 'failed'].includes(a.decision))
          ? '**A step is held or was not sent** (already alerted). See the table.'
          : '**Healthy.**',
  ].join('\n');
}
