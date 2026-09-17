#!/usr/bin/env node
/**
 * Starts (or adopts) the local Hardhat EDR node the rest of devnet/ talks to.
 *
 * Idempotent on purpose: `npm run demo` and `npm run rehearsal` both want a node, and a
 * developer usually already has one open in another terminal. Killing and restarting it
 * would throw away the deployment and the mined history, so anything already answering on
 * 8545 with our chainId is adopted as-is. A *different* chain on that port is a hard error
 * rather than a silent adoption -- deploying quarter geometry onto someone else's chain is
 * the kind of mistake that costs an hour to notice.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/**
 * "Was this module run directly?"
 *
 * Via pathToFileURL, not string-concatenating argv[1] onto `file://`: the checkout path can
 * contain spaces (this one does), and import.meta.url percent-encodes them while a raw argv
 * path does not. The naive comparison silently never matches and every entrypoint here becomes
 * an inert import -- which is exactly the bug this replaced.
 */
export function isMain(moduleUrl) {
  return process.argv[1] !== undefined && moduleUrl === pathToFileURL(process.argv[1]).href;
}

export const HOST = '127.0.0.1';
export const PORT = 8545;
export const RPC_URL = `http://${HOST}:${PORT}`;
export const CHAIN_ID = 3141592;

/** @dev Raw JSON-RPC, so node.mjs stays usable before ethers has anything to connect to. */
export async function rpc(method, params = [], { timeoutMs = 2000 } = {}) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** @returns the chainId answering on 8545, or null when nothing is listening. */
export async function probe() {
  try {
    return Number(await rpc('eth_chainId'));
  } catch {
    return null;
  }
}

async function waitForRpc(deadlineMs, child) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`hardhat node exited early with code ${child.exitCode}`);
    }
    const id = await probe();
    if (id !== null) return id;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no JSON-RPC on ${RPC_URL} after ${deadlineMs}ms`);
}

/**
 * Brings a devnet node up if one is not already there.
 * @returns {Promise<{child: import('node:child_process').ChildProcess|null, reused: boolean}>}
 */
export async function ensureNode({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  const existing = await probe();
  if (existing !== null) {
    if (existing !== CHAIN_ID) {
      throw new Error(
        `port ${PORT} is busy with chainId ${existing}, expected ${CHAIN_ID}. ` +
          `Stop that node (or free the port) and try again.`
      );
    }
    log(`[node] reusing the devnet already listening on ${RPC_URL} (chainId ${existing})`);
    return { child: null, reused: true };
  }

  log(`[node] starting hardhat node on ${RPC_URL} ...`);
  const child = spawn(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'hardhat', 'internal', 'cli', 'bootstrap.js'),
      'node',
      '--config',
      join(HERE, 'hardhat.config.cjs'),
      '--hostname',
      HOST,
      '--port',
      String(PORT),
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  // Hardhat prints the test accounts *and their private keys* on boot. We never relay that
  // stream; only lines that look like errors are surfaced, so a key cannot reach our stdout.
  child.stdout.on('data', () => {});
  child.stderr.on('data', (b) => process.stderr.write(`[node:err] ${b}`));

  const id = await waitForRpc(30_000, child);
  if (id !== CHAIN_ID) throw new Error(`node came up with chainId ${id}, expected ${CHAIN_ID}`);
  log(`[node] up on ${RPC_URL} (chainId ${id}, pid ${child.pid})`);
  return { child, reused: false };
}

/** @dev Funded, deterministic, publicly documented Hardhat accounts -- addresses only. */
export async function listAccounts() {
  const addresses = await rpc('eth_accounts');
  const rows = [];
  for (let i = 0; i < addresses.length; i++) {
    const wei = BigInt(await rpc('eth_getBalance', [addresses[i], 'latest']));
    rows.push({ index: i, address: addresses[i], fil: (wei / 10n ** 15n).toString() });
  }
  return rows;
}

export function printAccounts(rows) {
  console.log('\n[node] funded accounts (Hardhat defaults -- worthless, local only):');
  for (const r of rows) {
    const fil = `${r.fil.slice(0, -3) || '0'}.${r.fil.slice(-3)}`;
    console.log(`  #${String(r.index).padStart(2)}  ${r.address}  ${fil} FIL`);
  }
  console.log('  (private keys are never printed; scripts address these by index)\n');
}

async function main() {
  const { child, reused } = await ensureNode();
  printAccounts(await listAccounts());
  console.log(`[node] epoch (block) = ${Number(await rpc('eth_blockNumber'))}`);

  if (reused) {
    console.log('[node] adopted an existing node -- leaving it running, nothing to supervise.');
    return;
  }

  const shutdown = (signal) => {
    console.log(`\n[node] ${signal} -- stopping hardhat node (pid ${child.pid})`);
    child.kill('SIGTERM');
    // A hung EDR should not keep the terminal hostage.
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('[node] ready. Ctrl-C to stop.');
  await new Promise((resolve) => child.on('exit', (code) => {
    console.log(`[node] hardhat node exited (${code})`);
    resolve();
  }));
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[node] ${err.message}`);
    process.exit(1);
  });
}
