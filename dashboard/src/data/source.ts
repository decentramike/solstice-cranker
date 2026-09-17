/**
 * The one place that decides where state comes from.
 *
 * Flip it with the VITE_USE_FIXTURES env var; nothing else in the app knows or
 * cares which transport is in use. When devnet/server.mjs lands, drop the env var
 * and the whole dashboard is live — no component changes.
 */

import { useSyncExternalStore } from 'react';
import { createFixtureSource } from './fixtures';
import { createLiveSource } from './live';
import type { Snapshot, StateSource } from './store';

export const USE_FIXTURES = import.meta.env.VITE_USE_FIXTURES === '1';

let singleton: StateSource | null = null;

export function getStateSource(): StateSource {
  singleton ??= USE_FIXTURES ? createFixtureSource() : createLiveSource();
  return singleton;
}

export function useStateSource(): { source: StateSource; snapshot: Snapshot } {
  const source = getStateSource();
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  return { source, snapshot };
}

export type { Snapshot, StateSource, Scenario, TransportStatus } from './store';
