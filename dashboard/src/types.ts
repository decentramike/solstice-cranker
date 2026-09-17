/**
 * Types for the devnet server state object.
 *
 * Source of truth: docs/DATA-CONTRACT.md §1 (run records) and §2 (HTTP API).
 * Nothing here is invented — every field maps to a field in that document.
 *
 * Rule from the contract: every numeric field is a JSON number EXCEPT token/USD
 * amounts, which are decimal strings. Those are typed `DecimalString` and must
 * never be passed through `Number()` / `parseFloat()` on the way to the screen.
 */

/** A base-10 fixed-point amount, e.g. "9999.98". Never parse this into a float. */
export type DecimalString = string;

/** 0x-prefixed 20-byte address. */
export type Address = string;

/** 0x-prefixed 32-byte transaction hash. */
export type TxHash = string;

// ---------------------------------------------------------------------------
// §2 state object
// ---------------------------------------------------------------------------

export interface NetworkInfo {
  /** "devnet" | "calibnet" | "mainnet" — devnet unlocks the write endpoints. */
  name: string;
  chainId: number;
  label: string;
  epochSeconds: number;
}

export interface ChainInfo {
  epoch: number;
  connected: boolean;
}

export interface ContractsInfo {
  sra: Address;
  swa: Address;
  deployed: boolean;
}

/**
 * Wallet identity only. The contract exposes no key material and this dashboard
 * must never render any; there is deliberately no field for one here.
 */
export interface WalletInfo {
  address: Address;
  balanceFil: DecimalString;
  minBalanceFil: DecimalString;
  belowThreshold: boolean;
}

export type QuarterPhase = 'pre-activation' | 'posting' | 'verification' | 'bound';

export const QUARTER_PHASES: readonly QuarterPhase[] = [
  'pre-activation',
  'posting',
  'verification',
  'bound',
];

export interface QuartersInfo {
  activationEpoch: number;
  epochsPerQuarter: number;
  postPeriod: number;
  verificationWindow: number;
  currentQuarter: number;
  phase: QuarterPhase;
  /** activationEpoch + currentQuarter * epochsPerQuarter */
  quarterStartEpoch: number;
  /** quarterStartEpoch + postPeriod + verificationWindow — the epoch the crank opens. */
  bindingEpoch: number;
  nextQuarterStartEpoch: number;
  epochsUntilNextPhase: number;
}

export interface SraState {
  lastSubmittedQuarter: number;
  /**
   * The LATEST BOUND quarter — the only quarter submitShares can ever target,
   * because the call requires `_afterBinding(q) && !_afterBinding(q + 1)`.
   * Explicitly NOT `lastSubmittedQuarter + 1`: when quarters have been missed the
   * two diverge, and only this one names a quarter anything can still be done about.
   * Always taken from the server; never derived here.
   */
  dueQuarter: number;
  /**
   * Exclusive: at this epoch quarter `dueQuarter + 1` binds and
   * submitShares(dueQuarter) starts reverting NotLatestQuarter — permanently.
   */
  deadlineEpoch: number;
  /**
   * Quarters that were never submitted and never can be. `[]` normally.
   * Server-supplied and never recomputed here: once a later quarter lands,
   * `lastSubmittedQuarter` jumps the gap and the loss is no longer derivable
   * from the rest of the state object. This field is the only record of it.
   */
  missedQuarters: number[];
  atRisk: boolean;
}

export interface SwaState {
  lastCheckedQuarter: number;
  /** `lastCheckedQuarter + 1` — correct for the gate, which catches up in order. */
  dueQuarter: number;
  /** Steps taken so far. */
  steps: number;
  /** Total steps in the gate (8 on-chain). */
  gateSteps: number;
  nextThresholdUsd: DecimalString;
  /** true once all gateSteps are taken — the gate is permanently closed. */
  complete: boolean;
}

// ---------------------------------------------------------------------------
// §1 run records
// ---------------------------------------------------------------------------

export type CrankCall = 'submitShares' | 'quarterlyGateCheck';

export type ActionDecision = 'sent' | 'skipped' | 'failed' | 'dry-run';

