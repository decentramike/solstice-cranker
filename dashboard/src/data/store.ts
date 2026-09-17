import type { CrankerState } from '../types';

export type TransportStatus = 'connecting' | 'live' | 'polling' | 'offline' | 'fixtures';

export interface Snapshot {
  state: CrankerState | null;
  status: TransportStatus;
  /** Human-readable reason the transport is unhappy, or null. */
  error: string | null;
  /** Date.now() of the last successful payload. */
  lastUpdatedAt: number | null;
  /** Consecutive failed connection attempts. */
  attempts: number;
  /** True while a write (advance / crank / pause) is in flight. */
  busy: boolean;
}

export interface Scenario {
  id: string;
  label: string;
  note: string;
}

export interface StateSource {
  readonly mode: 'live' | 'fixtures';
  subscribe(cb: () => void): () => void;
  getSnapshot(): Snapshot;
  /** Force a reconnect / refetch. */
  retry(): void;
  advance(epochs: number): Promise<void>;
  crank(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  /** Fixture mode only — lets the demo swap between canned states. */
  scenarios: Scenario[];
  activeScenario: string | null;
  selectScenario(id: string): void;
}

const EMPTY: Snapshot = {
  state: null,
  status: 'connecting',
  error: null,
  lastUpdatedAt: null,
  attempts: 0,
  busy: false,
};

/**
 * Minimal external store. getSnapshot returns a stable reference between
 * changes, which is what useSyncExternalStore requires.
 */
export class SnapshotStore {
  private snapshot: Snapshot = EMPTY;
  private listeners = new Set<() => void>();

  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  set(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  setState(state: CrankerState, status: TransportStatus): void {
    this.set({ state, status, error: null, lastUpdatedAt: Date.now(), attempts: 0 });
  }
}

/**
 * Cheap structural check. A malformed frame must not blank a working screen, and
 * must not throw somewhere deep inside a component.
 */
export function looksLikeState(value: unknown): value is CrankerState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const req = ['network', 'chain', 'contracts', 'wallet', 'quarters', 'sra', 'swa'];
  for (const k of req) {
    if (typeof v[k] !== 'object' || v[k] === null) return false;
  }
  const chain = v.chain as Record<string, unknown>;
  if (typeof chain.epoch !== 'number') return false;
  return Array.isArray(v.runs) && Array.isArray(v.events) && Array.isArray(v.alerts);
}

/**
 * Fills in the tails the UI iterates over, so a partial payload cannot crash a list.
 * `missedQuarters` and `swa.dueQuarter` are new in the contract; a server that has not
 * caught up yet gets a safe default rather than a blank screen. `missedQuarters` defaults
 * to empty — it is never reconstructed from `lastSubmittedQuarter`, because the whole point
 * of the field is that the gap is not derivable once a later quarter lands.
 */
export function normalizeState(state: CrankerState): CrankerState {
  return {
    ...state,
    sra: {
      ...state.sra,
      missedQuarters: Array.isArray(state.sra?.missedQuarters) ? state.sra.missedQuarters : [],
    },
    swa: {
      ...state.swa,
      dueQuarter:
        typeof state.swa?.dueQuarter === 'number'
          ? state.swa.dueQuarter
          : state.swa.lastCheckedQuarter + 1,
    },
    runs: Array.isArray(state.runs) ? state.runs : [],
    events: Array.isArray(state.events) ? state.events : [],
    alerts: Array.isArray(state.alerts) ? state.alerts : [],
    rehearsal: state.rehearsal ?? { active: false, step: 0, totalSteps: 0, label: null, log: [] },
  };
}
