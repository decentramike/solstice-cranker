/**
 * Revert decoding and classification.
 *
 * The cranker's whole judgement lives here. Most reverts are the contracts working
 * correctly -- the crank simply was not due -- and treating them as failures would
 * produce a wall of red that nobody reads, which is how a real failure gets missed.
 * Exactly one revert is an emergency.
 *
 * Signatures are not hardcoded by hand: they are decoded against abi/*.json, which is
 * generated from the upstream contract sources. abi/selectors.json carries the upstream
 * commit the ABIs came from.
 */
import { Interface } from 'ethers';

import sraAbi from '../abi/ServiceRewardsActor.json' with { type: 'json' };
import swaAbi from '../abi/StreamWeightActor.json' with { type: 'json' };

/** Every error either contract can raise, in one decoder. */
const DECODER = new Interface([
  ...sraAbi.filter((f) => f.type === 'error'),
  ...swaAbi.filter((f) => f.type === 'error'),
]);

/**
 * How the cranker reacts to each known revert.
 *
 *   benign     the contracts are fine and so are we; exit 0, no alert
 *   retry      not due *yet* for a transient reason; exit 0, next scheduled run handles it
 *   critical   something irreversible happened; exit 1, alert immediately
 *   fault      a real error we did not anticipate; exit 1, alert
 */
const CLASSIFICATION = {
  // ---- expected, routine -------------------------------------------------
  NotBound: {
    kind: 'benign',
    outcome: 'not-due',
    severity: 'info',
    explain: (a) => `quarter ${a[0]} is not bound yet -- too early to crank`,
  },
  AlreadySubmitted: {
    kind: 'benign',
    outcome: 'already-done',
    severity: 'info',
    explain: (a) => `quarter ${a[0]} was already submitted, by us or by someone else`,
  },
  StepsComplete: {
    kind: 'benign',
    outcome: 'gate-closed',
    severity: 'info',
    explain: () => 'the gate has taken all 8 steps and is closed for good; nothing left to check',
  },

  // ---- transient ---------------------------------------------------------
  HoldUntil: {
    kind: 'retry',
    outcome: 'not-due',
    severity: 'info',
    explain: (a) => `a previous governance write is still in its hold until epoch ${a[0]}`,
  },
  StepWeightRecordsFailed: {
    kind: 'retry',
    outcome: 'not-due',
    severity: 'warn',
    explain: (a) =>
      `f02 rejected the gate's weight step with exit code ${a[0]}; ` +
      'usually the previous gate write is still inside its SWA hold, and the next run will land it',
  },

  // ---- the one that matters ----------------------------------------------
  NotLatestQuarter: {
    kind: 'critical',
    outcome: 'missed-window',
    severity: 'critical',
    explain: (a) =>
      `quarter ${a[0]} can no longer be submitted: a later quarter has already bound. ` +
      "That quarter's share map is permanently lost and cannot be recovered by retrying.",
  },

  // ---- shouldn't happen; if it does, our inputs are wrong -----------------
  InvalidQuarter: {
    kind: 'fault',
    outcome: 'error',
    severity: 'critical',
    explain: (a) => `quarter ${a[0]} is not a valid quarter -- the computed schedule is wrong`,
  },
  SetWeightRecordsFailed: {
    kind: 'fault',
    outcome: 'error',
    severity: 'critical',
    explain: (a) => `f02 rejected a discretionary weight write with exit code ${a[0]}`,
  },
  PendingShares: {
    kind: 'fault',
    outcome: 'error',
    severity: 'warn',
    explain: (a) => `quarter ${a[0]} is still awaiting its share map`,
  },
};

const UNKNOWN = {
  kind: 'fault',
  outcome: 'error',
  severity: 'critical',
  explain: () => 'unrecognised revert -- the deployed contract may not match the shipped ABI',
};

