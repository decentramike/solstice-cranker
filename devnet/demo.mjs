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
  const out = { quarters: 4, port: DEFAULT_PORT, precompile: 'success', dashboard: true };
  for (const a of argv) {
    let m;
    if ((m = /^--quarters=(\d+)$/.exec(a))) out.quarters = Number(m[1]);
    else if ((m = /^--port=(\d+)$/.exec(a))) out.port = Number(m[1]);
    else if ((m = /^--precompile=(\w+)$/.exec(a))) out.precompile = m[1];
    else if (a === '--no-dashboard') out.dashboard = false;
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

/**
 * Starts the Vite dev server for dashboard/ and waits for it to answer.
 *
 * Never fatal: a demo that has a working chain and a working API is still worth showing,
 * so a missing node_modules or an occupied port prints what to do and carries on.
 */
async function startDashboard(apiPort) {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = join(root, 'dashboard');

  if (!existsSync(join(dir, 'node_modules'))) {
    console.log('  dashboard dependencies are not installed. Run this once:');
    console.log('    (cd dashboard && npm install)');
    console.log('  then re-run npm run demo.');
    return null;
  }

  // VITE_DEVNET_ORIGIN is what dashboard/vite.config.ts proxies /api to. No --strictPort:
  // if 5173 is taken, Vite picking the next free port is a better demo than a hard failure,
  // and the URL is read back from its output rather than assumed.
  const child = spawn('npm', ['run', 'dev'], {
    cwd: dir,
    env: { ...process.env, VITE_DEVNET_ORIGIN: `http://127.0.0.1:${apiPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => child.kill('SIGTERM'));

  // Vite prints the URL it settled on; trust that rather than assuming the default port.
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    const scan = (buf) => {
      const m = /(https?:\/\/localhost:\d+\/?)/.exec(String(buf));
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  if (!url) {
    console.log('  the dashboard did not come up in time; start it by hand:');
    console.log('    (cd dashboard && npm run dev)');
    return null;
  }
  console.log(`  Mission Control on ${url}`);
  return url;
}

const TOTAL_STEPS = 6;
let stepNo = 0;
function step(title) {
  stepNo += 1;
  console.log(`\n[${stepNo}/${TOTAL_STEPS}] ${title}`);
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

  // ---- 5. the dashboard ---------------------------------------------------
  // This is the demo. Bringing the chain and the API up but leaving the operator to start
  // the UI in a second terminal is most of the way to a demo and none of the way to one
  // that works on the first try in front of an audience.
  let dashboardUrl = null;
  if (args.dashboard) {
    step('Starting Mission Control');
    dashboardUrl = await startDashboard(args.port);
  }

  // ---- 6. done ------------------------------------------------------------
  step('Ready');

  const [quarterState, gate] = await Promise.all([readSraQuarterState(), readSwaGateState()]);
  const epoch = await currentEpoch();

  console.log(`
  ${dashboardUrl ? `Mission Control ${dashboardUrl}` : 'Mission Control  not started (--no-dashboard)'}
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
