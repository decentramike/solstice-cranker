#!/usr/bin/env node
/**
 * The devnet's read model: exactly the API in docs/DATA-CONTRACT.md §2, on port 8787.
 *
 * Node's own `http` and nothing else. The dashboard is a demo artefact and the production
 * cranker never serves HTTP, so a web framework here would be a dependency the real deployment
 * carries for a feature it does not have.
 *
 * Run records come from devnet/.state/runs.ndjson, which the cranker appends to; everything
 * else is read straight off the chain. Nothing is cached that the chain can contradict --
 * quarter state and gate state are re-read per request, and only the immutable log history is
 * accumulated incrementally.
 *
 * Usage: node devnet/server.mjs [--port=8787]
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AbiCoder, formatEther } from 'ethers';

import { RPC_URL, isMain, probe } from './node.mjs';
import {
  ACCOUNTS,
  ROOT,
  RUNS_FILE,
  addressOf,
  bindingEpochOf,
  currentEpoch,
  deploymentExists,
  formatFixed,
  loadDeployment,
  mineEpochs,
  missedQuarters,
  provider,
  quarterGeometry,
  readSraQuarterState,
  readSwaGateState,
  resolveDueQuarter,
  runCranker,
  topicFor,
} from './fixtures.mjs';

export const DEFAULT_PORT = 8787;

const NETWORKS = JSON.parse(readFileSync(join(ROOT, 'config', 'networks.json'), 'utf8'));

const TOPIC = {
  SharesSubmitted: topicFor('SharesSubmitted'),
  QuarterlyGateCheckResult: topicFor('QuarterlyGateCheckResult'),
  FvmActorCall: topicFor('FvmActorCall'),
};

/**
 * FRC-0042 method numbers from vendor/solstice/src/lib/FVMRewardMethod.sol, which is the only
 * authority for them. (docs/DATA-CONTRACT.md's worked example prints 3862548934 for SetShares;
 * the source says 2414422607, and the source is what the contract dispatches on.)
 */
const FVM_METHOD_NAMES = {
  386660827: 'RegisterStream',
  1623858416: 'RemoveStream',
  3362570548: 'SetWeightRecords',
  3951753085: 'StepWeightRecords',
  3872725033: 'SetDistribution',
  187585191: 'CancelPending',
  2414422607: 'SetShares',
  4045527845: 'Claim',
  3068846150: 'ReplaceAddress',
};

const coder = AbiCoder.defaultAbiCoder();
const ENVELOPE = ['uint64', 'uint256', 'uint64', 'uint64', 'bytes', 'uint64'];

// ---------------------------------------------------------------------------
// Log decoding
// ---------------------------------------------------------------------------

/**
 * The mock logs the precompile's calldata verbatim, and FVMRewards lays that out by hand with
 * an UNPADDED trailing params blob -- so the tail is rarely a multiple of 32 and a strict ABI
 * decoder rejects it outright. Zero-filling to the next word boundary is what the real
 * precompile's own reader does in effect, and it cannot change any decoded value: the length
 * prefix already bounds `params`, so the padding is never read back.
 */
function padToWord(data) {
  const body = data.slice(2);
  const need = (64 - (body.length % 64)) % 64;
  return '0x' + body + '0'.repeat(need);
}

function decodeFvmActorCall(log) {
  try {
    const [method, value, flags, codec, params, actorId] = coder.decode(ENVELOPE, padToWord(log.data));
    const m = Number(method);
    return {
      type: 'FvmActorCall',
      quarter: null,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      args: {
        actorId: Number(actorId),
        method: m,
        methodName: FVM_METHOD_NAMES[m] ?? null,
        value: value.toString(),
        flags: Number(flags),
        codec: Number(codec),
        paramsHex: params,
      },
    };
  } catch (err) {
    return {
      type: 'FvmActorCall',
      quarter: null,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      args: { undecodable: true, error: err.message, rawHex: log.data },
    };
  }
}

function decodeSharesSubmitted(log) {
  // q is indexed (topic 1); recipientCount and totalUsd ride in the data.
  const quarter = Number(BigInt(log.topics[1]));
  const [recipientCount, totalUsd] = coder.decode(['uint256', 'uint256'], log.data);
  return {
    type: 'SharesSubmitted',
    quarter,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    args: { recipientCount: Number(recipientCount), totalUsd: formatFixed(totalUsd) },
  };
}

