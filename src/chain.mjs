/**
 * Chain access: provider, signer, contract handles, and the few raw storage reads that
 * turn "is a crank due?" from an inference into a fact.
 *
 * Two of the four timing parameters are readable on chain (ACTIVATION_EPOCH via
 * quarterStart(0), and EPOCHS_PER_QUARTER directly), and the two pieces of progress state
 * the cranker cares about -- lastSubmittedQuarter on the SRA, lastCheckedQuarter and the
 * gate's step count on the SWA -- live in ERC-7201 namespaced slots with no public getter.
 * Reading them costs nothing and removes all the guesswork.
 */
import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers';

import sraAbi from '../abi/ServiceRewardsActor.json' with { type: 'json' };
import swaAbi from '../abi/StreamWeightActor.json' with { type: 'json' };
import { STORAGE_SLOTS, ZERO_ADDRESS, safeHost } from './config.mjs';
import { classifyRevert, isTransportFailure } from './errors.mjs';
import { log } from './logger.mjs';

const GATE_STEPS = BigInt(STORAGE_SLOTS.swaGateParams.gateSteps);

/**
 * Retries transport failures only.
 *
 * A revert is an answer, not a failure, and retrying one wastes the run's budget while
 * telling us nothing new. Filecoin RPC endpoints do drop requests under load, so genuine
 * network errors get a few attempts with backoff.
 */
