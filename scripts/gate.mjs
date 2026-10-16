#!/usr/bin/env node
/**
 * The first step of every scheduled workflow: is there work right now?
 *
 *   node scripts/gate.mjs crank | watchdog | claim
 *
 * Runs before `npm ci` and holds no key: it imports only Node built-ins and src/windows.mjs,
 * and reads config/schedule.<NETWORK>.json. Outside a window it answers from the file alone
 * and makes no network call at all. Inside a crank window it makes three keyless
 * eth_getStorageAt reads, because a window closes only on confirmed chain state.
 *
 * Writes `go=true|false` (and for claim, `mode` and `quarter`) to $GITHUB_OUTPUT, and a line to
 * the job summary. Always exits 0: a gate that fails would look like a failed crank.
 *
 * Fail-open rules: for the crank and the watchdog, a missing or mismatched schedule file or an
 * unreadable chain means go=true, because a wasted run costs seconds and a skipped one can cost
 * a quarter. For the Claim, which has no deadline, only the weekly and manual triggers go.
 *
 * Env: NETWORK, RPC_URL (crank/watchdog closure probe), SRA_ADDRESS/SWA_ADDRESS (optional),
 * GITHUB_EVENT_NAME, EVENT_SCHEDULE (the cron string that fired), IGNORE_WINDOW,
 * GATE_NOW (ISO time, tests only), GATE_EPOCH (devnet only).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { crankWindowAt, decideClaim, decideCrank, decideWatchdog, scheduleMatchesConfig, unixToEpoch } from '../src/windows.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WEEKLY_CLAIM_CRON = '41 14 * * 3';

const blank = (v) => v === undefined || v === '';
const truthy = (v) => !blank(v) && !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());

function output(fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}=${v ?? ''}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  process.stdout.write(lines.join('\n') + '\n');
}

function summary(line) {
  process.stderr.write(line + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n');
}

async function storageWord(rpcUrl, address, slot, index) {
  const target = '0x' + (BigInt(slot) + BigInt(index)).toString(16).padStart(64, '0');
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getStorageAt', params: [address, target, 'latest'] }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (body.error || typeof body.result !== 'string') throw new Error(body.error?.message ?? 'no result');
  return BigInt(body.result);
}

/** lastSubmittedQuarter, lastCheckedQuarter, gate completion -- the same slots src/chain.mjs reads. */
export async function probeChain(rpcUrl, sra, swa) {
  const slots = JSON.parse(readFileSync(join(ROOT, 'config', 'storage-slots.json'), 'utf8'));
  const low64 = (w) => Number(w & ((1n << 64n) - 1n));
  const [s0, g0, g3] = await Promise.all([
    storageWord(rpcUrl, sra, slots.sraQuarter.slot, 0),
    storageWord(rpcUrl, swa, slots.swaGateParams.slot, 0),
    storageWord(rpcUrl, swa, slots.swaGateParams.slot, 3),
  ]);
  return {
    lastSubmittedQuarter: low64(s0),
    lastCheckedQuarter: low64(g0),
    gateComplete: low64(g3) >= slots.swaGateParams.gateSteps,
  };
}

export async function gate(kind, env = process.env) {
  const network = blank(env.NETWORK) ? 'calibnet' : env.NETWORK;
  const event = env.GITHUB_EVENT_NAME ?? 'manual';
  const manual = event === 'workflow_dispatch' && truthy(env.IGNORE_WINDOW);

  const file = join(ROOT, 'config', `schedule.${network}.json`);
  const networks = JSON.parse(readFileSync(join(ROOT, 'config', 'networks.json'), 'utf8'));
  let sched = null;
  let problem = null;
  if (!existsSync(file)) problem = `config/schedule.${network}.json is missing; run npm run schedule`;
  else {
    sched = JSON.parse(readFileSync(file, 'utf8'));
    const diffs = sched.network !== network ? [`file is for ${sched.network}`] : scheduleMatchesConfig(sched, networks[network]);
    if (diffs.length) {
      problem = `config/schedule.${network}.json does not match config/networks.json (${diffs.join('; ')}); run npm run schedule`;
      sched = null;
    }
  }

  if (!sched) {
    summary(`> **Gate (${kind}):** ${problem}.`);
    if (kind === 'claim') {
      const go = event === 'workflow_dispatch' || env.EVENT_SCHEDULE === WEEKLY_CLAIM_CRON;
      return { go, mode: go ? (event === 'workflow_dispatch' ? 'manual' : 'weekly') : '', quarter: '', reason: problem };
    }
    return { go: true, reason: `${problem}; running anyway` };
  }

  const epoch = !blank(env.GATE_EPOCH)
    ? Number(env.GATE_EPOCH)
    : unixToEpoch(sched, Math.floor((blank(env.GATE_NOW) ? Date.now() : Date.parse(env.GATE_NOW)) / 1000));

  if (kind === 'claim') {
    const trigger = event === 'workflow_dispatch' ? 'manual' : env.EVENT_SCHEDULE === WEEKLY_CLAIM_CRON ? 'weekly' : 'hourly';
    const d = decideClaim({ sched, epoch, trigger });
    return { go: d.go, mode: d.mode ?? '', quarter: d.quarter ?? '', reason: d.reason };
  }

  const sraAddr = blank(env.SRA_ADDRESS) ? sched.addresses.sra : env.SRA_ADDRESS;
  const swaAddr = blank(env.SWA_ADDRESS) ? sched.addresses.swa : env.SWA_ADDRESS;
  const rpcUrl = blank(env.RPC_URL) ? networks[network].rpcUrl : env.RPC_URL;
  const readChain = async () => {
    try {
      return await probeChain(rpcUrl, sraAddr, swaAddr);
    } catch (err) {
      summary(`> **Gate (${kind}):** chain state unreadable (${err.message}); treating the window as open.`);
      return null;
    }
  };

  if (kind === 'crank') {
    // Outside a window by the clock (or thinned out), the file decides alone: no network call.
    const w = crankWindowAt(sched, epoch);
    if (manual || !w || w.thinnedOut) return decideCrank({ sched, epoch, chain: null, ignoreWindow: manual });
    return decideCrank({ sched, epoch, chain: await readChain() });
  }

  if (kind === 'watchdog') {
    if (event === 'workflow_dispatch') return decideWatchdog({ sched, epoch, chain: null, utcHour: 0, manual: true });
    const hour = new Date(blank(env.GATE_NOW) ? Date.now() : Date.parse(env.GATE_NOW)).getUTCHours();
    const chain = crankWindowAt(sched, epoch) ? await readChain() : null;
    return decideWatchdog({ sched, epoch, chain, utcHour: hour });
  }

  throw new Error(`unknown gate "${kind}"`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const kind = process.argv[2];
  try {
    const d = await gate(kind);
    summary(`**Gate (${kind}, ${process.env.NETWORK || 'calibnet'}):** ${d.go ? 'run' : 'skip'} -- ${d.reason}`);
    output(kind === 'claim' ? { go: d.go, mode: d.mode, quarter: d.quarter } : { go: d.go });
  } catch (err) {
    // Never block the crank on a bug in the gate.
    summary(`**Gate (${kind}):** error (${err.message}); ${kind === 'claim' ? 'skipping' : 'running anyway'}`);
    output(kind === 'claim' ? { go: false, mode: '', quarter: '' } : { go: true });
  }
}
