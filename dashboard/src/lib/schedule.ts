/**
 * Quarter geometry, mirroring ServiceRewardsActor.sol.
 *
 *   quarterStart(q) = activationEpoch + q * epochsPerQuarter
 *   posting window  = [quarterStart(q), quarterStart(q) + postPeriod)
 *   verification    = [ +postPeriod,    +postPeriod + verificationWindow)
 *   bound           = [ binding(q), quarterStart(q+1) )  and onward
 *   binding(q)      = quarterStart(q) + postPeriod + verificationWindow
 *
 * submitShares(q) requires _afterBinding(q) && !_afterBinding(q + 1), so its
 * callable window is exactly [binding(q), binding(q + 1)). The upper bound is the
 * hard deadline: at binding(q+1) it starts reverting NotLatestQuarter(q) forever.
 *
 * NOTE postPeriod and verificationWindow are `private immutable` on the SRA and
 * cannot be read back from chain, so they come from config/networks.json only.
 * Everything here is therefore a *view-side* reconstruction; where the server
 * reports a value we display the server's, and use these functions for the parts
 * of the picture the state object does not carry (window starts, ends, widths).
 */

import type { QuarterPhase, QuartersInfo } from '../types';

export interface Geometry {
  activationEpoch: number;
  epochsPerQuarter: number;
  postPeriod: number;
  verificationWindow: number;
}

export function geometryOf(q: QuartersInfo): Geometry {
  return {
    activationEpoch: q.activationEpoch,
    epochsPerQuarter: q.epochsPerQuarter,
    postPeriod: q.postPeriod,
    verificationWindow: q.verificationWindow,
  };
}

export function quarterStart(g: Geometry, q: number): number {
  return g.activationEpoch + q * g.epochsPerQuarter;
}

export function postEnd(g: Geometry, q: number): number {
  return quarterStart(g, q) + g.postPeriod;
}

/** Also the verification-window end, and the epoch the crank opens for q. */
export function bindingEpoch(g: Geometry, q: number): number {
  return quarterStart(g, q) + g.postPeriod + g.verificationWindow;
}

/** The epoch submitShares(q) stops being callable — exclusive. */
export function submitDeadline(g: Geometry, q: number): number {
  return bindingEpoch(g, q + 1);
}

/**
 * The latest quarter whose verification window has closed — i.e. the only quarter
 * submitShares can target, per `_afterBinding(q) && !_afterBinding(q + 1)`.
 * This is what the contract calls `sra.dueQuarter`. The dashboard reads that field
 * from the server; this function exists for the fixture clock only.
 */
export function latestBoundQuarter(g: Geometry, epoch: number): number {
  if (g.epochsPerQuarter <= 0) return 0;
  const offset = epoch - g.activationEpoch - g.postPeriod - g.verificationWindow;
  if (offset < 0) return 0;
  return Math.floor(offset / g.epochsPerQuarter);
}

export function quarterAt(g: Geometry, epoch: number): number {
  if (g.epochsPerQuarter <= 0) return 0;
  const offset = epoch - g.activationEpoch;
  if (offset < 0) return 0;
  return Math.floor(offset / g.epochsPerQuarter);
}

export function phaseAt(g: Geometry, epoch: number): QuarterPhase {
  if (epoch < g.activationEpoch) return 'pre-activation';
  const q = quarterAt(g, epoch);
  const start = quarterStart(g, q);
  if (epoch < start + g.postPeriod) return 'posting';
  if (epoch < start + g.postPeriod + g.verificationWindow) return 'verification';
  return 'bound';
}

/** Epochs from `epoch` to the next phase boundary of the quarter it sits in. */
export function epochsUntilNextPhase(g: Geometry, epoch: number): number {
  if (epoch < g.activationEpoch) return g.activationEpoch - epoch;
  const q = quarterAt(g, epoch);
  const start = quarterStart(g, q);
  const boundaries = [
    start + g.postPeriod,
    start + g.postPeriod + g.verificationWindow,
    start + g.epochsPerQuarter,
  ];
  for (const b of boundaries) if (epoch < b) return b - epoch;
  return 0;
}

/** Recompute the whole `quarters` block for a given epoch. Used by the fixture clock. */
export function quartersAt(g: Geometry, epoch: number): QuartersInfo {
  const q = quarterAt(g, epoch);
  return {
    activationEpoch: g.activationEpoch,
    epochsPerQuarter: g.epochsPerQuarter,
    postPeriod: g.postPeriod,
    verificationWindow: g.verificationWindow,
    currentQuarter: q,
    phase: phaseAt(g, epoch),
    quarterStartEpoch: quarterStart(g, q),
    bindingEpoch: bindingEpoch(g, q),
    nextQuarterStartEpoch: quarterStart(g, q + 1),
    epochsUntilNextPhase: epochsUntilNextPhase(g, epoch),
  };
}

export const PHASE_LABEL: Record<QuarterPhase, string> = {
  'pre-activation': 'Pre-activation',
  posting: 'Posting window',
  verification: 'Verification window',
  bound: 'Bound — crank callable',
};

export const PHASE_BLURB: Record<QuarterPhase, string> = {
  'pre-activation': 'The SRA has not reached its activation epoch. No quarter is live.',
  posting: 'Orchestrators are posting volumes. Neither crank call is callable yet.',
  verification: 'Posted volumes can still be corrected. Neither crank call is callable yet.',
  bound: 'Volumes are frozen. submitShares and quarterlyGateCheck are callable now.',
};
