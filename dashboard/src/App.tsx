import { useMemo } from 'react';
import { useStateSource, USE_FIXTURES } from './data/source';
import { deriveView } from './lib/derive';
import { formatClock, formatInt, shortHash } from './lib/format';
import { Banner, Connecting, DevnetDown, StatusStrip, TopBar } from './components/Chrome';
import { QuarterClock } from './components/QuarterClock';
import { CrankCard } from './components/CrankCard';
import { RunHistory } from './components/RunHistory';
import { ChainEvents } from './components/ChainEvents';
import { AlertsPanel, ContractsPanel, GatePanel, Panel, WalletPanel } from './components/Panels';
import { DemoControls, ScenarioPicker } from './components/DemoControls';
import { LostQuarters } from './components/LostQuarters';

export default function App() {
  const { source, snapshot } = useStateSource();
  const state = snapshot.state;

  const view = useMemo(() => (state ? deriveView(state) : null), [state]);

  if (!state || !view) {
    return (
      <div className="app">
        <TopBar state={null} snapshot={snapshot} onRetry={source.retry} />
        {snapshot.status === 'offline' ? (
          <DevnetDown error={snapshot.error} attempts={snapshot.attempts} onRetry={source.retry} />
        ) : (
          <Connecting />
        )}
      </div>
    );
  }

  const lastShares = view.lastSharesSubmitted;

  return (
    <div className="app">
      <TopBar state={state} snapshot={snapshot} onRetry={source.retry} />

      {/* First thing on the page, and rendered whatever else is true: a healthy-looking
          board with a silently lost quarter behind it is the worst outcome here. */}
      <LostQuarters quarters={view.lostQuarters} />

      {USE_FIXTURES ? (
        <Banner tone="accent">
          Fixture mode — this page is reading <code className="mono">src/fixtures</code>, not a live
          chain. Numbers are representative, not real.
        </Banner>
      ) : null}

      {snapshot.status === 'polling' ? (
        <Banner tone="warn">
          Event stream dropped; polling <code className="mono">/api/state</code> every 3s while it
          reconnects.
          {snapshot.error ? <> ({snapshot.error})</> : null}
        </Banner>
      ) : null}

      {!state.chain.connected ? (
        <Banner tone="crit">
          The devnet RPC is not answering. Epoch and contract reads below are the last values seen.
        </Banner>
      ) : null}

      {!state.contracts.deployed ? (
        <Banner tone="crit">
          The SRA and SWA are not deployed on this chain. Run{' '}
          <code className="mono">npm run devnet:deploy</code>.
        </Banner>
      ) : null}

      {state.rehearsal.active ? (
        <Banner tone="accent">
          Rehearsal running{state.rehearsal.label ? ` — ${state.rehearsal.label}` : ''}: step{' '}
          {formatInt(state.rehearsal.step)} of {formatInt(state.rehearsal.totalSteps)}.
        </Banner>
      ) : null}

      <StatusStrip view={view} state={state} />

      <QuarterClock state={state} view={view} />

      <div className="layout">
        <div className="col">
          <div className="cranks">
            <CrankCard
              view={view.submit}
              epoch={state.chain.epoch}
              epochSeconds={state.network.epochSeconds}
              windowEpochs={state.quarters.epochsPerQuarter}
              extra={[
                ...(view.lostQuarters.length > 0
                  ? [
                      {
                        label:
                          view.lostQuarters.length === 1 ? 'Quarter lost' : 'Quarters lost',
                        value: view.lostQuarters.map((q) => `Q${q}`).join(', '),
                        lost: true,
                      },
                      { label: 'Recoverable', value: 'no', lost: true },
                    ]
                  : []),
                ...(lastShares
                  ? [
                      {
                        label: `Q${lastShares.quarter} landed in block`,
                        value: formatInt(lastShares.blockNumber),
                      },
                      { label: 'Landing tx', value: shortHash(lastShares.txHash) },
                    ]
                  : []),
              ]}
            />
            <CrankCard
              view={view.gate}
              epoch={state.chain.epoch}
              epochSeconds={state.network.epochSeconds}
              windowEpochs={state.quarters.epochsPerQuarter}
              extra={[
                { label: 'Gate steps', value: `${state.swa.steps} / ${state.swa.gateSteps}` },
                { label: 'Gate state', value: state.swa.complete ? 'closed' : 'open' },
              ]}
            />
          </div>

          <RunHistory runs={state.runs} />
          <ChainEvents events={state.events} />
        </div>

        <div className="col">
          <AlertsPanel alerts={state.alerts} />
          <GatePanel swa={state.swa} />
          <WalletPanel wallet={state.wallet} tone={view.walletTone} />
          <ContractsPanel state={state} />

          {view.isDevnet ? (
            <DemoControls state={state} source={source} busy={snapshot.busy} />
          ) : (
            <Panel title="Demo controls">
              <p style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
                Hidden on {state.network.label}. The advance, crank and pause endpoints exist only on
                the devnet server.
              </p>
            </Panel>
          )}

          {USE_FIXTURES ? <ScenarioPicker source={source} /> : null}
        </div>
      </div>

      <footer className="foot">
        <span>
          Transport: <span className="mono">{source.mode === 'fixtures' ? 'fixtures' : snapshot.status}</span>
        </span>
        <span>
          Updated:{' '}
          <span className="mono">
            {snapshot.lastUpdatedAt ? formatClock(new Date(snapshot.lastUpdatedAt).toISOString()) : '—'}
          </span>
        </span>
        <span>
          Runs held: <span className="mono">{formatInt(state.runs.length)}</span> · events:{' '}
          <span className="mono">{formatInt(state.events.length)}</span>
        </span>
        <span style={{ marginLeft: 'auto' }}>
          Read-only except /api/advance, /api/crank, /api/pause. No key material is read or rendered.
        </span>
      </footer>
    </div>
  );
}