export async function withRetry(fn, { attempts = 4, baseMs = 750, what = 'rpc call' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransportFailure(err)) throw err;
      if (i === attempts - 1) break;
      const delay = baseMs * 2 ** i;
      log.warn(`${what} failed, retrying`, { attempt: i + 1, of: attempts, inMs: delay, error: err.shortMessage ?? err.message });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export async function connect(config) {
  const provider = new JsonRpcProvider(config.rpcUrl, Number(config.chainId), {
    staticNetwork: true, // no chainId round-trip per call
    batchMaxCount: 1, // Lotus is unhappy with large JSON-RPC batches

    // Disable ethers' 250ms request coalescing. It dedupes identical in-flight requests,
    // including eth_getTransactionCount -- so the second transaction of a run is handed
    // the first one's nonce and the node rejects it as already used. The gate catch-up
    // loop sends up to eight transactions milliseconds apart, so this is not a devnet
    // artefact: it would drop every gate check after the first on calibnet and mainnet too.
    cacheTimeout: -1,
  });

  // Ask the node itself. provider.getNetwork() cannot answer this: with an explicit network
  // argument and staticNetwork, ethers replies from the constant it was handed and never
  // sends eth_chainId, so comparing it to config compares config with itself and passes
  // however wrong RPC_URL is.
  const reported = await withRetry(() => provider.send('eth_chainId', []), { what: 'eth_chainId' });
  const actualChainId = BigInt(reported);
  if (actualChainId !== config.chainId) {
    throw new Error(
      `RPC at ${safeHost(config.rpcUrl)} reports chain ${actualChainId}, but NETWORK=${config.networkName} ` +
        `expects ${config.chainId}. RPC_URL and NETWORK disagree -- one of them is pointed at the wrong network.`
    );
  }

  // No key means a read-only session: the contracts are attached to the provider, so any
  // attempt to broadcast from them fails loudly rather than silently doing nothing.
  const wallet = config.privateKey ? new Wallet(config.privateKey, provider) : null;
  const runner = wallet ?? provider;

  const sra = new Contract(config.addresses.sra, sraAbi, runner);
  const swa = new Contract(config.addresses.swa, swaAbi, runner);

  return { provider, wallet, sra, swa, address: wallet?.address ?? null, readOnly: !wallet };
}

/** True when an address actually has contract code. Catches a stale or wrong address early. */
export async function hasCode(provider, address) {
  if (address === ZERO_ADDRESS) return false;
  const code = await withRetry(() => provider.getCode(address), { what: 'getCode' });
  return code !== undefined && code !== null && code !== '0x' && code.length > 2;
}

/**
 * The two timing parameters the chain will tell us.
 *
 * quarterStart(0) is ACTIVATION_EPOCH by definition, since quarterStart(q) is
 * ACTIVATION_EPOCH + q * EPOCHS_PER_QUARTER. POST_PERIOD and VERIFICATION_WINDOW have no
 * accessor and must still come from config.
 */
export async function readChainGeometry(sra) {
  const [activationEpoch, epochsPerQuarter] = await Promise.all([
    withRetry(() => sra.quarterStart(0), { what: 'quarterStart(0)' }),
    withRetry(() => sra.EPOCHS_PER_QUARTER(), { what: 'EPOCHS_PER_QUARTER()' }),
  ]);
  return { activationEpoch: BigInt(activationEpoch), epochsPerQuarter: BigInt(epochsPerQuarter) };
}

/** Reads one 32-byte word at `slot + index`. */
async function readWord(provider, address, slot, index) {
  const target = '0x' + (BigInt(slot) + BigInt(index)).toString(16).padStart(64, '0');
  const raw = await withRetry(() => provider.getStorage(address, target), { what: 'eth_getStorageAt' });
  return BigInt(raw);
}

/** Solidity packs struct fields from the low-order end of the word. */
const unpack = (word, offsetBytes, sizeBytes) =>
  (word >> (8n * BigInt(offsetBytes))) & ((1n << (8n * BigInt(sizeBytes))) - 1n);

/**
 * SRA quarter progress. `lastSubmittedQuarter` is the authoritative answer to
 * "has this quarter's share map already been installed?".
 */
export async function readSraQuarterState(provider, sraAddress) {
  const { slot } = STORAGE_SLOTS.sraQuarter;
  const word = await readWord(provider, sraAddress, slot, 0);
  // Mirror tags store quarter + 1 precisely so that 0 can mean "never written"; decoding
  // has to preserve that distinction rather than reporting a quarter of -1.
  const tag = (offset) => {
    const raw = Number(unpack(word, offset, 8));
    return raw === 0 ? null : raw - 1;
  };
  return {
    lastSubmittedQuarter: Number(unpack(word, 0, 8)),
    mirrorAQuarter: tag(8),
    mirrorBQuarter: tag(16),
  };
}

/**
 * SWA gate progress.
 *
 * Layout is `{ uint64 lastCheckedQuarter; GateParams params; }` where GateParams is
 * `{ VolumeTarget target; uint64 steps; }` and VolumeTarget is two FixedU18 words. A struct
 * member always starts a fresh slot, so: word 0 lastCheckedQuarter, word 1 base,
 * word 2 stepRatio, word 3 steps.
 */
export async function readSwaGateState(provider, swaAddress) {
  const { slot } = STORAGE_SLOTS.swaGateParams;
  const [w0, base, stepRatio, w3] = await Promise.all([
    readWord(provider, swaAddress, slot, 0),
    readWord(provider, swaAddress, slot, 1),
    readWord(provider, swaAddress, slot, 2),
    readWord(provider, swaAddress, slot, 3),
  ]);

  const steps = unpack(w3, 0, 8);
  return {
    lastCheckedQuarter: Number(unpack(w0, 0, 8)),
    targetBase: base,
    targetStepRatio: stepRatio,
    steps: Number(steps),
    gateSteps: Number(GATE_STEPS),
    complete: steps >= GATE_STEPS,
  };
}

/**
 * Asks the chain directly whether quarter q is bound.
 *
 * aggregatedFilecoinPayVolume reverts NotBound(q) before binding and returns a value
 * (possibly zero, legitimately) after. Nothing else distinguishes the two, which is why
 * this is a probe rather than a read.
 */
export async function isQuarterBound(sra, q) {
  try {
    await sra.aggregatedFilecoinPayVolume(q);
    return true;
  } catch (err) {
    if (isTransportFailure(err)) throw err;

    // Only an actual NotBound answers the question. Treating every other error as "not
    // bound" lets one malformed response -- a BAD_DATA body, a gateway swallowing the
    // revert payload -- drop the resolved quarter by one, which makes the cranker target a
    // window that has already closed: a guaranteed NotLatestQuarter and a critical alert
    // on a chain that was perfectly healthy. An unreadable answer is not a negative one.
    const verdict = classifyRevert(err);
    if (verdict.name === 'NotBound') return false;
    throw new Error(
      `aggregatedFilecoinPayVolume(${q}) failed in a way that is neither a value nor NotBound: ` +
        `${verdict.message}. Refusing to read that as "not bound".`,
      { cause: err }
    );
  }
}

/**
 * The chain's own view of the latest bound quarter, checked around the computed answer.
 *
 * Binding is monotonic, so confirming `candidate` is bound and `candidate + 1` is not is a
 * complete proof -- two calls. When the computed candidate is wrong we widen the search a
 * little rather than giving up, because knowing the true answer is what lets the cranker
 * recover from a bad config instead of silently missing a quarter.
 */
export async function observeLatestBoundQuarter(sra, candidate, { spread = 2 } = {}) {
  const probes = new Map();
  const bound = async (q) => {
    if (q < 1) return false;
    if (!probes.has(q)) probes.set(q, await isQuarterBound(sra, q));
    return probes.get(q);
  };

  if (candidate !== null && (await bound(candidate)) && !(await bound(candidate + 1))) {
    return { quarter: candidate, probes: probes.size };
  }

  const start = candidate ?? 1;
  for (let d = 1; d <= spread; d++) {
    for (const q of [start + d, start - d]) {
      if (q < 1) continue;
      if ((await bound(q)) && !(await bound(q + 1))) return { quarter: q, probes: probes.size };
    }
  }

  // Every pair probed came back (bound, bound), so the true latest is beyond the search and
  // the highest quarter seen is one the probes have positively DISPROVED -- its successor was
  // observed bound. Returning it would hand the caller the single answer known to be wrong.
  // Unreachable with any valid geometry: assertGeometry guarantees quarter q binds inside
  // time-quarter q, so the answer is always within one of the candidate. If it ever happens,
  // the honest reply is that we do not know.
  return { quarter: null, probes: probes.size, exhausted: true };
}

export async function readBalance(provider, address) {
  const wei = await withRetry(() => provider.getBalance(address), { what: 'getBalance' });
  return { wei, fil: formatEther(wei) };
}

export async function currentEpoch(provider) {
  return BigInt(await withRetry(() => provider.getBlockNumber(), { what: 'getBlockNumber' }));
}
