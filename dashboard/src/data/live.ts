/**
 * Live transport against devnet/server.mjs.
 *
 * SSE is the primary channel (`GET /api/stream`). If it drops we fall back to
 * polling `GET /api/state` so the screen keeps moving, and keep retrying SSE with
 * exponential backoff. If neither works we go to `offline` promptly rather than
 * spinning forever — the empty state tells the operator how to start the server.
 */

import type { CrankerState } from '../types';
import { looksLikeState, normalizeState, SnapshotStore, type Scenario, type StateSource } from './store';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 15000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
/** Give up on "connecting" and show the empty state after this many failed attempts. */
const OFFLINE_AFTER = 2;

function url(path: string): string {
  return `${API_BASE}${path}`;
}

export function createLiveSource(): StateSource {
  const store = new SnapshotStore();

  let es: EventSource | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let disposed = false;

  const stopPolling = () => {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  const closeStream = () => {
    if (es) {
      es.close();
      es = null;
    }
  };

  const fail = (message: string) => {
    const attempts = store.getSnapshot().attempts + 1;
    const hasState = store.getSnapshot().state !== null;
    store.set({
      attempts,
      error: message,
      status: hasState ? 'polling' : attempts >= OFFLINE_AFTER ? 'offline' : 'connecting',
    });
  };

  const fetchState = async (): Promise<boolean> => {
    try {
      const res = await fetch(url('/api/state'), { headers: { accept: 'application/json' } });
      if (!res.ok) {
        fail(`GET /api/state responded ${res.status} ${res.statusText}`);
        return false;
      }
      const body: unknown = await res.json();
      if (!looksLikeState(body)) {
        fail('GET /api/state returned a payload that does not match the data contract.');
        return false;
      }
      store.setState(normalizeState(body), es !== null ? 'live' : 'polling');
      return true;
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Could not reach the devnet server.');
      return false;
    }
  };

  /**
   * Self-rescheduling poll. While the server is answering this is a steady 3s.
   * While it is down the interval backs off to 15s — the page keeps watching so
   * it recovers by itself once `npm run demo` starts, without hammering the port.
   */
  const startPolling = () => {
    if (pollTimer !== null || disposed) return;

    const tick = () => {
      pollTimer = null;
      void fetchState().then(() => {
        if (disposed || es !== null) return;
        const snap = store.getSnapshot();
        const delay =
          snap.state !== null
            ? POLL_INTERVAL_MS
            : Math.min(POLL_MAX_MS, POLL_INTERVAL_MS * Math.max(1, snap.attempts));
        pollTimer = setTimeout(tick, delay);
      });
    };

    tick();
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== null) return;
    const attempts = store.getSnapshot().attempts;
    const base = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
    // Jitter so several tabs do not stampede the devnet server together.
    const delay = base + Math.floor(Math.random() * 400);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openStream();
    }, delay);
  };

  const openStream = () => {
    if (disposed) return;
    closeStream();
    let source: EventSource;
    try {
      source = new EventSource(url('/api/stream'));
    } catch {
      fail('This browser refused to open the event stream.');
      startPolling();
      scheduleReconnect();
      return;
    }
    es = source;

    source.onopen = () => {
      stopPolling();
      store.set({ status: 'live', error: null, attempts: 0 });
    };

    source.onmessage = (ev: MessageEvent<string>) => {
      try {
        const body: unknown = JSON.parse(ev.data);
        if (!looksLikeState(body)) return;
        store.setState(normalizeState(body), 'live');
      } catch {
        // A single malformed frame is not a reason to tear anything down.
      }
    };

    source.onerror = () => {
      closeStream();
      fail('Event stream dropped. Falling back to polling.');
      startPolling();
      scheduleReconnect();
    };
  };

  const start = () => {
    if (started) return;
    started = true;
    disposed = false;
    store.set({ status: 'connecting', error: null });
    // Fetch once so the first paint does not wait on the stream handshake.
    void fetchState().then((ok) => {
      if (disposed) return;
      if (ok) openStream();
      else {
        startPolling();
        scheduleReconnect();
      }
    });
  };

  const dispose = () => {
    disposed = true;
    started = false;
    closeStream();
    stopPolling();
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const post = async (path: string, body?: unknown): Promise<void> => {
    store.set({ busy: true });
    try {
      const res = await fetch(url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        store.set({ error: `POST ${path} responded ${res.status} ${res.statusText}` });
      } else {
        // Drain the body so keep-alive connections are reusable, then refresh.
        await res.text();
      }
    } catch (err) {
      store.set({ error: err instanceof Error ? err.message : `POST ${path} failed.` });
    } finally {
      store.set({ busy: false });
      await fetchState();
    }
  };

  const scenarios: Scenario[] = [];

  return {
    mode: 'live',
    subscribe(cb) {
      start();
      const unsub = store.subscribe(cb);
      return () => {
        unsub();
        if (store.listenerCount === 0) dispose();
      };
    },
    getSnapshot: store.getSnapshot,
    retry() {
      store.set({ attempts: 0, error: null, status: 'connecting' });
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      void fetchState().then((ok) => {
        if (ok) openStream();
        else scheduleReconnect();
      });
    },
    advance: (epochs: number) => post('/api/advance', { epochs }),
    crank: () => post('/api/crank'),
    setPaused: (paused: boolean) => post('/api/pause', { paused }),
    scenarios,
    activeScenario: null,
    selectScenario() {
      /* not applicable against a live server */
    },
  };
}

export type { CrankerState };
