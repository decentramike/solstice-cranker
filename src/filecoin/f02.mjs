/**
 * f02 (the reward actor) after FIP-0118: reading its stream state and working out who can be
 * claimed for.
 *
 * Layout from FIP-0118 §2.4.2, cross-checked against the watchtower's decoder
 * (irenegia/solstice-watchtower site/lib/f02.js):
 *
 *   State.StreamsRoot -> [streams, tombstones, pending_writes_queue]
 *   stream     = [id, weight_record, distribution | null]
 *   distribution = [writer, shares[(addr, share)], payable[(addr, amount)], claimed_period[(addr, amount)]]
 *   tombstone  = [id, payable[(addr, amount)]]
 *
 * Wallets stay as raw address bytes from start to finish: they go back into the Claim params
 * exactly as f02 stored them, so no address round-trip can change which wallet is named.
 */
import { addressToString } from './address.mjs';
import { decode, decodeBigInt, fromBase64, toHex } from './cbor.mjs';

/** FRC-0042 method number of `Claim`, from solstice src/lib/FVMRewardMethod.sol. */
export const CLAIM_METHOD = 4045527845;
/** The service stream: the one the SRA writes and orchestrators are paid from. */
export const SERVICE_STREAM = 2;
/** FIP-0118 §2.4.9: Claim checks this before resolving wallets. */
export const MAX_RECIPIENTS = 64;

export const f02For = (prefix) => `${prefix}02`;

const rows = (list) => list.map(([recipient, amount]) => ({ recipient, amount: decodeBigInt(amount) }));

/** Decodes the block StreamsRoot links to. */
export function decodeStreamsState(bytes) {
  const top = decode(bytes);
  if (!Array.isArray(top) || top.length !== 3) throw new Error('f02 streams block is not the 3-tuple FIP-0118 §2.4.2 describes');
  const [streams, tombstones, queue] = top;
  return {
    streams: streams.map(([id, weight, dist]) => ({
      id: Number(id),
      weight,
      distribution: dist && {
        writer: dist[0],
        shares: dist[1].map(([recipient, share]) => ({ recipient, share: BigInt(share) })),
        payable: rows(dist[2]),
        claimedPeriod: rows(dist[3]),
      },
    })),
    tombstones: tombstones.map(([id, payable]) => ({ id: Number(id), payable: rows(payable) })),
    pendingWrites: queue.length,
  };
}

/**
 * Reads f02 and decodes its streams. Returns null before activation, when f02 has no
 * StreamsRoot yet (Mainnet until the Solstice upgrade epoch).
 */
export async function readF02(lotus, prefix) {
  const actor = await lotus.call('StateReadState', [f02For(prefix), null]);
  const root = actor?.State?.StreamsRoot?.['/'];
  if (!root) return null;
  const raw = await lotus.call('ChainReadObj', [{ '/': root }]);
  return {
    root,
    accrued: (actor.State.Accrued ?? []).map((a) => ({ id: Number(a.ID), amount: BigInt(a.Amount) })),
    ...decodeStreamsState(fromBase64(raw)),
  };
}

/**
 * Every wallet that could hold a claimable amount in `streamId`: its share-map recipients
 * (live portion of the current period) and its payable rows (closed periods), or, if the
 * stream was removed, its tombstone's payable rows. Deduplicated by exact bytes, in stable
 * order. Whether each one is actually owed anything is for the simulation to say.
 */
export function candidateWallets(f02State, streamId = SERVICE_STREAM) {
  const seen = new Map();
  const add = (bytes) => {
    const k = toHex(bytes);
    if (!seen.has(k)) seen.set(k, bytes);
  };
  const stream = f02State.streams.find((s) => s.id === streamId);
  if (stream?.distribution) {
    for (const r of stream.distribution.shares) add(r.recipient);
    for (const r of stream.distribution.payable) add(r.recipient);
  }
  for (const t of f02State.tombstones.filter((t) => t.id === streamId)) {
    for (const r of t.payable) add(r.recipient);
  }
  return [...seen.values()];
}

/** True when anyone has claimed against the current period of `streamId` (a fold clears it). */
export function claimedThisPeriod(f02State, streamId = SERVICE_STREAM) {
  const stream = f02State.streams.find((s) => s.id === streamId);
  return Boolean(stream?.distribution?.claimedPeriod.some((r) => r.amount > 0n));
}

/** Chunks wallets into batches of at most MAX_RECIPIENTS. */
export function batch(wallets, size = MAX_RECIPIENTS) {
  if (!Number.isInteger(size) || size < 1 || size > MAX_RECIPIENTS) throw new Error(`batch size must be 1..${MAX_RECIPIENTS}`);
  const out = [];
  for (let i = 0; i < wallets.length; i += size) out.push(wallets.slice(i, i + size));
  return out;
}

export const describeWallet = (bytes, prefix) => {
  try {
    return addressToString(bytes, prefix);
  } catch {
    return '0x' + toHex(bytes);
  }
};