export type ActionOutcome =
  | 'landed'
  | 'not-due'
  | 'already-done'
  | 'gate-closed'
  | 'missed-window'
  | 'error';

export type Severity = 'info' | 'warn' | 'critical';

export interface RunAction {
  call: CrankCall;
  /** Target quarter; null when not applicable. */
  quarter: number | null;
  decision: ActionDecision;
  outcome: ActionOutcome;
  /** Decoded custom error (e.g. "NotBound(5)"), or null. */
  reason: string | null;
  /** null when nothing was broadcast. */
  txHash: TxHash | null;
  gasUsed: string | null;
  severity: Severity;
  message: string;
}

export interface RunSchedule {
  currentQuarter: number;
  phase: QuarterPhase;
  submitDueQuarter: number;
  submitDueAtEpoch: number;
  submitDeadlineEpoch: number;
  gateDueQuarter: number;
  gateDueAtEpoch: number;
  /** Same field as `sra.missedQuarters`, as the cranker saw it on this run. */
  missedQuarters: number[];
  chainAgreesWithConfig: boolean;
  divergence: string | null;
}

export interface RunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  network: string;
  chainId: number;
  epoch: number;
  cranker: Address;
  balanceFil: DecimalString;
  paused: boolean;
  pauseReason: string | null;
  actions: RunAction[];
  schedule: RunSchedule;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Chain events
// ---------------------------------------------------------------------------

interface ChainEventBase {
  blockNumber: number;
  txHash: TxHash;
}

export interface SharesSubmittedEvent extends ChainEventBase {
  type: 'SharesSubmitted';
  quarter: number;
  args: { recipientCount: number; totalUsd: DecimalString };
}

export interface QuarterlyGateCheckResultEvent extends ChainEventBase {
  type: 'QuarterlyGateCheckResult';
  quarter: number;
  args: { passed: boolean; steps: number };
}

export interface FvmActorCallEvent extends ChainEventBase {
  type: 'FvmActorCall';
  quarter?: number | null;
  args: { actorId: number; method: number; methodName: string; paramsHex: string };
}

/** Anything the server starts emitting that this build does not know about yet. */
export interface UnknownChainEvent extends ChainEventBase {
  type: string;
  quarter?: number | null;
  args?: Record<string, unknown>;
}

export type ChainEvent =
  | SharesSubmittedEvent
  | QuarterlyGateCheckResultEvent
  | FvmActorCallEvent
  | UnknownChainEvent;

export interface Alert {
  at: string;
  severity: Severity;
  title: string;
  body: string;
}

/**
 * The contract does not pin down the element type of `log`, so it is kept loose
 * and coerced at the edge rather than trusted.
 */
export type RehearsalLogLine = string | { at?: string; message?: string; text?: string };

export interface Rehearsal {
  active: boolean;
  step: number;
  totalSteps: number;
  label: string | null;
  log: RehearsalLogLine[];
}

export interface CrankerState {
  network: NetworkInfo;
  chain: ChainInfo;
  contracts: ContractsInfo;
  wallet: WalletInfo;
  quarters: QuartersInfo;
  sra: SraState;
  swa: SwaState;
  /** Newest first, cap 50. */
  runs: RunRecord[];
  /** Newest first, cap 100. */
  events: ChainEvent[];
  alerts: Alert[];
  rehearsal: Rehearsal;
}

export interface HealthResponse {
  ok: boolean;
  devnetUp: boolean;
  deployed: boolean;
}

// ---------------------------------------------------------------------------
// Narrowing helpers — the events array is the one place the server can surprise us.
// ---------------------------------------------------------------------------

export function isSharesSubmitted(e: ChainEvent): e is SharesSubmittedEvent {
  return e.type === 'SharesSubmitted';
}

export function isGateCheckResult(e: ChainEvent): e is QuarterlyGateCheckResultEvent {
  return e.type === 'QuarterlyGateCheckResult';
}

export function isFvmActorCall(e: ChainEvent): e is FvmActorCallEvent {
  return e.type === 'FvmActorCall';
}
