/**
 * Fixture transport. Serves the canned state objects in src/fixtures and runs a
 * small local clock so the demo controls (advance / crank / pause) do something
 * real before devnet/server.mjs exists.
 *
 * The simulation reproduces the on-chain rules the dashboard cares about:
 *   - submitShares(q) is callable in [binding(q), binding(q+1))
 *   - once binding(q+1) passes, quarter q can never be submitted again
 *   - quarterlyGateCheck takes one step and stops at gateSteps
 */

import type { CrankerState, RunAction, RunRecord } from '../types';
import { bindingEpoch, geometryOf, latestBoundQuarter, quartersAt } from '../lib/schedule';
import { normalizeState, SnapshotStore, type Scenario, type StateSource } from './store';

import healthy from '../fixtures/state.json';
import posting from '../fixtures/posting.json';
import atRisk from '../fixtures/at-risk.json';
import missedWindow from '../fixtures/missed-window.json';
import lostQuarter from '../fixtures/lost-quarter.json';

const FIXTURES: Record<string, unknown> = {
  healthy,
  posting,
  'at-risk': atRisk,
  'missed-window': missedWindow,
  'lost-quarter': lostQuarter,
};

export const SCENARIOS: Scenario[] = [
  { id: 'healthy', label: 'Healthy', note: 'Q5 submitted, gate stepping, nothing at risk' },
  { id: 'posting', label: 'Posting window', note: 'Mid-quarter, gate closed at 8 of 8' },
  { id: 'at-risk', label: 'At risk', note: 'Q5 unsubmitted, 24 epochs of margin, wallet dry' },
  { id: 'missed-window', label: 'Window just missed', note: 'Q5 lost, Q6 now due with margin' },
  {
    id: 'lost-quarter',
    label: 'Lost quarter, board green',
    note: 'Everything nominal, no alerts — and Q5 still gone',
  },
];

const DEFAULT_SCENARIO = 'healthy';

function readScenarioFromUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_SCENARIO;
  const q = new URLSearchParams(window.location.search).get('fixture');
  return q !== null && q in FIXTURES ? q : DEFAULT_SCENARIO;
}

