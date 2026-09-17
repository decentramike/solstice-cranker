import { useState } from 'react';
import type { CrankerState } from '../types';
import type { StateSource } from '../data/source';
import { formatInt } from '../lib/format';
import { PauseIcon, PlayIcon } from './Glyphs';
import { Panel } from './Panels';

const STEPS = [1, 10, 40, 120];

/**
 * Devnet-only. These are the three write endpoints in the data contract and they
 * exist nowhere else — the whole panel is hidden when the network is not devnet.
 */
export function DemoControls({
  state,
  source,
  busy,
}: {
  state: CrankerState;
  source: StateSource;
  busy: boolean;
}) {
  const paused = state.runs.length > 0 ? state.runs[0].paused : false;
  const [pending, setPending] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setPending(key);
    try {
      await fn();
    } finally {
      setPending(null);
    }
  };

  const disabled = busy || pending !== null;
  const toBoundary = state.quarters.epochsUntilNextPhase;

  return (
    <Panel title="Demo controls" right={<span className="chip">devnet only</span>}>
      <div className="controls">
        <div className="row">
          <span className="row-label">Advance chain</span>
          {STEPS.map((n) => (
            <button
              key={n}
              type="button"
              className="btn sm"
              disabled={disabled}
              onClick={() => void run(`adv${n}`, () => source.advance(n))}
            >
              +{n}
            </button>
          ))}
          <button
            type="button"
            className="btn sm"
            disabled={disabled || toBoundary <= 0}
            onClick={() => void run('advBoundary', () => source.advance(toBoundary))}
            title={`Advance ${toBoundary} epochs to the next phase boundary`}
          >
            +{formatInt(toBoundary)} to boundary
          </button>
        </div>

        <div className="row">
          <span className="row-label">Cranker</span>
          <button
            type="button"
            className="btn primary"
            disabled={disabled}
            onClick={() => void run('crank', () => source.crank())}
          >
            {pending === 'crank' ? 'Running…' : 'Run crank now'}
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={paused}
            disabled={disabled}
            onClick={() => void run('pause', () => source.setPaused(!paused))}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>

        <p className="note">
          Advance mines blocks on the local devnet; the cranker and the contracts see the new epoch
          immediately. Nothing here exists on calibnet or mainnet.
        </p>
      </div>
    </Panel>
  );
}

export function ScenarioPicker({ source }: { source: StateSource }) {
  if (source.scenarios.length === 0) return null;
  return (
    <Panel title="Fixture scenario" right={<span className="chip solid-fixtures">fixtures</span>}>
      <div className="scenario-list">
        {source.scenarios.map((s) => (
          <button
            key={s.id}
            type="button"
            className="scenario"
            aria-pressed={source.activeScenario === s.id}
            onClick={() => source.selectScenario(s.id)}
          >
            <span className="s-label">{s.label}</span>
            <span className="s-note">{s.note}</span>
          </button>
        ))}
      </div>
      <p className="note" style={{ marginTop: 11, fontSize: 11.5, color: 'var(--text-3)' }}>
        Served from <code className="mono">src/fixtures</code>. Set <code className="mono">VITE_USE_FIXTURES=0</code>{' '}
        (or unset it) to point the same UI at the devnet server.
      </p>
    </Panel>
  );
}
