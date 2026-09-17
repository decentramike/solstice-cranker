import { useEffect, useState } from 'react';
import type { CrankerState } from '../types';
import type { Snapshot, TransportStatus } from '../data/source';
import type { Tone, View } from '../lib/derive';
import { formatEpochDuration, formatInt } from '../lib/format';
import { useTheme } from '../lib/theme';
import { ClockIcon, StatusGlyph, SunMoonIcon } from './Glyphs';

const TRANSPORT_LABEL: Record<TransportStatus, string> = {
  connecting: 'Connecting',
  live: 'Live · SSE',
  polling: 'Polling',
  offline: 'Offline',
  fixtures: 'Fixtures',
};

export function TopBar({
  state,
  snapshot,
  onRetry,
}: {
  state: CrankerState | null;
  snapshot: Snapshot;
  onRetry: () => void;
}) {
  const { isDark, cycle } = useTheme();

  return (
    <header className="topbar">
      <div className="brand">
        <h1>Solstice Cranker</h1>
        <span className="brand-sub">Mission Control</span>
      </div>

      <div className="topbar-spacer" />

      {state ? (
        <div className="readouts">
          <div className="readout">
            <span className="label">Network</span>
            <span className="value">{state.network.label}</span>
          </div>
          <div className="readout">
            <span className="label">Chain ID</span>
            <span className="value mono">{state.network.chainId}</span>
          </div>
          <div className="readout">
            <span className="label">Epoch</span>
            <span className="value mono">{formatInt(state.chain.epoch)}</span>
          </div>
        </div>
      ) : null}

      <span className="conn" title={snapshot.error ?? undefined}>
        <span className={`conn-dot ${snapshot.status}`} />
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
          {TRANSPORT_LABEL[snapshot.status]}
        </span>
      </span>

      {snapshot.status === 'offline' || snapshot.status === 'polling' ? (
        <button type="button" className="btn sm" onClick={onRetry}>
          Reconnect
        </button>
      ) : null}

      <button
        type="button"
        className="btn icon"
        onClick={cycle}
        aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        <SunMoonIcon dark={isDark} />
      </button>
    </header>
  );
}

/** The aria-live region. One sentence answering: is the next crank going to land? */
export function StatusStrip({ view, state }: { view: View; state: CrankerState }) {
  return (
    <div className={`statusbar t-${view.tone}`} role="status" aria-live="polite" aria-atomic="true">
      <StatusGlyph tone={view.tone} size={22} />
      <div className="status-text">
        <h2>{view.headline}</h2>
        <p>{view.subhead}</p>
      </div>
      <div className="status-side">
        {view.paused ? (
          <span className="chip warn" title={view.pauseReason ?? undefined}>
            Cranker paused
          </span>
        ) : null}
        <span className="chip">
          <ClockIcon />
          {formatEpochDuration(state.quarters.epochsUntilNextPhase, state.network.epochSeconds)} to
          next boundary
        </span>
      </div>
    </div>
  );
}

export function Banner({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <div className={`banner t-${tone}`}>
      <StatusGlyph tone={tone} />
      <span>{children}</span>
    </div>
  );
}

/**
 * Server down. Says what is wrong and the exact command that fixes it; does not
 * spin forever and does not blank the page.
 */
export function DevnetDown({
  error,
  attempts,
  onRetry,
}: {
  error: string | null;
  attempts: number;
  onRetry: () => void;
}) {
  return (
    <div className="empty">
      <h2>Devnet is not running</h2>
      <p>
        Mission Control could not reach the devnet server on <code className="mono">:8787</code>.
        Start it from the repository root:
      </p>

      <CopyCommand command="npm run demo" />

      <p style={{ marginTop: 14, marginBottom: 0 }}>
        That boots the local chain, deploys the SRA and SWA, and serves{' '}
        <code className="mono">/api/state</code>. This page reconnects on its own once it answers.
      </p>

      <div className="why">
        <div>
          Attempts: <span className="mono">{attempts}</span>
          {error ? (
            <>
              {' · '}
              <span className="mono">{error}</span>
            </>
          ) : null}
        </div>
        <div style={{ marginTop: 8 }}>
          To work without a server at all, run the dashboard against its bundled fixtures:{' '}
          <code>VITE_USE_FIXTURES=1 npm run dev</code>
        </div>
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={onRetry}>
            Try again now
          </button>
        </div>
      </div>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="cmd">
      <span className="prompt">$</span>
      <code>{command}</code>
      <button
        type="button"
        className="btn sm"
        onClick={() => {
          navigator.clipboard?.writeText(command).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function Connecting() {
  return (
    <div className="empty" style={{ borderLeftColor: 'var(--accent)' }}>
      <h2>Connecting to the devnet server…</h2>
      <p style={{ marginBottom: 0 }}>
        Reading <code className="mono">GET /api/state</code> on <code className="mono">:8787</code>.
      </p>
    </div>
  );
}