function clone(id: string): CrankerState {
  const raw = FIXTURES[id] ?? FIXTURES[DEFAULT_SCENARIO];
  return normalizeState(structuredClone(raw) as CrankerState);
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return '0x' + Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Recompute everything that is a pure function of the epoch.
 *
 * This is the server's job in real life; here it models the two rules that matter:
 * `dueQuarter` is the latest bound quarter, and `missedQuarters` ACCUMULATES. The
 * second point is the whole reason the field exists — it is never recomputed from
 * `lastSubmittedQuarter`, because a later submission jumps the gap and erases it.
 */
function retime(state: CrankerState): CrankerState {
  const g = geometryOf(state.quarters);
  const epoch = state.chain.epoch;
  const quarters = quartersAt(g, epoch);

  const dueQuarter = latestBoundQuarter(g, epoch);
  const deadlineEpoch = bindingEpoch(g, dueQuarter + 1);

  // Any quarter between the last submission and the newly bound one has had its
  // window overtaken and can never be submitted again. Append, never rebuild.
  const missedQuarters = [...(state.sra.missedQuarters ?? [])];
  for (let q = state.sra.lastSubmittedQuarter + 1; q < dueQuarter; q++) {
    if (!missedQuarters.includes(q)) missedQuarters.push(q);
  }
  missedQuarters.sort((a, b) => a - b);

  const landed = state.sra.lastSubmittedQuarter >= dueQuarter;
  const margin = deadlineEpoch - epoch;
  const atRiskNow = !landed && margin <= Math.max(2, Math.floor(g.epochsPerQuarter * 0.25));

  return {
    ...state,
    quarters,
    sra: { ...state.sra, dueQuarter, deadlineEpoch, missedQuarters, atRisk: atRiskNow },
  };
}

function makeAction(partial: Partial<RunAction> & Pick<RunAction, 'call' | 'message'>): RunAction {
  return {
    quarter: null,
    decision: 'skipped',
    outcome: 'not-due',
    reason: null,
    txHash: null,
    gasUsed: null,
    severity: 'info',
    ...partial,
  };
}

/** One synthetic cranker run against the simulated chain. */
function simulateCrank(input: CrankerState, paused: boolean): CrankerState {
  const state = structuredClone(input);
  const g = geometryOf(state.quarters);
  const epoch = state.chain.epoch;
  const startedAt = new Date();
  const actions: RunAction[] = [];

  const submitQ = state.sra.dueQuarter;
  const submitOpens = bindingEpoch(g, submitQ);
  const submitDeadline = bindingEpoch(g, submitQ + 1);
  const gateQ = state.swa.dueQuarter;
  const gateOpens = bindingEpoch(g, gateQ);
  const missed = state.sra.missedQuarters ?? [];

  // Quarters already written off are reported once per run and then left alone —
  // there is nothing to retry, so they never become an action the cranker attempts.
  for (const q of missed) {
    if (q <= state.sra.lastSubmittedQuarter) continue;
    actions.push(
      makeAction({
        call: 'submitShares',
        quarter: q,
        outcome: 'missed-window',
        reason: `NotLatestQuarter(${q})`,
        severity: 'critical',
        message: `Quarter ${q} is permanently unsubmittable — quarter ${submitQ} is bound and the SRA only accepts the latest.`,
      }),
    );
  }

  if (paused) {
    actions.push(
      makeAction({
        call: 'submitShares',
        quarter: submitQ,
        message: 'Cranker paused — no call attempted.',
        severity: epoch >= submitOpens && epoch < submitDeadline ? 'warn' : 'info',
      }),
      makeAction({
        call: 'quarterlyGateCheck',
        quarter: gateQ,
        message: 'Cranker paused — no call attempted.',
      }),
    );
  } else if (state.sra.lastSubmittedQuarter >= submitQ) {
    actions.push(
      makeAction({
        call: 'submitShares',
        quarter: submitQ,
        outcome: 'already-done',
        reason: `AlreadySubmitted(${submitQ})`,
        message: `Quarter ${submitQ} share map already on chain. Quarter ${submitQ + 1} binds at epoch ${submitDeadline}.`,
      }),
    );
  } else if (epoch < submitOpens) {
    actions.push(
      makeAction({
        call: 'submitShares',
        quarter: submitQ,
        reason: `NotBound(${submitQ})`,
        message: `Quarter ${submitQ} binds at epoch ${submitOpens} — ${submitOpens - epoch} epochs away.`,
      }),
    );
  } else {
    const txHash = randomHex(32);
    state.sra.lastSubmittedQuarter = submitQ;
    actions.push(
      makeAction({
        call: 'submitShares',
        quarter: submitQ,
        decision: 'sent',
        outcome: 'landed',
        txHash,
        gasUsed: '184213',
        message: `Quarter ${submitQ} share map submitted.`,
      }),
    );
    state.events.unshift(
      {
        type: 'FvmActorCall',
        blockNumber: epoch,
        txHash,
        args: {
          actorId: 2,
          method: 3862548934,
          methodName: 'SetShares',
          paramsHex: randomHex(12),
        },
      },
      {
        type: 'SharesSubmitted',
        quarter: submitQ,
        blockNumber: epoch,
        txHash,
        args: { recipientCount: 4, totalUsd: '18420.75' },
      },
    );
  }

  if (!paused) {
    if (state.swa.complete) {
      actions.push(
        makeAction({
          call: 'quarterlyGateCheck',
          quarter: gateQ,
          outcome: 'gate-closed',
          reason: 'StepsComplete()',
          message: `All ${state.swa.gateSteps} gate steps taken. Nothing left to check.`,
        }),
      );
    } else if (epoch < gateOpens) {
      actions.push(
        makeAction({
          call: 'quarterlyGateCheck',
          quarter: gateQ,
          reason: `NotBound(${gateQ})`,
          message: `Gate check reads quarter ${gateQ}, which binds at epoch ${gateOpens}.`,
        }),
      );
    } else {
      const txHash = randomHex(32);
      state.swa.lastCheckedQuarter = gateQ;
      state.swa.dueQuarter = gateQ + 1;
      state.swa.steps = Math.min(state.swa.gateSteps, state.swa.steps + 1);
      state.swa.complete = state.swa.steps >= state.swa.gateSteps;
      actions.push(
        makeAction({
          call: 'quarterlyGateCheck',
          quarter: gateQ,
          decision: 'sent',
          outcome: 'landed',
          txHash,
          gasUsed: '96044',
          message: `Gate passed: step ${state.swa.steps} of ${state.swa.gateSteps} taken.`,
        }),
      );
      state.events.unshift({
        type: 'QuarterlyGateCheckResult',
        quarter: gateQ,
        blockNumber: epoch,
        txHash,
        args: { passed: true, steps: state.swa.steps },
      });
    }
  }

  const finishedAt = new Date(startedAt.getTime() + 640);
  const run: RunRecord = {
    runId: `${startedAt.toISOString()}-${randomHex(2).slice(2)}`,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: 640,
    network: state.network.name,
    chainId: state.network.chainId,
    epoch,
    cranker: state.wallet.address,
    balanceFil: state.wallet.balanceFil,
    paused,
    pauseReason: paused ? 'Manual pause held by operator (demo control)' : null,
    actions,
    schedule: {
      currentQuarter: state.quarters.currentQuarter,
      phase: state.quarters.phase,
      submitDueQuarter: submitQ,
      submitDueAtEpoch: submitOpens,
      submitDeadlineEpoch: submitDeadline,
      missedQuarters: missed,
      gateDueQuarter: gateQ,
      gateDueAtEpoch: gateOpens,
      chainAgreesWithConfig: true,
      divergence: null,
    },
    exitCode: actions.some((a) => a.severity === 'critical') ? 2 : 0,
  };

  state.runs = [run, ...state.runs].slice(0, 50);
  state.events = state.events.slice(0, 100);
  return retime(state);
}

export function createFixtureSource(): StateSource {
  const store = new SnapshotStore();
  let scenario = readScenarioFromUrl();
  let current = retime(clone(scenario));
  let paused = false;

  const publish = () => store.setState(current, 'fixtures');

  const load = (id: string) => {
    scenario = id;
    paused = false;
    current = retime(clone(id));
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      params.set('fixture', id);
      window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
    }
    publish();
  };

  publish();

  return {
    mode: 'fixtures',
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    retry() {
      load(scenario);
    },
    async advance(epochs: number) {
      const n = Math.max(0, Math.trunc(epochs));
      current = retime({ ...current, chain: { ...current.chain, epoch: current.chain.epoch + n } });
      publish();
    },
    async crank() {
      current = simulateCrank(current, paused);
      publish();
    },
    async setPaused(next: boolean) {
      paused = next;
      // Reflect the toggle immediately on the most recent run so the chrome is honest.
      current = {
        ...current,
        runs: current.runs.map((r, i) =>
          i === 0
            ? {
                ...r,
                paused: next,
                pauseReason: next ? 'Manual pause held by operator (demo control)' : null,
              }
            : r,
        ),
      };
      publish();
    },
    scenarios: SCENARIOS,
    get activeScenario() {
      return scenario;
    },
    selectScenario(id: string) {
      load(id);
    },
  };
}
