import { describeLost } from '../lib/derive';

/**
 * The permanent record.
 *
 * Rendered whenever `sra.missedQuarters` is non-empty, and rendered *regardless of
 * every other signal on the page* — its whole reason to exist is the case where the
 * cranker has recovered, the board is green, and a quarter is silently gone.
 *
 * Deliberately NOT styled like the at-risk countdown. That state is urgent and
 * actionable: hatched fill, octagon-and-cross, a shrinking margin bar. This one is
 * finished and actionable by nobody, so it reads as a ledger entry — a ticked record
 * rule down the edge, struck-through quarter numbers, flat fill, no countdown, no
 * progress bar, no verb in the imperative. Different in kind, not louder.
 */
export function LostQuarters({ quarters }: { quarters: number[] }) {
  if (quarters.length === 0) return null;

  const n = quarters.length;
  // The map that governs the lost quarters is the last one that landed BEFORE the
  // gap — not `lastSubmittedQuarter`, which by the time this matters most has
  // already jumped past the gap to a later, successful quarter.
  const lastGoodQuarter = Math.min(...quarters) - 1;

  return (
    <section className="record" role="region" aria-labelledby="record-title">
      <div className="record-rule" aria-hidden />

      <div className="record-mark">
        <LostGlyph />
      </div>

      <div className="record-body">
        <h2 id="record-title" className="record-title">
          Permanent record · not recoverable
        </h2>
        <p className="record-lead">
          {describeLost(quarters)} {n === 1 ? 'was' : 'were'} never submitted.{' '}
          {n === 1 ? 'That share map is' : 'Those share maps are'} lost for good.
        </p>
        <p className="record-detail">
          {quarters.map((q) => `submitShares(${q})`).join(' and ')}{' '}
          {n === 1 ? 'reverts' : 'revert'} NotLatestQuarter permanently — a later quarter is already
          bound, and the SRA only ever accepts the latest one. There is no on-chain recovery path
          and no action that changes this. Rewards for{' '}
          {n === 1 ? 'that quarter' : 'those quarters'} were distributed under the quarter{' '}
          {lastGoodQuarter} share map, the last one that landed before the gap.
        </p>
      </div>

      <div className="record-tombs">
        {quarters.map((q) => (
          <span key={q} className="tomb">
            <span className="tomb-q">Q{q}</span>
            <span className="tomb-state">lost</span>
          </span>
        ))}
      </div>
    </section>
  );
}

/**
 * A struck block. Not the octagon (active critical) and not the triangle (warning) —
 * a third shape, so the distinction survives a projector and colour-blind viewers.
 */
function LostGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <rect
        x="1.6"
        y="1.6"
        width="12.8"
        height="12.8"
        rx="1"
        fill="var(--crit-wash)"
        stroke="var(--crit)"
        strokeWidth="1.5"
      />
      <path d="M3.4 12.6L12.6 3.4" stroke="var(--crit)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
