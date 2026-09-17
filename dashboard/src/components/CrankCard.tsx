import type { CrankStatus, CrankView, Tone } from '../lib/derive';
import { formatEpochDuration, formatInt } from '../lib/format';
import { StatusGlyph } from './Glyphs';

const STATUS_LABEL: Record<CrankStatus, string> = {
  landed: 'Landed',
  open: 'Callable now',
  waiting: 'Not yet due',
  missed: 'Window missed',
  closed: 'Closed',
};

export interface CrankCardProps {
  view: CrankView;
  epoch: number;
  epochSeconds: number;
  /** Window width in epochs used to scale the margin rail. */
  windowEpochs: number;
  /** Extra rows under the fold, e.g. the landing tx. */
  extra?: { label: string; value: string; lost?: boolean }[];
}

export function CrankCard({ view, epoch, epochSeconds, windowEpochs, extra = [] }: CrankCardProps) {
  const chipTone = toChipClass(view.tone);
  const hasDeadline = view.deadlineEpoch !== null && view.marginEpochs !== null;
  const marginFraction =
    hasDeadline && windowEpochs > 0
      ? Math.min(1, Math.max(0, (view.marginEpochs as number) / windowEpochs))
      : 0;

  return (
    <section className={`crank t-${view.tone}`} aria-labelledby={`crank-${view.call}`}>
      <header className="crank-head">
        <StatusGlyph tone={view.tone} size={16} />
        <h3 className="call" id={`crank-${view.call}`}>
          {view.call}({view.dueQuarter})
        </h3>
        <span className="badge-slot">
          <span className={`chip ${chipTone}`}>{STATUS_LABEL[view.status]}</span>
        </span>
      </header>

      <div className="crank-body">
        <p className="crank-headline">{view.headline}</p>
        <p className="crank-detail">{view.detail}</p>

        {hasDeadline ? (
          <div className="margin-rail">
            <div className="rail-head">
              <span>Margin to deadline</span>
              <span className="amount">
                {(view.marginEpochs as number) > 0
                  ? `${formatInt(view.marginEpochs)} epochs · ${formatEpochDuration(view.marginEpochs as number, epochSeconds)}`
                  : 'expired'}
              </span>
            </div>
            <div className={`rail t-${view.tone}`}>
              <div className="fill" style={{ width: `${marginFraction * 100}%` }} />
            </div>
          </div>
        ) : (
          <div className="margin-rail">
            <div className="rail-head">
              <span>Deadline</span>
              <span className="amount">none</span>
            </div>
            <div className="rail na" title="quarterlyGateCheck has no deadline">
              <div className="fill" style={{ width: '0%' }} />
            </div>
          </div>
        )}
      </div>

      <div className="crank-grid">
        <Cell label="Due quarter" value={`Q${view.dueQuarter}`} />
        <Cell
          label={view.status === 'waiting' ? 'Opens at epoch' : 'Opened at epoch'}
          value={formatInt(view.dueAtEpoch)}
          sub={
            view.opensInEpochs > 0
              ? `in ${formatInt(view.opensInEpochs)} epochs`
              : view.overdueEpochs > 0
                ? `open ${formatInt(view.overdueEpochs)} epochs`
                : undefined
          }
        />
        <Cell
          label="Deadline epoch"
          value={view.deadlineEpoch === null ? 'none' : formatInt(view.deadlineEpoch)}
          muted={view.deadlineEpoch === null}
          sub={view.deadlineEpoch === null ? 'catch-up is always possible' : 'exclusive'}
        />
        <Cell
          label={view.call === 'submitShares' ? 'Last submitted' : 'Last checked'}
          value={view.landedQuarter === null ? '—' : `Q${view.landedQuarter}`}
          sub={`at epoch ${formatInt(epoch)} now`}
        />
        {extra.map((row) => (
          <Cell key={row.label} label={row.label} value={row.value} lost={row.lost} />
        ))}
      </div>
    </section>
  );
}

function Cell({
  label,
  value,
  sub,
  muted,
  lost,
}: {
  label: string;
  value: string;
  sub?: string;
  muted?: boolean;
  lost?: boolean;
}) {
  return (
    <div className="cell">
      <div className="label">{label}</div>
      <div className={`value${muted ? ' muted' : ''}${lost ? ' lost' : ''}`}>{value}</div>
      {sub ? <div className="label">{sub}</div> : null}
    </div>
  );
}

function toChipClass(tone: Tone): string {
  switch (tone) {
    case 'crit':
      return 'crit';
    case 'warn':
      return 'warn';
    case 'ok':
      return 'ok';
    case 'accent':
      return 'accent';
    default:
      return '';
  }
}