function decodeGateResult(log) {
  const quarter = Number(BigInt(log.topics[1]));
  const [passed, steps] = coder.decode(['bool', 'uint64'], log.data);
  return {
    type: 'QuarterlyGateCheckResult',
    quarter,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    args: { passed, steps: Number(steps) },
  };
}

// ---------------------------------------------------------------------------
// Event history -- accumulated, because mined logs never change
// ---------------------------------------------------------------------------

const events = [];
let scannedThrough = -1;

async function refreshEvents(d, head) {
  const from = scannedThrough < 0 ? d.deployedAtBlock : scannedThrough + 1;
  if (from > head) return;

  const [shares, gate, fvm] = await Promise.all([
    provider().getLogs({ fromBlock: from, toBlock: head, address: d.sra, topics: [TOPIC.SharesSubmitted] }),
    provider().getLogs({ fromBlock: from, toBlock: head, address: d.swa, topics: [TOPIC.QuarterlyGateCheckResult] }),
    // The FvmActorCall log is attributed to whichever actor delegatecalled the precompile, so
    // both addresses have to be swept -- the SRA emits it for SetShares, the SWA for the gate.
    provider().getLogs({ fromBlock: from, toBlock: head, topics: [TOPIC.FvmActorCall] }),
  ]);

  for (const log of shares) events.push(decodeSharesSubmitted(log));
  for (const log of gate) events.push(decodeGateResult(log));
  for (const log of fvm) events.push(decodeFvmActorCall(log));

  events.sort((a, b) => b.blockNumber - a.blockNumber);
  scannedThrough = head;
}

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

function readRuns(limit = 50) {
  if (!existsSync(RUNS_FILE)) return [];
  const lines = readFileSync(RUNS_FILE, 'utf8').split('\n').filter((l) => l.trim());
  const out = [];
  // Newest first, and only as far back as the cap -- a long rehearsal writes hundreds.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch {
      out.push({ malformed: lines[i].slice(0, 200) });
    }
  }
  return out;
}

/**
 * Every quarter ever observed to have been missed, from the WHOLE run log.
 *
 * This has to accumulate rather than recompute. The per-snapshot gap between
 * lastSubmittedQuarter and dueQuarter is empty again the instant a later quarter lands and
 * lastSubmittedQuarter jumps over the hole -- and the contracts keep no other record, so
 * after that the loss exists nowhere on chain at all. A permanently lost quarter silently
 * disappearing off the dashboard is the single worst failure this tool could have, so the
 * union is taken over every run ever written, uncapped, not just the 50 readRuns() returns.
 */