/**
 * Builds the verdict from a rule, taking only the decision fields.
 *
 * Spreading a rule directly would carry its `explain` function into the result, which then
 * ends up in the run record and serialises to nothing useful.
 */
function verdict(rule, { name = null, args = [], reason = null, message, raw = null }) {
  return {
    name,
    args,
    kind: rule.kind,
    outcome: rule.outcome,
    severity: rule.severity,
    reason,
    message,
    raw,
  };
}

/**
 * Digs the raw revert bytes out of whatever shape the provider handed us.
 *
 * ethers normalises most of this, but Filecoin RPC providers (Lotus behind Glif) nest
 * the revert payload differently depending on whether it surfaced from eth_call,
 * eth_estimateGas, or a receipt, so we look in all the usual places rather than
 * trusting one.
 */
export function extractRevertData(err) {
  const seen = new Set();
  const candidates = [err];

  while (candidates.length) {
    const node = candidates.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    for (const key of ['data', 'return', 'returnData']) {
      const v = node[key];
      if (typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v) && v.length >= 10) return v;
      // Some providers nest again under data, e.g. {error:{data:{data:"0x..."}}}.
      if (v && typeof v === 'object') candidates.push(v);
    }
    for (const key of ['error', 'info', 'cause', 'body', 'value']) {
      if (node[key]) candidates.push(node[key]);
    }
  }
  return null;
}

/**
 * Turns any thrown value into a decision.
 *
 * @returns {{name:string|null, args:string[], kind:string, outcome:string,
 *            severity:string, reason:string|null, message:string, raw:string|null}}
 */
export function classifyRevert(err) {
  // ethers decodes custom errors itself when the ABI covers them.
  let name = err?.revert?.name ?? null;
  let args = err?.revert?.args ? [...err.revert.args].map(String) : [];
  const raw = extractRevertData(err);

  if (!name && raw) {
    try {
      const parsed = DECODER.parseError(raw);
      if (parsed) {
        name = parsed.name;
        args = [...parsed.args].map(String);
      }
    } catch {
      // Falls through to the unknown-revert path below.
    }
  }

  // A plain `Error(string)` revert, or a require without a custom error.
  if (!name && typeof err?.reason === 'string' && err.reason) {
    return verdict(UNKNOWN, {
      name: 'Error',
      args: [err.reason],
      reason: err.reason,
      message: `reverted: ${err.reason}`,
      raw,
    });
  }

  if (!name) {
    // An undecodable revert is more alarming than a network blip, and the two need
    // different messages: one means the ABI is wrong, the other means the node is.
    const transport = isTransportFailure(err);
    const selector = raw && raw.length >= 10 ? raw.slice(0, 10) : null;
    const described = err?.shortMessage ?? err?.message ?? null;

    return verdict(UNKNOWN, {
      reason: selector,
      raw,
      message:
        described ??
        (selector
          ? `reverted with unrecognised selector ${selector}; the deployed contract does not ` +
            'match the shipped ABI. Regenerate with `npm run contracts:build && npm run abi:generate`.'
          : transport
            ? 'the RPC endpoint did not respond'
            : 'reverted with no decodable reason'),
    });
  }

  const rule = CLASSIFICATION[name] ?? UNKNOWN;
  return verdict(rule, {
    name,
    args,
    reason: args.length ? `${name}(${args.join(',')})` : `${name}()`,
    message: rule.explain(args),
    raw,
  });
}

/** True when the failure is the network or the node, not the contract. */
export function isTransportFailure(err) {
  const code = err?.code;
  if (['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'UNKNOWN_ERROR'].includes(code)) {
    return !extractRevertData(err);
  }
  return false;
}

/** The set of revert names the cranker considers routine. Used by tests and docs generation. */
export const BENIGN_REVERTS = Object.entries(CLASSIFICATION)
  .filter(([, v]) => v.kind === 'benign' || v.kind === 'retry')
  .map(([k]) => k);

export { CLASSIFICATION };
