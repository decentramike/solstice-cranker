#!/usr/bin/env node
/**
 * The devnet's hands: everything that drives the chain into a state worth looking at.
 *
 * deploy.mjs, rehearsal.mjs, server.mjs and demo.mjs all sit on this module, so it owns the
 * three things they would otherwise each get subtly wrong -- which account is which, where a
 * quarter's windows actually fall, and how the packed ERC-7201 words decode.
 *
 * Nothing here is imported by the production cranker; the dependency only ever points this way.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, HDNodeWallet, JsonRpcProvider, Mnemonic, getAddress, parseUnits } from 'ethers';

import { CHAIN_ID, RPC_URL, rpc } from './node.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const DEPLOYMENT_FILE = join(HERE, '.deployed.json');
export const STATE_DIR = join(HERE, '.state');
export const RUNS_FILE = join(STATE_DIR, 'runs.ndjson');

export { CHAIN_ID, RPC_URL, rpc };

/** @dev The FVM precompile the actors delegatecall into. Empty on a plain EVM until deploy etches it. */
export const CALL_ACTOR_BY_ID = '0xfe00000000000000000000000000000000000005';

/**
 * Hardhat's documented default mnemonic. The accounts it derives are public, hold nothing
 * outside this ephemeral chain, and are referred to everywhere else by index alone -- no
 * caller of this module ever sees, logs or persists a key.
 */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

export const ACCOUNTS = {
  deployer: 0,
  cranker: 1,
  orchestrator: 2,
  sraOwner1: 3,
  sraOwner2: 4,
  swaOwner1: 5,
  swaOwner2: 6,
};

let _provider = null;
export function provider() {
  _provider ??= new JsonRpcProvider(
    RPC_URL,
    { chainId: CHAIN_ID, name: 'devnet' },
    {
      // The chain id never changes under us, so skip re-detection on every call.
      staticNetwork: true,
      // Caching off. ethers shares identical requests made within 250ms, and on an automining
      // local node two deploys land inside that window -- so the second one reuses the first's
      // cached eth_getTransactionCount and the node rejects it as "nonce too low". Real networks
      // never hit this because block times hide it; every devnet script would.
      cacheTimeout: -1,
    }
  );
  return _provider;
}

const _wallets = new Map();
/** @returns a signer for Hardhat account `index`, derived on demand and never serialised. */
export function walletAt(index) {
  if (!_wallets.has(index)) {
    const node = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(TEST_MNEMONIC), `m/44'/60'/0'/0/${index}`);
    _wallets.set(index, node.connect(provider()));
  }
  return _wallets.get(index);
}

export function addressOf(index) {
  return walletAt(index).address;
}

// ---------------------------------------------------------------------------
// Artifacts and deployment record
// ---------------------------------------------------------------------------

const ARTIFACTS = {
  ServiceRewardsActor: 'contracts/solstice/ServiceRewardsActor.sol/ServiceRewardsActor.json',
  StreamWeightActor: 'contracts/solstice/StreamWeightActor.sol/StreamWeightActor.json',
  ERC1967Proxy: '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json',
  MockCallActorById: 'contracts/mocks/MockCallActorById.sol/MockCallActorById.json',
  MockCallActorByIdFailing: 'contracts/mocks/MockCallActorById.sol/MockCallActorByIdFailing.json',
  MockCallActorByIdSilent: 'contracts/mocks/MockCallActorById.sol/MockCallActorByIdSilent.json',
};

