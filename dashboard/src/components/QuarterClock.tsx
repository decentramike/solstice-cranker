import type { CrankerState } from '../types';
import type { View } from '../lib/derive';
import { PHASE_BLURB, PHASE_LABEL } from '../lib/schedule';
import { formatEpochDuration, formatInt } from '../lib/format';
import { StatusGlyph } from './Glyphs';

/**
 * The hero. One question: is the next crank going to land?
 * The timeline draws the current quarter's whole life at real proportions, with
 * "now" and the epoch the crank opens both marked on the same scale.
 */
export function QuarterClock({ state, view }: { state: CrankerState; view: View }) {
  const q = state.quarters;
  const { timeline } = view;
  const epochSeconds = state.network.epochSeconds;
  const phaseTone = q.phase === 'bound' ? 'accent' : 'neutral';

  return (
    <section className="hero" aria-labelledby="quarter-clock-title">
      <h2 id="quarter-clock-title" className="visually-hidden">
        Quarter clock
      </h2>

      <div className="hero-top">
        <div className="clockface">
          <div className="eyebrow">Current quarter</div>
          <div className="quarter">
            <span className="q-num">{q.currentQuarter}</span>
            <span className="q-word">quarter</span>
          </div>

          <div className="phase-line">
            <StatusGlyph tone={phaseTone} />
            <span className="phase-name">{PHASE_LABEL[q.phase]}</span>
          </div>
          <p className="blurb">{PHASE_BLURB[q.phase]}</p>

          <div className="countdown">
            <div className="label">
              {q.phase === 'bound' ? 'Quarter ends in' : 'Next phase boundary in'}
            </div>
            <div className="figure">
              <span className="n mono">{formatInt(q.epochsUntilNextPhase)}</span>
              <span className="unit">epochs</span>
            </div>
            <div className="wall">{formatEpochDuration(q.epochsUntilNextPhase, epochSeconds)}</div>
          </div>
        </div>

        <div className="timeline-pane">
          <div className="timeline-head">
            <h3>Quarter {q.currentQuarter} lifecycle</h3>
            <span className="span mono">
              epoch {formatInt(timeline.startEpoch)} → {formatInt(timeline.endEpoch)}
            </span>
          </div>

          <div
            className="timeline"
            role="img"
            aria-label={buildTimelineLabel(state, view)}
          >
            <div className="tl-track">
              {timeline.segments.map((seg) => (
                <div
                  key={seg.key}
                  className={`tl-seg ${seg.key}${seg.active ? ' is-active' : ''}`}
                  style={{ width: `${Math.max(seg.width, 0) * 100}%` }}
                >
                  <span className="seg-label">{seg.label}</span>
                </div>
              ))}
            </div>

            {timeline.markers.map((m) => (
              <div
                key={m.key}
                className={`tl-marker m-${m.tone}`}
                style={{ left: `${m.at * 100}%` }}
              >
                <div className="stem" />
                <div className="flag">
                  <span className="flag-label">{m.label}</span>
                  <span className="flag-epoch">{formatInt(m.epoch)}</span>
                </div>
              </div>
            ))}

            <div className="tl-now" style={{ left: `${timeline.nowAt * 100}%` }}>
              <div className="stem" />
              <div className="head">
                NOW <span className="now-epoch">{formatInt(state.chain.epoch)}</span>
              </div>
            </div>
          </div>

          <div className="tl-scale">
            <span>{formatInt(timeline.startEpoch)}</span>
            <span>{formatEpochDuration(timeline.endEpoch - timeline.startEpoch, epochSeconds)} wide</span>
            <span>{formatInt(timeline.endEpoch)}</span>
          </div>
        </div>
      </div>

      <div className="hero-foot">
        <Cell label="Quarter start" value={formatInt(q.quarterStartEpoch)} sub="epoch" />
        <Cell
          label="Posting ends"
          value={formatInt(q.quarterStartEpoch + q.postPeriod)}
          sub={`+${formatInt(q.postPeriod)} epochs`}
        />
        <Cell
          label="Binds · crank opens"
          value={formatInt(q.bindingEpoch)}
          sub={`+${formatInt(q.verificationWindow)} verification`}
        />
        <Cell
          label="Next quarter"
          value={formatInt(q.nextQuarterStartEpoch)}
          sub={`${formatInt(q.epochsPerQuarter)} epochs per quarter`}
        />
        <Cell
          label="Epoch length"
          value={`${formatInt(epochSeconds)}s`}
          sub={formatEpochDuration(q.epochsPerQuarter, epochSeconds) + ' per quarter'}
        />
      </div>
    </section>
  );
}

function Cell({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="cell">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

function buildTimelineLabel(state: CrankerState, view: View): string {
  const q = state.quarters;
  const parts = [
    `Quarter ${q.currentQuarter} runs from epoch ${q.quarterStartEpoch} to ${q.nextQuarterStartEpoch}.`,
    `Posting until ${q.quarterStartEpoch + q.postPeriod}, verification until ${q.bindingEpoch}, bound from ${q.bindingEpoch}.`,
    `Now is epoch ${state.chain.epoch}, in the ${PHASE_LABEL[q.phase].toLowerCase()}.`,
  ];
  if (view.submit.deadlineEpoch !== null) {
    parts.push(
      `submitShares for quarter ${view.submit.dueQuarter} must land before epoch ${view.submit.deadlineEpoch}.`,
    );
  }
  return parts.join(' ');
}
