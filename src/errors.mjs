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

  // The gate-check guard (upstream #67). quarterlyGateCheck() now runs these BEFORE anything
  // else, so while either holds, every gate check reverts with it -- including one that would
  // otherwise be a plain NotBound. Both are deferrals the governance process creates on purpose,
  // and the gate has no deadline, so they wait for the next run rather than alerting. Missing
  // from the ABI until it was rebuilt from the deployed commit; on 1 Oct, during the rehearsal's
  // "SWA objection", PendingGateParams turned three healthy runs red.
  PendingGateParams: {
    kind: 'retry',
    outcome: 'not-due',
    severity: 'info',
    explain: (a) =>
      `a SetGateParams governance task (${String(a[0]).slice(0, 10)}…) is still outstanding; ` +
      'the gate check waits until it is executed or vetoed',
  },
  PendingWeightWrite: {
    kind: 'retry',
    outcome: 'not-due',
    severity: 'info',
    explain: (a) =>
      `a discretionary SWA weight write is still settling in f02 until epoch ${a[0]}; ` +
      'the gate check waits for it',
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

  // Last resort: Lotus also writes the revert bytes into its message text, e.g. from eth_estimateGas
  // on calibnet: "message execution failed (exit=[33], revert reason=[0x3461d1f0…], vm error=[…])".
  // ethers hoists them into `data` today; if a gateway or a later version ever stops doing so, a
  // real revert must not read as "no revert data", which isTransportFailure now treats as a sick node.
  seen.clear();
  candidates.push(err);
  while (candidates.length) {
    const node = candidates.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const m = typeof node.message === 'string' && node.message.match(/revert reason=\[(0x[0-9a-fA-F]{8,})\]/);
    if (m) return m[1];
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

    // A selector wins over ethers' own wording. ethers always supplies a shortMessage, and for an
    // unknown selector it says only "execution reverted (unknown custom error)" -- which is what
    // run 192's alert said on 1 Oct, when the real problem was an ABI one commit behind the
    // deployment. The alert has to name the selector and say what to do.
    return verdict(UNKNOWN, {
      reason: selector,
      raw,
      message: selector
        ? `reverted with unrecognised selector ${selector}; the deployed contract does not match ` +
          'the shipped ABI. Rebuild abi/ from the commit the contracts were deployed from ' +
          '(REF in devnet/prepare-contracts.mjs): `npm run contracts:build && npm run abi:generate`.'
        : described ??
          (transport ? 'the RPC endpoint did not respond' : 'reverted with no decodable reason'),
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

  // A CALL_EXCEPTION with NO revert data at all is the node failing, not the contract.
  //
  // Captured from ethers v6 (test/fixtures/provider-errors.json), three different failures all
  // arrive as exactly this -- CALL_EXCEPTION, "missing revert data", data null:
  //   - a rate limit returned as a JSON-RPC error inside an HTTP 200
  //   - Lotus failing a call for a non-revert reason (an out-of-gas exit, say)
  //   - an execution error the node reports without a payload
  // A genuine revert from these contracts always carries data: every one of them uses custom
  // errors, and Lotus returns the revert bytes with exit code 33. So no data means nothing was
  // learned about the contract, and the honest reaction is to ask again.
  //
  // A revert that DOES carry data stays a contract outcome even if its selector is unknown --
  // that is how an ABI that no longer matches the deployment gets noticed.
  //
  // "No revert information" means all of these are absent, which is exactly what the captured
  // shapes show (data, revert and reason all null). Each one present means the contract answered:
  //   - revert bytes anywhere in the error, however Lotus nested them
  //   - `data: "0x"`: an explicit EMPTY revert. ethers keeps it distinct from a missing payload
  //     ("no data present; likely require(false) occurred" against "missing revert data"); it is
  //     what calling a function the target does not have looks like -- a wrong address, a stale ABI
  //   - a decoded `revert` or a `reason`: ethers only fills those in when it decoded something
  //   - a `receipt`: ethers v6 throws CALL_EXCEPTION from tx.wait() for a status-0 receipt, with
  //     data, revert and reason all null. That message was mined; it is the chain's answer, and
  //     reading it as a sick node would skip the "did someone else get there first?" check.
  if (code === 'CALL_EXCEPTION') {
    const hasRevertInfo =
      Boolean(extractRevertData(err)) ||
      (typeof err?.data === 'string' && /^0x/i.test(err.data)) ||
      Boolean(err?.revert) ||
      (typeof err?.reason === 'string' && err.reason.length > 0) ||
      Boolean(err?.receipt);
    return !hasRevertInfo;
  }
  return false;
}

/** The set of revert names the cranker considers routine. Used by tests and docs generation. */
export const BENIGN_REVERTS = Object.entries(CLASSIFICATION)
  .filter(([, v]) => v.kind === 'benign' || v.kind === 'retry')
  .map(([k]) => k);

export { CLASSIFICATION };