export function artifactOf(name) {
  const rel = ARTIFACTS[name];
  if (!rel) throw new Error(`no artifact mapping for ${name}`);
  const file = join(HERE, 'artifacts', rel);
  if (!existsSync(file)) {
    throw new Error(`missing artifact ${rel} -- run "npm run contracts:build" first`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadDeployment() {
  if (!existsSync(DEPLOYMENT_FILE)) {
    throw new Error(`no ${DEPLOYMENT_FILE} -- run "npm run devnet:deploy" first`);
  }
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

export function deploymentExists() {
  return existsSync(DEPLOYMENT_FILE);
}

export function writeDeployment(record) {
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(record, null, 2) + '\n');
  return record;
}

export function sra(signerOrIndex = null) {
  const d = loadDeployment();
  return new Contract(d.sra, artifactOf('ServiceRewardsActor').abi, _runner(signerOrIndex));
}

export function swa(signerOrIndex = null) {
  const d = loadDeployment();
  return new Contract(d.swa, artifactOf('StreamWeightActor').abi, _runner(signerOrIndex));
}

function _runner(signerOrIndex) {
  if (signerOrIndex === null || signerOrIndex === undefined) return provider();
  return typeof signerOrIndex === 'number' ? walletAt(signerOrIndex) : signerOrIndex;
}

// ---------------------------------------------------------------------------
// Time travel
// ---------------------------------------------------------------------------

export async function currentEpoch() {
  return Number(await rpc('eth_blockNumber'));
}

/** Mines `n` blocks in one RPC. EDR fast-forwards without materialising every block. */
export async function mineEpochs(n) {
  const count = Number(n);
  if (!Number.isInteger(count) || count < 0) throw new Error(`mineEpochs(${n}): not a block count`);
  if (count === 0) return currentEpoch();
  await rpc('hardhat_mine', ['0x' + count.toString(16)], { timeoutMs: 120_000 });
  return currentEpoch();
}

/** Mines forward to exactly `epoch`. Refuses to go backwards -- only evm_revert can do that. */
export async function mineTo(epoch) {
  const target = Number(epoch);
  const now = await currentEpoch();
  if (target < now) throw new Error(`mineTo(${target}): already at epoch ${now}; blocks do not un-mine`);
  return mineEpochs(target - now);
}

export async function snapshot() {
  return rpc('evm_snapshot');
}

export async function revertTo(id) {
  const ok = await rpc('evm_revert', [id]);
  if (!ok) throw new Error(`evm_revert(${id}) refused -- snapshot ids are single-use and ordered`);
  return ok;
}

// ---------------------------------------------------------------------------
// Quarter geometry
//
// Mirrors ServiceRewardsActor._quarterStart / _inPostingWindow / _afterBinding exactly. The
// contract's POST_PERIOD and VERIFICATION_WINDOW are `private immutable` and unreadable, so
// these come from the deployment record -- the same blind spot the production cranker has.
// ---------------------------------------------------------------------------

export function quarterGeometry(epoch, d = loadDeployment()) {
  const { activationEpoch, epochsPerQuarter, postPeriod, verificationWindow } = d;
  const quarter = epoch < activationEpoch ? 0 : Math.floor((epoch - activationEpoch) / epochsPerQuarter);
  const quarterStart = activationEpoch + quarter * epochsPerQuarter;
  const postEnd = quarterStart + postPeriod;
  const bindingEpoch = postEnd + verificationWindow;
  const nextQuarterStart = quarterStart + epochsPerQuarter;

  let phase;
  if (epoch < activationEpoch) phase = 'pre-activation';
  else if (epoch < postEnd) phase = 'posting';
  else if (epoch < bindingEpoch) phase = 'verification';
  else phase = 'bound';

  const nextPhaseEpoch =
    phase === 'pre-activation' ? activationEpoch
      : phase === 'posting' ? postEnd
        : phase === 'verification' ? bindingEpoch
          : nextQuarterStart;

  return {
    quarter,
    phase,
    quarterStart,
    postEnd,
    bindingEpoch,
    nextQuarterStart,
    epochsUntilNextPhase: nextPhaseEpoch - epoch,
  };
}

export function quarterStartOf(q, d = loadDeployment()) {
  return d.activationEpoch + q * d.epochsPerQuarter;
}

/** Epoch at which quarter q's volumes bind and submitShares(q) opens. */
export function bindingEpochOf(q, d = loadDeployment()) {
  return quarterStartOf(q, d) + d.postPeriod + d.verificationWindow;
}

/**
 * submitShares(q) is accepted on [binding(q), binding(q+1)) -- exactly one quarter wide.
 * Past the upper edge the contract answers NotLatestQuarter, not NotBound.
 */
export function submitWindowOf(q, d = loadDeployment()) {
  return { open: bindingEpochOf(q, d), close: bindingEpochOf(q + 1, d) };
}

// ---------------------------------------------------------------------------
// Orchestrator actions
// ---------------------------------------------------------------------------

/**
 * Posts one orchestrator's quarterly USD volume as the seated initial orchestrator.
 *
 * `usd` is a decimal *string* on the way in and a FixedU18 (uint256, 18 decimals) on the way
 * out -- the same no-floats discipline the data contract asks for. Mines into the posting
 * window first if we are early; refuses rather than silently no-op if we are late, because a
 * missed posting window is a scenario the rehearsal wants to stage deliberately, never by accident.
 */
export async function postVolume(quarter, usd, { autoAdvance = true, from = ACCOUNTS.orchestrator } = {}) {
  const d = loadDeployment();
  if (quarter === 0) throw new Error('postVolume: quarter 0 is reserved (InvalidQuarter)');

  const start = quarterStartOf(quarter, d);
  const end = start + d.postPeriod;
  let now = await currentEpoch();

  if (now < start) {
    if (!autoAdvance) throw new Error(`postVolume(${quarter}): window opens at ${start}, now ${now}`);
    now = await mineTo(start);
  }
  if (now >= end) {
    throw new Error(
      `postVolume(${quarter}): posting window [${start}, ${end}) closed at epoch ${now} -- ` +
        `the chain cannot go back, only evm_revert can`
    );
  }

  const tx = await sra(from).postVolume(quarter, parseUnits(String(usd), 18));
  const receipt = await tx.wait();
  return { txHash: receipt.hash, quarter, usd: String(usd), epoch: await currentEpoch() };
}

// ---------------------------------------------------------------------------
// Packed storage reads
//
// Both structs are ERC-7201 namespaced, so the base slot is a constant rather than something
// the compiler hands us. Solidity packs a word from its low-order end, so within the 32-byte
// word the FIRST declared field lives in the LAST bytes of the hex string. Offsets below are
// byte offsets from the low end, matching config/storage-slots.json.
// ---------------------------------------------------------------------------

const SLOTS = JSON.parse(readFileSync(join(ROOT, 'config', 'storage-slots.json'), 'utf8'));

function slotPlus(base, n) {
  return '0x' + (BigInt(base) + BigInt(n)).toString(16).padStart(64, '0');
}

async function readSlot(address, slot) {
  return rpc('eth_getStorageAt', [address, slot, 'latest']);
}

/** Pulls `bytes` bytes starting `offsetBytes` from the word's low-order end. */
export function unpack(word, offsetBytes, bytes) {
  const value = BigInt(word);
  const mask = (1n << BigInt(bytes * 8)) - 1n;
  return (value >> BigInt(offsetBytes * 8)) & mask;
}

export async function readSraQuarterState(address = null) {
  const d = loadDeployment();
  const addr = address ?? d.sra;
  const base = SLOTS.sraQuarter.slot;
  const word0 = await readSlot(addr, base);

  const out = { raw: { word0 } };
  for (const f of SLOTS.sraQuarter.layout) {
    out[f.name] = Number(unpack(word0, f.offsetBytes, f.bytes));
  }
  // Tags carry quarter + 1 so that 0 can mean "never written"; decode to the real quarter or null.
  out.mirrorAQuarterDecoded = out.mirrorAQuarter === 0 ? null : out.mirrorAQuarter - 1;
  out.mirrorBQuarterDecoded = out.mirrorBQuarter === 0 ? null : out.mirrorBQuarter - 1;
  out.totalUsdSlotBase = slotPlus(base, 1);
  return out;
}

/** totalUsd is the mapping immediately after the packed word, so its base slot is QUARTER_SLOT + 1. */
export async function readQuarterTotalUsd(quarter, address = null) {
  const d = loadDeployment();
  const addr = address ?? d.sra;
  const mappingSlot = slotPlus(SLOTS.sraQuarter.slot, 1);
  const key = '0x' + BigInt(quarter).toString(16).padStart(64, '0') + mappingSlot.slice(2);
  const { keccak256 } = await import('ethers');
  return BigInt(await readSlot(addr, keccak256(key)));
}

export async function readSwaGateState(address = null) {
  const d = loadDeployment();
  const addr = address ?? d.swa;
  const base = SLOTS.swaGateParams.slot;

  const words = [];
  for (let i = 0; i < 4; i++) words.push(await readSlot(addr, slotPlus(base, i)));

  const out = { raw: words, gateSteps: SLOTS.swaGateParams.gateSteps };
  for (const f of SLOTS.swaGateParams.layout) {
    const v = unpack(words[f.word], f.offsetBytes, f.bytes);
    out[f.name] = f.type === 'FixedU18' ? v : Number(v);
  }
  out.complete = out.steps >= out.gateSteps;
  out.nextThreshold = nextThreshold(out.targetBase, out.targetStepRatio, out.steps);
  return out;
}

/**
 * Reimplements GateParamsLibrary.nextThreshold: base * stepRatio^steps, in FixedU18.
 * Every intermediate is floored the way the contract's unsafeMulDown floors, so this agrees
 * with the chain bit for bit rather than approximately.
 */
export function nextThreshold(base, stepRatio, steps) {
  const ONE = 10n ** 18n;
  let power = ONE;
  let b = BigInt(stepRatio);
  let e = BigInt(steps);
  if (e > 0n) {
    while (e > 1n) {
      if (e & 1n) power = (b * power) / ONE;
      b = (b * b) / ONE;
      e >>= 1n;
    }
    power = (b * power) / ONE;
  }
  return (BigInt(base) * power) / ONE;
}

/** FixedU18 -> decimal string, never through a float. */
export function formatFixed(v, decimals = 18) {
  const n = BigInt(v);
  const unit = 10n ** BigInt(decimals);
  const whole = n / unit;
  const frac = (n % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}.0`;
}

// ---------------------------------------------------------------------------
// Precompile etching
// ---------------------------------------------------------------------------

export const PRECOMPILE_VARIANTS = {
  success: 'MockCallActorById',
  failing: 'MockCallActorByIdFailing',
  silent: 'MockCallActorByIdSilent',
};

/**
 * Puts a mock's *runtime* bytecode at 0xfe..05.
 *
 * deployedBytecode, not bytecode: the constructor half of a creation blob would run here and
 * return garbage. The precompile is reached by delegatecall, so it never has a constructor moment.
 */
export async function etchPrecompile(variant = 'success') {
  const name = PRECOMPILE_VARIANTS[variant];
  if (!name) throw new Error(`unknown precompile variant "${variant}" (${Object.keys(PRECOMPILE_VARIANTS)})`);
  const runtime = artifactOf(name).deployedBytecode;
  if (!runtime || runtime === '0x') throw new Error(`${name} has no deployedBytecode`);
  await rpc('hardhat_setCode', [CALL_ACTOR_BY_ID, runtime]);
  return { variant, name, address: getAddress(CALL_ACTOR_BY_ID), bytes: (runtime.length - 2) / 2 };
}

export async function precompileEtched() {
  const code = await rpc('eth_getCode', [CALL_ACTOR_BY_ID, 'latest']);
  return code !== '0x' && code !== '0x0';
}

// ---------------------------------------------------------------------------
// Which quarter is due
// ---------------------------------------------------------------------------

/**
 * Asks the chain whether quarter q's volumes have bound.
 *
 * aggregatedFilecoinPayVolume is the cheapest honest answer: it reverts NotBound(q) before
 * binding and returns (possibly zero) USD after, so it separates "too early" from "bound but
 * empty" without trusting the locally computed geometry.
 */
export async function isQuarterBound(q, contract = null) {
  if (q < 1) return false;
  const c = contract ?? sra();
  try {
    await c.aggregatedFilecoinPayVolume.staticCall(q);
    return true;
  } catch (err) {
    if (decodeRevert(err)?.name === 'NotBound') return false;
    throw err;
  }
}

/**
 * The quarter submitShares would target: the LATEST bound one, never lastSubmittedQuarter + 1.
 *
 * submitShares(q) requires _afterBinding(q) and !_afterBinding(q + 1), so exactly one quarter is
 * ever submittable. A quarter nobody cranked is not queued behind the others -- it is gone, and
 * the next crank sends the newest one instead. Probing around a computed candidate (the same
 * shape as src/chain.mjs:observeLatestBoundQuarter) keeps this agreeing with the cranker even
 * when config/networks.json's postPeriod or verificationWindow have drifted from the deployment.
 */
export async function resolveDueQuarter(candidate, { spread = 2, contract = null } = {}) {
  const c = contract ?? sra();
  const probes = new Map();
  const bound = async (q) => {
    if (q < 1) return false;
    if (!probes.has(q)) probes.set(q, await isQuarterBound(q, c));
    return probes.get(q);
  };

  if (candidate !== null && (await bound(candidate)) && !(await bound(candidate + 1))) {
    return candidate;
  }

  const start = candidate ?? 1;
  for (let d = 1; d <= spread; d++) {
    for (const q of [start + d, start - d]) {
      if (q < 1) continue;
      if ((await bound(q)) && !(await bound(q + 1))) return q;
    }
  }

  const anyBound = [...probes.entries()].filter(([, v]) => v).map(([k]) => k);
  return anyBound.length ? Math.max(...anyBound) : null;
}

/**
 * Quarters that can never be submitted now: everything strictly between the last submission and
 * the quarter that is currently due.
 *
 * Worth materialising because the loss is otherwise invisible. Once the due quarter lands,
 * lastSubmittedQuarter jumps straight over the gap and no contract state remembers it happened.
 */
export function missedQuarters(lastSubmittedQuarter, dueQuarter) {
  if (dueQuarter === null) return [];
  const out = [];
  for (let q = lastSubmittedQuarter + 1; q < dueQuarter; q++) if (q >= 1) out.push(q);
  return out;
}

// ---------------------------------------------------------------------------
// Cranker invocation
// ---------------------------------------------------------------------------

/**
 * The cranker entrypoint, overridable only so this harness can be exercised against a stand-in
 * before the real one lands. The default is, and must stay, the production path.
 */
export const CRANK_ENTRYPOINT = process.env.CRANK_ENTRYPOINT ?? 'scripts/crank.mjs';

/**
 * Runs the cranker once, in its own process.
 *
 * Shelling out rather than importing is the point: `scripts/crank.mjs` is what a GitHub runner
 * executes, so that is what the devnet exercises. Nothing under devnet/ is ever on its import
 * graph, and the only channel between us is env in, exit code and runs.ndjson out.
 *
 * `targetQuarter` goes out as both env and argv. docs/DATA-CONTRACT.md pins the cranker's
 * output and says nothing about its input, and the "crank a stale quarter on purpose" scenario
 * has to aim it at a quarter it would never choose itself -- so send both spellings and let
 * whichever one scripts/crank.mjs settled on take effect.
 */
export async function runCranker({
  paused = false,
  targetQuarter = null,
  dryRun = false,
  entrypoint = CRANK_ENTRYPOINT,
  timeoutMs = 120_000,
} = {}) {
  const { spawnSync } = await import('node:child_process');
  const { resolve } = await import('node:path');

  // resolve, not join: an override may be absolute, and join would graft it onto ROOT.
  const entryPath = resolve(ROOT, entrypoint);
  const args = [entryPath];

  const env = {
    ...process.env,
    NETWORK: 'devnet',
    RPC_URL,
    // Hardhat account #1 -- public, valueless, local-only, and still never printed or persisted
    // by anything here. It is handed to the child process and nowhere else.
    CRANKER_PRIVATE_KEY: walletAt(ACCOUNTS.cranker).privateKey,
    CRANK_STATE_DIR: 'devnet/.state',
  };

  // config/networks.json carries 0x0 for the devnet addresses -- it is committed, and a local
  // deploy's addresses are not knowable when it is written. src/config.mjs reads SRA_ADDRESS /
  // SWA_ADDRESS ahead of the file for exactly this, so the deploy record is what the cranker
  // actually points at. Without these it loads zero addresses, concludes nothing is deployed,
  // and reports a healthy "nothing to crank" run forever.
  if (deploymentExists()) {
    const d = loadDeployment();
    env.SRA_ADDRESS = d.sra;
    env.SWA_ADDRESS = d.swa;
  }
  if (paused) env.CRANK_PAUSED = '1';
  if (dryRun) env.CRANK_DRY_RUN = '1';
  if (targetQuarter !== null) {
    env.CRANK_TARGET_QUARTER = String(targetQuarter);
    args.push(`--quarter=${targetQuarter}`);
  }

  const proc = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: timeoutMs });
  return {
    entrypoint,
    entryPath,
    exitCode: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    spawnError: proc.error ? String(proc.error.message) : null,
  };
}

export function crankerEntrypointExists() {
  return existsSync(join(ROOT, CRANK_ENTRYPOINT)) || existsSync(CRANK_ENTRYPOINT);
}

// ---------------------------------------------------------------------------
// Error decoding -- shared by the rehearsal's assertions and the server's event feed
// ---------------------------------------------------------------------------

const SELECTORS = JSON.parse(readFileSync(join(ROOT, 'abi', 'selectors.json'), 'utf8'));

/**
 * Event topics by name, inverted out of abi/selectors.json rather than written down.
 *
 * A hand-copied topic hash is a silent failure: getLogs matches nothing and the feed just looks
 * quiet. Deriving them means a renamed or re-typed event breaks loudly at startup instead.
 */
export const TOPICS = Object.fromEntries(
  Object.entries(SELECTORS.events).map(([hash, sig]) => [sig.slice(0, sig.indexOf('(')), hash])
);

export function topicFor(eventName) {
  const topic = TOPICS[eventName];
  if (!topic) {
    throw new Error(
      `no topic for ${eventName} in abi/selectors.json -- re-run "npm run abi:generate" ` +
        `(known: ${Object.keys(TOPICS).join(', ')})`
    );
  }
  return topic;
}

/** Maps a revert blob back to its custom-error signature, e.g. "NotBound(uint64)" -> "NotBound". */
export function decodeRevert(err) {
  const data =
    err?.data ??
    err?.info?.error?.data ??
    err?.error?.data ??
    (typeof err?.value === 'string' ? err.value : null);
  if (typeof data !== 'string' || data.length < 10) return null;
  const sig = SELECTORS.errors[data.slice(0, 10)];
  if (!sig) return { name: null, selector: data.slice(0, 10), signature: null, args: [] };
  return { name: sig.slice(0, sig.indexOf('(')), selector: data.slice(0, 10), signature: sig, data };
}

export { SELECTORS };
