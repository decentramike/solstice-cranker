/**
 * Shared geometry fixtures and Solidity reference implementations.
 *
 * Everything in `solidity` is a line-for-line transcription of the corresponding function in
 * vendor/solstice/src/ServiceRewardsActor.sol. The point of transcribing rather than importing
 * is that the tests then compare two independent expressions of the same rule: if src/schedule.mjs
 * is refactored, the reference does not move with it.
 *
 * Solidity source (ServiceRewardsActor.sol):
 *   _quarterStart(q)         L148-L152   ACTIVATION + q * EPOCHS_PER_QUARTER
 *   _inPostingWindow(q)      L155-L160   [E, E+POST)
 *   _inVerificationWindow(q) L162-L167   [E+POST, E+POST+VERIFY)
 *   _afterBinding(q)         L169-L173   now >= E+POST+VERIFY
 *   _quarterOf(now)          L180-L188   now < ACTIVATION ? 0 : (now-ACTIVATION)/EPQ
 *   submitShares(q)          L521-L529   q != 0, _afterBinding(q), !_afterBinding(q+1)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const NETWORKS = JSON.parse(readFileSync(join(ROOT, 'config', 'networks.json'), 'utf8'));

const geometryFrom = (name, n, activationEpoch = n.activationEpoch) => ({
  name,
  activationEpoch: BigInt(activationEpoch),
  epochsPerQuarter: BigInt(n.epochsPerQuarter),
  postPeriod: BigInt(n.postPeriod),
  verificationWindow: BigInt(n.verificationWindow),
});

/** All three real network geometries, at their configured activation epoch. */
export const NETWORK_GEOMETRIES = Object.entries(NETWORKS)
  .filter(([k]) => !k.startsWith('$'))
  .map(([k, v]) => geometryFrom(k, v));

/**
 * The same three, re-anchored at a non-zero activation epoch, plus two synthetic extremes.
 * activationEpoch = 0 hides a whole class of off-by-one (0 is the additive identity), and
 * devnet/.deployed.json actually deploys at activationEpoch 1, so this is not hypothetical.
 */
export const ALL_GEOMETRIES = [
  ...NETWORK_GEOMETRIES,
  ...Object.entries(NETWORKS)
    .filter(([k]) => !k.startsWith('$'))
    .map(([k, v]) => geometryFrom(`${k}@act=1`, v, 1)),
  geometryFrom('calibnet@act=4200000', NETWORKS.calibnet, 4_200_000),
  // Binding lands on the very last epoch of its own quarter: POST + VERIFY = EPQ - 1.
  { name: 'tight', activationEpoch: 7n, epochsPerQuarter: 100n, postPeriod: 60n, verificationWindow: 39n },
  // The smallest geometry the SRA constructor accepts: POST = VERIFY = 1, EPQ = 3.
  { name: 'minimal', activationEpoch: 0n, epochsPerQuarter: 3n, postPeriod: 1n, verificationWindow: 1n },
  { name: 'minimal@act=5', activationEpoch: 5n, epochsPerQuarter: 3n, postPeriod: 1n, verificationWindow: 1n },
];

/** Line-for-line transcription of the SRA's own window arithmetic. */
export const solidity = {
  quarterStart: (g, q) => g.activationEpoch + BigInt(q) * g.epochsPerQuarter,

  inPostingWindow(g, q, now) {
    const e = solidity.quarterStart(g, q);
    return now >= e && now < e + g.postPeriod;
  },

  inVerificationWindow(g, q, now) {
    const postEnd = solidity.quarterStart(g, q) + g.postPeriod;
    return now >= postEnd && now < postEnd + g.verificationWindow;
  },

  afterBinding(g, q, now) {
    const verifyEnd = solidity.quarterStart(g, q) + g.postPeriod + g.verificationWindow;
    return now >= verifyEnd;
  },

  quarterOf(g, now) {
    if (now < g.activationEpoch) return 0;
    return Number((now - g.activationEpoch) / g.epochsPerQuarter);
  },

  /**
   * The revert `submitShares(q)` would produce at `now`, or null when it would be accepted.
   * Order matters and is the contract's: InvalidQuarter, then NotBound, then NotLatestQuarter.
   */
  submitSharesRevert(g, q, now) {
    if (q === 0) return 'InvalidQuarter';
    if (!solidity.afterBinding(g, q, now)) return 'NotBound';
    if (solidity.afterBinding(g, q + 1, now)) return 'NotLatestQuarter';
    return null;
  },

  /** Brute-force latest bound quarter: every q from 1 upward with bindingEpoch(q) <= now. */
  latestBoundQuarterBruteForce(g, now) {
    let answer = null;
    for (let q = 1; ; q++) {
      if (!solidity.afterBinding(g, q, now)) break;
      answer = q;
      if (q > 100_000) throw new Error('brute force ran away; geometry is wrong');
    }
    return answer;
  },
};

/** Deterministic PRNG so a sweep failure is reproducible from the seed alone. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every epoch worth checking for `g` over quarters 0..`quarters`:
 * each window boundary +/- 2, a coarse stride across the whole span, and 400 random epochs.
 * Dense everywhere it can break, sampled everywhere it cannot.
 */
export function interestingEpochs(g, quarters = 8, seed = 20260917) {
  const out = new Set();
  const add = (e) => {
    if (e >= 0n) out.add(e);
  };

  for (let q = 0; q <= quarters + 1; q++) {
    const qs = solidity.quarterStart(g, q);
    for (const anchor of [
      qs,
      qs + g.postPeriod,
      qs + g.postPeriod + g.verificationWindow,
      qs + g.epochsPerQuarter,
    ]) {
      for (let d = -2n; d <= 2n; d++) add(anchor + d);
    }
  }

  const span = g.epochsPerQuarter * BigInt(quarters + 2);
  const stride = g.epochsPerQuarter / 17n + 1n;
  for (let e = 0n; e <= g.activationEpoch + span; e += stride) add(e);

  const rnd = mulberry32(seed);
  for (let i = 0; i < 400; i++) {
    add(BigInt(Math.floor(rnd() * Number(g.activationEpoch + span))));
  }

  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
