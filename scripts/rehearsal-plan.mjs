#!/usr/bin/env node
/**
 * Dry run of the rehearsal schedule: prints what the cranker would send, and when, without
 * sending anything. Needs no key and no node.
 *
 *   npm run rehearsal:plan                                   # the next 24 hours
 *   npm run rehearsal:plan -- --hours 72
 *   npm run rehearsal:plan -- --from 2026-10-06T00:00:00Z --to 2026-10-10T00:00:00Z
 *   npm run rehearsal:plan -- --offline                       # skip fetching deployments.json
 *
 * Lists every step whose window overlaps the range, including ones already open. Labels:
 *   WOULD SEND   opens later; the first run at or after its time sends it
 *   OPEN NOW     its window is open; the next run sends it unless it was already sent
 *   CLOSED       its window has closed, or closes within a minute; it will not be sent
 *   skip         the runbook marks it done
 * Any of them can still be held at run time: when paused, when it was already sent, or (gate
 * checks) when the SWA is not at the quarter the row names. Only a real run, against the chain,
 * decides that -- `Run workflow` with dry_run shows it.
 */
import { DEFAULT_DEPLOYMENTS, loadDeployments } from '../src/rehearsal/deployments.mjs';
import { DEFAULT_REHEARSAL_GAS_LIMIT, SEND_MARGIN_MS, stepTag, tagGasLimit } from '../src/rehearsal/engine.mjs';
import { callLabel, loadSchedule, REHEARSAL_CHAIN_ID } from '../src/rehearsal/schedule.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { from: null, to: null, hours: 24, offline: false, file: process.env.CRANK_SCHEDULE_FILE ?? join(ROOT, 'config', 'rehearsal-schedule.json'), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === '--from') out.from = v();
    else if (a === '--to') out.to = v();
    else if (a === '--hours') out.hours = Number(v());
    else if (a === '--offline') out.offline = true;
    else if (a === '--schedule') out.file = resolve(v());
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const fromMs = out.from ? Date.parse(out.from) : Date.now();
  const toMs = out.to ? Date.parse(out.to) : fromMs + out.hours * 3_600_000;
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) throw new Error('--from/--to/--hours do not describe a time range');
  return { ...out, fromMs, toMs };
}

const fmt = (ms) => {
  const d = new Date(ms);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.toISOString().slice(0, 16).replace('T', ' ')}`;
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const schedule = loadSchedule(opts.file);
  const gas = process.env.CRANK_REHEARSAL_GAS_LIMIT ? BigInt(process.env.CRANK_REHEARSAL_GAS_LIMIT) : DEFAULT_REHEARSAL_GAS_LIMIT;

  let targets = { sra: 'SRA', swa: 'SWA', source: 'not fetched (--offline)' };
  if (!opts.offline) {
    targets = await loadDeployments(process.env.SOLSTICE_DEPLOYMENTS || DEFAULT_DEPLOYMENTS, REHEARSAL_CHAIN_ID);
  }

  const now = Date.now();
  const rows = schedule.entries
    .filter((e) => e.notBeforeMs < opts.toMs && e.notAfterMs > opts.fromMs)
    .map((e) => {
      const revert = e.expectParsed.kind === 'revert';
      const decision = e.done
        ? `skip: runbook status "${e.status}"`
        : e.notAfterMs <= now + SEND_MARGIN_MS
          ? 'CLOSED'
          : e.notBeforeMs <= now
            ? 'OPEN NOW'
            : 'WOULD SEND';
      return {
        when: fmt(e.notBeforeMs),
        notBefore: e.notBefore,
        notAfter: e.notAfter,
        step: e.id,
        call: callLabel(e),
        contract: e.contract.toUpperCase(),
        to: targets[e.contract],
        expect: e.expect,
        precheck: revert ? 'none (expected revert)' : 'estimateGas x1.4',
        gas: revert ? String(tagGasLimit(gas, e.id)) : `estimate x1.4, rounded up to a million, + step tag ${stepTag(e.id)}`,
        condition: e.gateQuarter === null ? '' : `SWA next quarter = Q${e.gateQuarter}`,
        decision,
      };
    });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ from: new Date(opts.fromMs).toISOString(), to: new Date(opts.toMs).toISOString(), contracts: targets, rows }, null, 2) + '\n');
    return;
  }

  const out = [];
  out.push(`Rehearsal dry run -- nothing is sent. ${fmt(opts.fromMs)} to ${fmt(opts.toMs)} UTC`);
  out.push(`schedule ${opts.file} (${schedule.entries.length} entries, runbook csv ${schedule.source?.crankerRowsSha256?.slice(0, 12) ?? '?'})`);
  out.push(`contracts from ${targets.source}: SRA ${targets.sra}  SWA ${targets.swa}`);
  out.push('');
  if (!rows.length) out.push('Nothing scheduled in this range.');
  for (const r of rows) {
    out.push(`${r.when} UTC  step ${r.step.padEnd(5)} ${r.decision.padEnd(10)} ${r.call.padEnd(22)} -> ${r.contract} ${r.to}`);
    out.push(`${' '.repeat(28)}expect ${r.expect}; pre-check ${r.precheck}; gas ${r.gas}${r.condition ? `; only if ${r.condition}` : ''}; window closes ${r.notAfter}`);
  }
  out.push('');
  out.push('Each is sent at most once, by the first run at or after its time (both the runner clock and the chain head).');
  process.stdout.write(out.join('\n') + '\n');
}

main().catch((err) => {
  process.stderr.write(`rehearsal-plan: ${err.message}\n`);
  process.exitCode = 1;
});
