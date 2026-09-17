/**
 * Deterministic quarter timing.
 *
 * Pure arithmetic over BigInt epochs -- no RPC, no clock, no I/O -- so the scheduler can
 * be tested exhaustively and reasoned about without a chain. Everything here derives from
 * four parameters and the current epoch.
 *
 * The geometry, from FIP-0118 and the SRA source:
 *
 *   quarterStart(q) = ACTIVATION_EPOCH + q * EPOCHS_PER_QUARTER
 *
 *   |<------------------------ quarter q ------------------------>|
 *   |  posting window   |  verification window  |     bound       |
 *   ^                   ^                       ^                 ^
 *   quarterStart(q)     +POST_PERIOD            +VERIFICATION      quarterStart(q+1)
 *                                               = bindingEpoch(q)
 *                                               submitShares(q) becomes callable here
 *
 * Quarter 0 is the activation span: `submitShares` rejects q == 0, so the first
 * submittable quarter is 1. The SRA constructor enforces POST + VERIFY < EPOCHS_PER_QUARTER,
 * which guarantees quarter q binds inside its own time-quarter -- that is what makes the
 * "due quarter" resolvable in constant time rather than by scanning.
 *
 * The deadline is the part that matters. submitShares(q) requires that q+1 is NOT yet
 * bound, so the call is valid on [bindingEpoch(q), bindingEpoch(q+1)) and reverts
 * NotLatestQuarter from bindingEpoch(q+1) onward -- at which point quarter q's share map
 * is lost for good.
 */

/** @typedef {{activationEpoch: bigint, epochsPerQuarter: bigint, postPeriod: bigint, verificationWindow: bigint}} Geometry */

export const PHASE = {
  PRE_ACTIVATION: 'pre-activation',
  POSTING: 'posting',
  VERIFICATION: 'verification',
  BOUND: 'bound',
};

function assertGeometry(g) {
  if (g.epochsPerQuarter <= 0n) throw new Error('epochsPerQuarter must be positive');
  if (g.postPeriod <= 0n) throw new Error('postPeriod must be positive');
  if (g.verificationWindow <= 0n) throw new Error('verificationWindow must be positive');
  if (g.postPeriod + g.verificationWindow >= g.epochsPerQuarter) {
    // The SRA constructor rejects this, so a deployment can never violate it. Reaching
    // it here means our config does not describe the deployment we are talking to.
    throw new Error(
      'postPeriod + verificationWindow must be less than epochsPerQuarter -- ' +
        'config does not match the deployed contract'
    );
  }
}

/** @param {Geometry} g */
export const quarterStartEpoch = (g, q) => g.activationEpoch + BigInt(q) * g.epochsPerQuarter;

/** The epoch at which quarter q becomes bound, and `submitShares(q)` becomes callable. */
export const bindingEpoch = (g, q) => quarterStartEpoch(g, q) + g.postPeriod + g.verificationWindow;

/** The epoch at which `submitShares(q)` starts reverting NotLatestQuarter. Exclusive bound. */
export const expiryEpoch = (g, q) => bindingEpoch(g, Number(q) + 1);

/** The time-quarter containing `epoch`, matching the SRA's `_quarterOf`. */
export function quarterOf(g, epoch) {
  if (epoch < g.activationEpoch) return 0;
  return Number((epoch - g.activationEpoch) / g.epochsPerQuarter);
}

export function phaseAt(g, epoch) {
  if (epoch < g.activationEpoch) return PHASE.PRE_ACTIVATION;
  const offset = (epoch - g.activationEpoch) % g.epochsPerQuarter;
  if (offset < g.postPeriod) return PHASE.POSTING;
  if (offset < g.postPeriod + g.verificationWindow) return PHASE.VERIFICATION;
  return PHASE.BOUND;
}

/**
 * The latest quarter whose volumes are bound at `epoch`, or null before the first one.
 *
 * Binding is monotonic in q, and quarter q binds within time-quarter q, so the answer is
 * either the current time-quarter or the one before it. Two comparisons, no scan.
 */
export function latestBoundQuarter(g, epoch) {
  const tq = quarterOf(g, epoch);
  const q = epoch >= bindingEpoch(g, tq) ? tq : tq - 1;
  return q >= 1 ? q : null;
}

/**
 * The full deterministic picture at `epoch`.
 *
 * @param {Geometry} g
 * @param {bigint} epoch
 * @param {{lastSubmittedQuarter?: number, lastCheckedQuarter?: number, gateComplete?: boolean}} state
 *        On-chain state read straight from the contracts' storage. Omit it and the caller
 *        gets the timing picture alone, which is what the pure tests use.
 */
