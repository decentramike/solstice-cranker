import type { ReactNode } from 'react';
import type { Alert, CrankerState, SwaState, WalletInfo } from '../types';
import { toneOfSeverity, type Tone } from '../lib/derive';
import { formatDateTime, formatFil, formatUsd, shortAddress } from '../lib/format';
import { StatusGlyph } from './Glyphs';

export function Panel({
  title,
  right,
  children,
  flush,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="panel" aria-label={title}>
      <header className="panel-head">
        <h3>{title}</h3>
        {right ? <div className="head-right">{right}</div> : null}
      </header>
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

/* --------------------------------------------------------------- gate --- */

export function GatePanel({ swa }: { swa: SwaState }) {
  const steps = Math.max(0, Math.min(swa.steps, swa.gateSteps));
  const pips = Array.from({ length: swa.gateSteps }, (_, i) => i < steps);

  return (
    <Panel
      title="Stream weight gate"
      right={
        swa.complete ? (
          <span className="chip">Closed</span>
        ) : (
          <span className="mono">
            {steps} / {swa.gateSteps}
          </span>
        )
      }
    >
      <div className="pips" role="img" aria-label={`${steps} of ${swa.gateSteps} gate steps taken`}>
        {pips.map((filled, i) => (
          <span key={i} className={`pip ${filled ? (swa.complete ? 'closed' : 'filled') : ''}`}>
            {i + 1}
          </span>
        ))}
      </div>

      <dl className="kv">
        <dt>Steps taken</dt>
        <dd>
          {steps} of {swa.gateSteps}
        </dd>
        <dt>Last checked</dt>
        <dd>Q{swa.lastCheckedQuarter}</dd>
        <dt>Next threshold</dt>
        <dd>{swa.complete ? '—' : formatUsd(swa.nextThresholdUsd)}</dd>
        <dt>Gate state</dt>
        <dd>{swa.complete ? 'closed permanently' : 'open'}</dd>
      </dl>

      <p className="controls-note" style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)' }}>
        {swa.complete
          ? 'All steps are taken. quarterlyGateCheck reverts StepsComplete() from here on — that is the terminal state, not a failure.'
          : 'Each passing check that clears the volume threshold takes one step. Missing a quarter costs nothing: the step can always be taken later.'}
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------- wallet --- */

export function WalletPanel({ wallet, tone }: { wallet: WalletInfo; tone: Tone }) {
  return (
    <Panel
      title="Cranker wallet"
      right={
        wallet.belowThreshold ? <span className="chip warn">Below minimum</span> : <span className="chip ok">Funded</span>
      }
    >
      <dl className="kv">
        <dt>Address</dt>
        <dd title={wallet.address}>{shortAddress(wallet.address)}</dd>
        <dt>Balance</dt>
        <dd>{formatFil(wallet.balanceFil)} FIL</dd>
        <dt>Minimum</dt>
        <dd>{formatFil(wallet.minBalanceFil)} FIL</dd>
      </dl>

      {wallet.belowThreshold ? (
        <div className="banner t-warn" style={{ marginTop: 11, marginBottom: 0 }}>
          <StatusGlyph tone={tone === 'crit' ? 'crit' : 'warn'} />
          <span>
            Below the minimum balance. Broadcasts will be rejected before they reach the mempool.
          </span>
        </div>
      ) : null}
    </Panel>
  );
}

/* ------------------------------------------------------------- alerts --- */

export function AlertsPanel({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return null;
  return (
    <Panel title="Alerts" right={<span className="mono">{alerts.length}</span>} flush>
      {alerts.map((a, i) => {
        const tone = toneOfSeverity(a.severity);
        return (
          <div key={`${a.at}-${i}`} className={`alert t-${tone}`}>
            <StatusGlyph tone={tone === 'neutral' ? 'accent' : tone} size={15} />
            <div>
              <div className="title">{a.title}</div>
              <div className="body">{a.body}</div>
              <div className="at">{formatDateTime(a.at)}</div>
            </div>
          </div>
        );
      })}
    </Panel>
  );
}

/* ---------------------------------------------------------- contracts --- */

export function ContractsPanel({ state }: { state: CrankerState }) {
  return (
    <Panel
      title="Deployment"
      right={
        state.contracts.deployed ? (
          <span className="chip ok">Deployed</span>
        ) : (
          <span className="chip crit">Not deployed</span>
        )
      }
    >
      <dl className="kv">
        <dt>Network</dt>
        <dd>{state.network.label}</dd>
        <dt>Chain ID</dt>
        <dd>{state.network.chainId}</dd>
        <dt>SRA</dt>
        <dd title={state.contracts.sra}>{shortAddress(state.contracts.sra)}</dd>
        <dt>SWA</dt>
        <dd title={state.contracts.swa}>{shortAddress(state.contracts.swa)}</dd>
      </dl>
    </Panel>
  );
}