function recordedMissedQuarters() {
  if (!existsSync(RUNS_FILE)) return [];
  const found = new Set();
  for (const line of readFileSync(RUNS_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let run;
    try {
      run = JSON.parse(line);
    } catch {
      continue;
    }
    for (const q of run.schedule?.missedQuarters ?? []) found.add(q);
    // A run that actually hit NotLatestQuarter names the quarter it lost.
    for (const action of run.actions ?? []) {
      if (action.outcome === 'missed-window' && typeof action.quarter === 'number') found.add(action.quarter);
    }
  }
  return [...found].sort((a, b) => a - b);
}

function runsFingerprint() {
  if (!existsSync(RUNS_FILE)) return 0;
  return statSync(RUNS_FILE).size;
}

// ---------------------------------------------------------------------------
// State assembly
// ---------------------------------------------------------------------------

/** Alerts are derived, not stored: anything critical the cranker reported, newest first. */
function alertsFrom(runs) {
  const out = [];
  for (const run of runs) {
    for (const action of run.actions ?? []) {
      if (action.severity === 'critical' || action.severity === 'warn') {
        out.push({
          at: run.finishedAt ?? run.startedAt ?? null,
          severity: action.severity,
          title: `${action.call} ${action.outcome ?? ''}`.trim(),
          body: action.message ?? action.reason ?? '',
        });
      }
    }
  }
  return out.slice(0, 50);
}

let paused = false;

export async function buildState() {
  const chainId = await probe();
  const connected = chainId !== null;
  const deployed = deploymentExists();

  const network = {
    name: 'devnet',
    chainId: NETWORKS.devnet.chainId,
    label: NETWORKS.devnet.label,
    epochSeconds: NETWORKS.devnet.epochSeconds,
  };

  const runs = readRuns(50);

  if (!connected || !deployed) {
    return {
      network,
      chain: { epoch: 0, connected },
      contracts: { sra: null, swa: null, deployed },
      wallet: null,
      quarters: null,
      sra: null,
      swa: null,
      runs,
      events: [],
      alerts: alertsFrom(runs),
      rehearsal: { active: false, step: 0, totalSteps: 14, label: null, log: [] },
      paused,
    };
  }

  const d = loadDeployment();
  const epoch = await currentEpoch();
  const geom = quarterGeometry(epoch, d);

  await refreshEvents(d, epoch);

  const [quarterState, gate] = await Promise.all([readSraQuarterState(), readSwaGateState()]);

  const crankerAddress = addressOf(ACCOUNTS.cranker);
  const balanceWei = await provider().getBalance(crankerAddress);
  const minBalanceFil = NETWORKS.devnet.minBalanceFil;

  // The quarter submitShares would target: the latest one whose volumes have bound, resolved by
  // asking the chain rather than by arithmetic, so a drifted postPeriod/verificationWindow in
  // config/networks.json cannot make this disagree with the cranker.
  let candidate = null;
  for (let q = 1; q <= geom.quarter + 1; q++) if (epoch >= bindingEpochOf(q, d)) candidate = q;
  const dueQuarter = await resolveDueQuarter(candidate);

  // The epoch at which the due quarter stops being the latest and starts answering
  // NotLatestQuarter. That is the real deadline, and it is one quarter after binding.
  const deadlineEpoch = dueQuarter !== null ? bindingEpochOf(dueQuarter + 1, d) : null;
  // The gap visible right now, unioned with every gap ever recorded. See recordedMissedQuarters.
  const missed = [
    ...new Set([
      ...recordedMissedQuarters(),
      ...missedQuarters(quarterState.lastSubmittedQuarter, dueQuarter),
    ]),
  ].sort((a, b) => a - b);
  const outstanding = dueQuarter !== null && quarterState.lastSubmittedQuarter !== dueQuarter;
  const atRisk =
    outstanding && deadlineEpoch !== null && deadlineEpoch - epoch <= Math.floor(d.epochsPerQuarter / 5);

  return {
    network,
    chain: { epoch, connected: true },
    contracts: { sra: d.sra, swa: d.swa, deployed: true },
    wallet: {
      address: crankerAddress,
      balanceFil: formatEther(balanceWei),
      minBalanceFil,
      belowThreshold: balanceWei < BigInt(Math.round(Number(minBalanceFil) * 1e18)),
    },
    quarters: {
      activationEpoch: d.activationEpoch,
      epochsPerQuarter: d.epochsPerQuarter,
      postPeriod: d.postPeriod,
      verificationWindow: d.verificationWindow,
      currentQuarter: geom.quarter,
      phase: geom.phase,
      quarterStartEpoch: geom.quarterStart,
      bindingEpoch: geom.bindingEpoch,
      nextQuarterStartEpoch: geom.nextQuarterStart,
      epochsUntilNextPhase: geom.epochsUntilNextPhase,
    },
    sra: {
      lastSubmittedQuarter: quarterState.lastSubmittedQuarter,
      dueQuarter,
      deadlineEpoch,
      missedQuarters: missed,
      atRisk,
    },
    swa: {
      lastCheckedQuarter: gate.lastCheckedQuarter,
      // Each quarterlyGateCheck() advances the counter by exactly one, so for the gate --
      // unlike submitShares -- "last + 1" really is what comes next.
      dueQuarter: gate.lastCheckedQuarter + 1,
      steps: gate.steps,
      gateSteps: gate.gateSteps,
      nextThresholdUsd: formatFixed(gate.nextThreshold),
      complete: gate.complete,
    },
    runs,
    events: events.slice(0, 100),
    alerts: alertsFrom(runs),
    rehearsal: { active: false, step: 0, totalSteps: 14, label: null, log: [] },
    paused,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function cors(res) {
  // Wide open, and only ever bound to localhost: this server exists to be talked to by a
  // dashboard served from some other local port, and it holds nothing worth protecting.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

function sendJson(res, status, body) {
  cors(res);
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

async function readBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('body is not valid JSON');
  }
}

const sseClients = new Set();

/**
 * One unnamed `data:` frame per change, which is what the dashboard's EventSource is built
 * against. No `event:` name and no `id:` -- a named event would need an explicit listener, and
 * an id would invite the browser to replay from a Last-Event-ID this server cannot honour.
 */
function broadcast(state) {
  const frame = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

/**
 * A comment line every 15s. Nothing consumes it -- that is the point: proxies and browsers drop
 * a stream that goes quiet, and a devnet can easily sit idle for minutes between blocks.
 */
function startHeartbeat(intervalMs = 15_000) {
  const timer = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(':heartbeat\n\n');
      } catch {
        sseClients.delete(res);
      }
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

/**
 * Pushes to SSE subscribers when the chain head moves or a new run record lands. Polling
 * rather than subscribing: EDR's filter support is uneven and the runs file has no events at
 * all, so one timer covering both is simpler than two mechanisms that can disagree.
 */
function startWatcher(intervalMs = 500) {
  let lastEpoch = -1;
  let lastRuns = -1;
  let inFlight = false;

  const timer = setInterval(async () => {
    if (inFlight || sseClients.size === 0) return;
    inFlight = true;
    try {
      const epoch = await currentEpoch();
      const runsSize = runsFingerprint();
      if (epoch !== lastEpoch || runsSize !== lastRuns) {
        lastEpoch = epoch;
        lastRuns = runsSize;
        broadcast(await buildState());
      }
    } catch {
      // A devnet that went away is a normal thing on a demo machine; the next tick retries.
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const chainId = await probe();
    return sendJson(res, 200, {
      ok: true,
      devnetUp: chainId === NETWORKS.devnet.chainId,
      deployed: deploymentExists(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(res, 200, await buildState());
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    cors(res);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify(await buildState())}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/advance') {
    const body = await readBody(req);
    const epochs = Number(body.epochs ?? 1);
    if (!Number.isInteger(epochs) || epochs < 1 || epochs > 1_000_000) {
      return sendJson(res, 400, { error: 'epochs must be an integer in [1, 1000000]' });
    }
    const epoch = await mineEpochs(epochs);
    const state = await buildState();
    broadcast(state);
    return sendJson(res, 200, { epoch, mined: epochs });
  }

  if (req.method === 'POST' && url.pathname === '/api/crank') {
    const before = runsFingerprint();
    const result = await runCranker({ paused });
    const runs = readRuns(50);
    // The record the cranker just wrote, if it wrote one.
    const latest = runsFingerprint() > before ? (runs[0] ?? null) : null;
    broadcast(await buildState());
    return sendJson(res, 200, {
      exitCode: result.exitCode,
      run: latest,
      stdout: result.stdout.slice(-4000),
      stderr: result.stderr.slice(-4000),
      spawnError: result.spawnError,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/pause') {
    const body = await readBody(req);
    if (typeof body.paused !== 'boolean') {
      return sendJson(res, 400, { error: 'body must be {"paused": true|false}' });
    }
    paused = body.paused;
    broadcast(await buildState());
    return sendJson(res, 200, { paused });
  }

  return sendJson(res, 404, { error: `no route ${req.method} ${url.pathname}` });
}

/** Ends every SSE response. An open stream is a live socket, and server.close() waits for those. */
export function closeStreams() {
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      // Already gone; the set is cleared either way.
    }
  }
  sseClients.clear();
}

export function startServer(port = DEFAULT_PORT) {
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      try {
        sendJson(res, 500, { error: err.message });
      } catch {
        // Response already committed (an SSE stream, usually). Nothing left to say.
      }
    });
  });

  startWatcher();
  startHeartbeat();

  // server.close() stops accepting but waits on live sockets, and an SSE stream never ends on
  // its own -- so a dashboard left open would hang shutdown indefinitely. Hang it off the
  // server so every caller tears down the same way.
  server.stop = () => {
    closeStreams();
    server.closeAllConnections?.();
    server.close();
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const portArg = process.argv.slice(2).find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : DEFAULT_PORT;

  const server = await startServer(port);
  console.log(`[server] listening on http://127.0.0.1:${port}`);
  console.log(`[server] chain ${RPC_URL}, runs ${RUNS_FILE}`);
  console.log('[server] routes: /api/state /api/stream /api/health /api/advance /api/crank /api/pause');

  const shutdown = () => {
    console.log('\n[server] stopping');
    server.stop();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(`[server] ${err.message}`);
    process.exit(1);
  });
}
