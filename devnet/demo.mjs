#!/usr/bin/env node
/**
 * One command for the live demo: node -> deploy -> seed some history -> server -> URL.
 *
 * Written for the worst case, which is a demo in front of people: every step announces itself
 * before it runs, every failure says what to do about it, and nothing is left running when this
 * process goes away. A half-started devnet that looks fine until somebody clicks something is
 * the failure mode worth spending code on.
 *
 * Usage: node devnet/demo.mjs [--quarters=N] [--port=8787] [--precompile=success|failing|silent]
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';

import { RPC_URL, ensureNode, isMain, listAccounts, printAccounts } from './node.mjs';
import { deploy } from './deploy.mjs';
import {
  RUNS_FILE,
  STATE_DIR,
  bindingEpochOf,
  crankerEntrypointExists,
  currentEpoch,
  formatFixed,
  loadDeployment,
  mineTo,
  postVolume,
  quarterStartOf,
  readSraQuarterState,
  readSwaGateState,
  runCranker,
} from './fixtures.mjs';
import { DEFAULT_PORT, startServer } from './server.mjs';

const SEED_VOLUME = { 1: '5000', 2: '1000' }; // Q2 is under the gate's entry threshold on purpose
const DEFAULT_VOLUME = '100000000';

/** Everything this process started, in the order it should be torn down. */
const cleanups = [];
let shuttingDown = false;

function parseArgs(argv) {
  const out = { quarters: 4, port: DEFAULT_PORT, precompile: 'success' };
  for (const a of argv) {
    let m;
    if ((m = /^--quarters=(\d+)$/.exec(a))) out.quarters = Number(m[1]);
    else if ((m = /^--port=(\d+)$/.exec(a))) out.port = Number(m[1]);
    else if ((m = /^--precompile=(\w+)$/.exec(a))) out.precompile = m[1];
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

let stepNo = 0;
function step(title) {
  stepNo += 1;
  console.log(`\n[${stepNo}/5] ${title}`);
}

/**
 * Walks the chain through `quarters` quarters, posting volume and cranking after each binds,
 * so the dashboard opens onto a populated timeline instead of an empty one.
 */
async function seed(quarters) {
  const d = loadDeployment();
  const haveCranker = crankerEntrypointExists();
  if (!haveCranker) {
    console.log('  scripts/crank.mjs is missing -- seeding volume only, no run records');
  }

  let cranked = 0;
  let failed = 0;

  for (let q = 1; q <= quarters; q++) {
    const start = quarterStartOf(q, d);
    if ((await currentEpoch()) < start) await mineTo(start);

    const usd = SEED_VOLUME[q] ?? DEFAULT_VOLUME;
    await postVolume(q, usd);
    await mineTo(bindingEpochOf(q, d) + 1);

    let note = '';
    if (haveCranker) {
      const r = await runCranker({});
      cranked += 1;
      if (r.exitCode !== 0) {
        failed += 1;
        // Loud but not fatal: the demo is still worth showing, and the dashboard is where
        // the failure is meant to be visible anyway.
        note = `  <- cranker exited ${r.exitCode}`;
      }
    }
    console.log(`  Q${q}: posted ${usd} USD, advanced past binding (epoch ${await currentEpoch()})${note}`);
  }

  if (failed) {
    console.log(`\n  ! ${failed} of ${cranked} crank runs exited nonzero.`);
    console.log('    The demo still works -- those runs are in the dashboard with their reasons.');
    console.log('    Run `node devnet/rehearsal.mjs` for the scenario-by-scenario breakdown.');
  }
  return { cranked, failed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('Solstice cranker -- devnet demo');
  console.log(`  quarters to seed  ${args.quarters}`);
  console.log(`  dashboard port    ${args.port}`);
  console.log(`  precompile mock   ${args.precompile}`);

  // ---- 1. node ------------------------------------------------------------
  step(`Starting the devnet on ${RPC_URL}`);
  const { child, reused } = await ensureNode();
  if (child) {
    cleanups.push(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    });
  }
  printAccounts((await listAccounts()).slice(0, 3));

  if (reused) {
    console.log('  Reusing a node that was already running, so it may already hold state.');
  }

  // ---- 2. deploy ----------------------------------------------------------
  step('Deploying the actors and etching the FVM precompile');
  // A fresh deployment wants a fresh run log; otherwise the dashboard opens showing runs that
  // were made against contracts that no longer exist.
  if (existsSync(RUNS_FILE)) rmSync(RUNS_FILE);
  mkdirSync(STATE_DIR, { recursive: true });

  const record = await deploy({ precompile: args.precompile });

  // ---- 3. seed ------------------------------------------------------------
  step(`Seeding ${args.quarters} quarters of history`);
  await seed(args.quarters);

  // ---- 4. server ----------------------------------------------------------
  step(`Starting the devnet API on port ${args.port}`);
  let server;
  try {
    server = await startServer(args.port);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      throw new Error(
        `port ${args.port} is already in use -- stop the other server, or pass --port=NNNN`
      );
    }
    throw err;
  }
  cleanups.push(() => server.stop());

  // ---- 5. done ------------------------------------------------------------
  step('Ready');

  const [quarterState, gate] = await Promise.all([readSraQuarterState(), readSwaGateState()]);
  const epoch = await currentEpoch();

  console.log(`
  Dashboard API   http://127.0.0.1:${args.port}/api/state
  Live stream     http://127.0.0.1:${args.port}/api/stream
  Health          http://127.0.0.1:${args.port}/api/health

  SRA             ${record.sra}
  SWA             ${record.swa}
  epoch           ${epoch} (quarter geometry: ${record.epochsPerQuarter} per quarter,
                  activation ${record.activationEpoch})
  last submitted  quarter ${quarterState.lastSubmittedQuarter}
  gate            quarter ${gate.lastCheckedQuarter}, ${gate.steps}/${gate.gateSteps} steps,
                  next threshold ${formatFixed(gate.nextThreshold)} USD

  Time-travel:  curl -XPOST -H 'content-type: application/json' \\
                  -d '{"epochs":240}' http://127.0.0.1:${args.port}/api/advance
  Crank once:   curl -XPOST http://127.0.0.1:${args.port}/api/crank

  Ctrl-C to stop everything this command started.`);

  await new Promise(() => {}); // hold the process open for the server
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[demo] ${signal} -- shutting down`);
  // Reverse order: the server first, the chain it talks to last.
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      // Nothing useful to do while exiting; the process is going away regardless.
    }
  }
  setTimeout(() => process.exit(0), 500).unref();
}

if (isMain(import.meta.url)) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  main().catch((err) => {
    console.error(`\n[demo] ${err.message}`);
    shutdown('error');
    process.exitCode = 1;
  });
}