export function buildSchedule(g, epoch, state = {}) {
  assertGeometry(g);

  const currentQuarter = quarterOf(g, epoch);
  const phase = phaseAt(g, epoch);
  const dueQuarter = latestBoundQuarter(g, epoch);

  const quarterStart = quarterStartEpoch(g, currentQuarter);
  const binding = bindingEpoch(g, currentQuarter);
  const nextQuarterStart = quarterStartEpoch(g, currentQuarter + 1);

  const nextPhaseEpoch =
    phase === PHASE.PRE_ACTIVATION ? g.activationEpoch
      : phase === PHASE.POSTING ? quarterStart + g.postPeriod
        : phase === PHASE.VERIFICATION ? binding
          : nextQuarterStart;

  // ---- submitShares --------------------------------------------------------
  const lastSubmitted = state.lastSubmittedQuarter ?? null;
  const submitNeeded = dueQuarter !== null && (lastSubmitted === null || lastSubmitted < dueQuarter);
  const submit = dueQuarter === null
    ? { quarter: null, due: false, dueAtEpoch: null, expiresAtEpoch: null, marginEpochs: null, alreadyDone: false, atRisk: false }
    : {
        quarter: dueQuarter,
        due: submitNeeded,
        dueAtEpoch: bindingEpoch(g, dueQuarter),
        expiresAtEpoch: expiryEpoch(g, dueQuarter),
        marginEpochs: expiryEpoch(g, dueQuarter) - epoch,
        alreadyDone: lastSubmitted !== null && lastSubmitted >= dueQuarter,
        // Under a fifth of the window left and still not submitted: worth shouting about
        // while there is still time to act.
        atRisk: submitNeeded && expiryEpoch(g, dueQuarter) - epoch < g.epochsPerQuarter / 5n,
      };

  // ---- quarterlyGateCheck --------------------------------------------------
  // Each call advances lastCheckedQuarter by exactly one, so after a gap the cranker
  // must call repeatedly to catch up. The gate for quarter q is checkable once q is bound.
  const lastChecked = state.lastCheckedQuarter ?? null;
  const gateTarget = lastChecked === null ? null : lastChecked + 1;
  const gateDue =
    !state.gateComplete &&
    gateTarget !== null &&
    dueQuarter !== null &&
    gateTarget <= dueQuarter;

  const gate = {
    quarter: gateTarget,
    due: gateDue,
    dueAtEpoch: gateTarget === null ? null : bindingEpoch(g, gateTarget),
    behindBy: gateDue ? dueQuarter - gateTarget + 1 : 0,
    complete: Boolean(state.gateComplete),
  };

  return {
    epoch,
    currentQuarter,
    phase,
    quarterStartEpoch: quarterStart,
    bindingEpoch: binding,
    nextQuarterStartEpoch: nextQuarterStart,
    nextPhaseEpoch,
    epochsUntilNextPhase: nextPhaseEpoch - epoch,
    dueQuarter,
    submit,
    gate,
  };
}

/**
 * Cross-checks the computed schedule against what the chain actually reports.
 *
 * The schedule is only as good as postPeriod and verificationWindow, which are private
 * immutables upstream and therefore come from config alone. This is the one place that
 * catches a wrong config before it costs a quarter.
 *
 * @param {number|null} computed   the schedule's latest bound quarter
 * @param {number|null} observed   the chain's, from probing aggregatedFilecoinPayVolume
 */
export function compareWithChain(computed, observed) {
  if (computed === observed) return { agrees: true, divergence: null };

  if (observed === null || (computed !== null && computed > observed)) {
    return {
      agrees: false,
      severity: 'warn',
      divergence: 'config-ahead',
      message:
        `config says quarter ${computed} is bound but the chain says ${observed ?? 'none'} is. ` +
        'postPeriod or verificationWindow in config/networks.json is too small, or activationEpoch drifted. ' +
        'Trusting the chain.',
    };
  }

  return {
    agrees: false,
    severity: 'critical',
    divergence: 'config-behind',
    message:
      `the chain has bound quarter ${observed} but config only expects ${computed ?? 'none'}. ` +
      'The cranker would have submitted a stale quarter and hit NotLatestQuarter. ' +
      'postPeriod or verificationWindow in config/networks.json is too large. Trusting the chain.',
  };
}

/** Epochs to a human duration. Filecoin epochs are 30s; the network config carries the real value. */
export function epochsToDuration(epochs, epochSeconds = 30) {
  const total = Number(epochs < 0n ? -epochs : epochs) * epochSeconds;
  const sign = epochs < 0n ? '-' : '';
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${sign}${d}d ${h}h`;
  if (h > 0) return `${sign}${h}h ${m}m`;
  return `${sign}${m}m`;
}
