/**
 * Everything the screen needs that the state object does not carry directly.
 *
 * The state object is authoritative for anything it reports. This module only
 * fills gaps (window widths, margins, "is this going to land") and never
 * overrides a server-reported value with a locally computed one.
 */

import type {
  ChainEvent,
  CrankerState,
  RunAction,
  RunRecord,
  SharesSubmittedEvent,
  Severity,
} from '../types';
import { isSharesSubmitted } from '../types';
import { bindingEpoch, geometryOf, quarterStart, type Geometry } from './schedule';

export type Tone = 'neutral' | 'ok' | 'accent' | 'warn' | 'crit';

const TONE_RANK: Record<Tone, number> = { neutral: 0, ok: 1, accent: 2, warn: 3, crit: 4 };

export function worstTone(tones: Tone[]): Tone {
  return tones.reduce<Tone>((acc, t) => (TONE_RANK[t] > TONE_RANK[acc] ? t : acc), 'neutral');
}

export function toneOfSeverity(s: Severity): Tone {
  return s === 'critical' ? 'crit' : s === 'warn' ? 'warn' : 'neutral';
}

/** An expected skip. These must read as calm; a wall of red for healthy behaviour is useless. */
export function isExpectedSkip(a: RunAction): boolean {
  return (
    a.decision === 'skipped' &&
    (a.outcome === 'not-due' || a.outcome === 'already-done' || a.outcome === 'gate-closed')
  );
}

/** Severity is carried on the action — respect it, then fall back to the outcome. */
export function actionTone(a: RunAction): Tone {
  if (a.severity === 'critical') return 'crit';
  if (a.severity === 'warn') return 'warn';
  if (a.outcome === 'landed') return 'ok';
  return 'neutral';
}

export function runTone(run: RunRecord): Tone {
  return worstTone(run.actions.map(actionTone));
}

// ---------------------------------------------------------------------------

export type CrankStatus = 'landed' | 'open' | 'waiting' | 'missed' | 'closed';

export interface CrankView {
  call: 'submitShares' | 'quarterlyGateCheck';
  dueQuarter: number;
  /** Epoch the call becomes callable (binding epoch of the due quarter). */
  dueAtEpoch: number;
  /** Exclusive; null for quarterlyGateCheck, which has no deadline. */
  deadlineEpoch: number | null;
  status: CrankStatus;
  tone: Tone;
  /** Epochs from now to the deadline. Null when there is no deadline. */
  marginEpochs: number | null;
  /** Epochs until the call opens; 0 once it is callable. */
  opensInEpochs: number;
  /** How far past its opening epoch an un-landed call is. 0 when not yet open. */
  overdueEpochs: number;
  landedQuarter: number | null;
  headline: string;
  detail: string;
}

export interface TimelineSegment {
  key: 'posting' | 'verification' | 'bound';
  label: string;
  startEpoch: number;
  endEpoch: number;
  /** 0..1 within the drawn window. */
  start: number;
  width: number;
  active: boolean;
}

export interface TimelineMarker {
  key: string;
  label: string;
  sublabel?: string;
  epoch: number;
  /** 0..1 within the drawn window. */
  at: number;
  tone: Tone;
  /** True when the marker's real epoch is outside the drawn window and had to be clamped. */
  clamped: boolean;
}

export interface TimelineView {
  startEpoch: number;
  endEpoch: number;
  segments: TimelineSegment[];
  markers: TimelineMarker[];
  nowAt: number;
  nowClamped: boolean;
}

export interface View {
  tone: Tone;
  headline: string;
  subhead: string;
  submit: CrankView;
  gate: CrankView;
  timeline: TimelineView;
  walletTone: Tone;
  lastSharesSubmitted: SharesSubmittedEvent | null;
  /**
   * Quarters whose share maps are gone for good, verbatim from sra.missedQuarters.
   * Not derived, and deliberately independent of every live signal: this stays
   * true after the cranker recovers and the rest of the board goes green.
   */
  lostQuarters: number[];
  /** True when the CURRENT due quarter has just run out of window. */
  shareMapLost: boolean;
  isDevnet: boolean;
  paused: boolean;
  pauseReason: string | null;
}

// ---------------------------------------------------------------------------

function marginThresholds(g: Geometry): { warn: number; crit: number } {
  const span = Math.max(g.epochsPerQuarter, 1);
  return {
    warn: Math.max(2, Math.floor(span * 0.25)),
    crit: Math.max(1, Math.floor(span * 0.1)),
  };
}

function deriveSubmit(state: CrankerState, g: Geometry): CrankView {
  const epoch = state.chain.epoch;
  // The latest bound quarter, straight from the server. Deriving this as
  // lastSubmittedQuarter + 1 would put a live countdown on a quarter that is
  // already unreachable — exactly the wrong thing to show.
  const dueQuarter = state.sra.dueQuarter;
  const dueAtEpoch = bindingEpoch(g, dueQuarter);
  const deadlineEpoch = state.sra.deadlineEpoch;
  const landed = state.sra.lastSubmittedQuarter >= dueQuarter;
  const marginEpochs = deadlineEpoch - epoch;
  const opensInEpochs = Math.max(0, dueAtEpoch - epoch);
  const overdueEpochs = landed ? 0 : Math.max(0, epoch - dueAtEpoch);
  const { warn, crit } = marginThresholds(g);

  let status: CrankStatus;
  let tone: Tone;
  let headline: string;
  let detail: string;

  if (landed) {
    status = 'landed';
    tone = 'ok';
    headline = `Quarter ${dueQuarter} submitted`;
    detail = 'The share map for this quarter is on chain.';
  } else if (marginEpochs <= 0) {
    status = 'missed';
    tone = 'crit';
    headline = `Quarter ${dueQuarter} share map lost`;
    detail = `The window closed at epoch ${deadlineEpoch}. submitShares(${dueQuarter}) now reverts NotLatestQuarter(${dueQuarter}) permanently — there is no recovery path on chain.`;
  } else if (epoch < dueAtEpoch) {
    status = 'waiting';
    tone = state.sra.atRisk ? 'warn' : 'neutral';
    headline = `Quarter ${dueQuarter} opens at epoch ${dueAtEpoch}`;
    detail = `Not callable yet. Quarter ${dueQuarter} binds once its verification window closes.`;
  } else {
    status = 'open';
    if (marginEpochs <= crit) tone = 'crit';
    else if (marginEpochs <= warn || state.sra.atRisk) tone = 'warn';
    else tone = 'accent';
    headline = `Quarter ${dueQuarter} is callable now`;
    detail =
      tone === 'crit'
        ? `Only ${marginEpochs} epochs of margin remain before the share map is lost for good.`
        : `Open since epoch ${dueAtEpoch}. ${marginEpochs} epochs of margin remain.`;
  }

  return {
    call: 'submitShares',
    dueQuarter,
    dueAtEpoch,
    deadlineEpoch,
    status,
    tone,
    marginEpochs,
    opensInEpochs,
    overdueEpochs,
    landedQuarter: state.sra.lastSubmittedQuarter,
    headline,
    detail,
  };
}

function deriveGate(state: CrankerState, g: Geometry): CrankView {
  const epoch = state.chain.epoch;
  // Server-supplied (lastCheckedQuarter + 1, which for the gate is the right form).
  const dueQuarter = state.swa.dueQuarter;
  const dueAtEpoch = bindingEpoch(g, dueQuarter);
  const opensInEpochs = Math.max(0, dueAtEpoch - epoch);
  const overdueEpochs = Math.max(0, epoch - dueAtEpoch);
  const lateThreshold = Math.max(2, Math.floor(g.epochsPerQuarter * 0.25));

  let status: CrankStatus;
  let tone: Tone;
  let headline: string;
  let detail: string;

  if (state.swa.complete) {
    status = 'closed';
    tone = 'neutral';
    headline = 'Gate closed';
    detail = `All ${state.swa.gateSteps} steps have been taken. quarterlyGateCheck reverts StepsComplete() from here on — that is the terminal state, not a fault.`;
  } else if (epoch < dueAtEpoch) {
    status = 'waiting';
    tone = 'neutral';
    headline = `Quarter ${dueQuarter} opens at epoch ${dueAtEpoch}`;
    detail = 'Not callable yet. Shares the same binding epoch as submitShares.';
  } else {
    status = 'open';
    tone = overdueEpochs > lateThreshold ? 'warn' : 'accent';
    headline = `Quarter ${dueQuarter} is callable now`;
    detail =
      overdueEpochs > lateThreshold
        ? `Open for ${overdueEpochs} epochs and still not taken. No deadline applies — a late check still counts — but the step is being deferred.`
        : `Open since epoch ${dueAtEpoch}. No deadline: a missed gate check can always be caught up.`;
  }

  return {
    call: 'quarterlyGateCheck',
    dueQuarter,
    dueAtEpoch,
    deadlineEpoch: null,
    status,
    tone,
    marginEpochs: null,
    opensInEpochs,
    overdueEpochs,
    landedQuarter: state.swa.lastCheckedQuarter,
    headline,
    detail,
  };
}

function deriveTimeline(state: CrankerState, g: Geometry, submit: CrankView): TimelineView {
  const q = state.quarters;
  const startEpoch = q.quarterStartEpoch;
  const endEpoch = q.nextQuarterStartEpoch > startEpoch ? q.nextQuarterStartEpoch : startEpoch + 1;
  const span = endEpoch - startEpoch;
  const pos = (e: number) => Math.min(1, Math.max(0, (e - startEpoch) / span));

  const postEndEpoch = startEpoch + g.postPeriod;
  const bindEpoch = q.bindingEpoch;

  const segments: TimelineSegment[] = [
    {
      key: 'posting',
      label: 'Posting',
      startEpoch,
      endEpoch: postEndEpoch,
      start: pos(startEpoch),
      width: pos(postEndEpoch) - pos(startEpoch),
      active: q.phase === 'posting',
    },
    {
      key: 'verification',
      label: 'Verification',
      startEpoch: postEndEpoch,
      endEpoch: bindEpoch,
      start: pos(postEndEpoch),
      width: pos(bindEpoch) - pos(postEndEpoch),
      active: q.phase === 'verification',
    },
    {
      key: 'bound',
      label: 'Bound',
      startEpoch: bindEpoch,
      endEpoch,
      start: pos(bindEpoch),
      width: pos(endEpoch) - pos(bindEpoch),
      active: q.phase === 'bound',
    },
  ];

  const markers: TimelineMarker[] = [
    {
      key: 'binding',
      label: 'Crank opens',
      sublabel: `Q${q.currentQuarter} binds`,
      epoch: bindEpoch,
      at: pos(bindEpoch),
      tone: 'accent',
      clamped: bindEpoch < startEpoch || bindEpoch > endEpoch,
    },
  ];

  // The submitShares deadline for the due quarter is the binding epoch of the
  // quarter after it. Draw it only when it actually falls inside this window.
  const dl = submit.deadlineEpoch;
  if (dl !== null && dl >= startEpoch && dl <= endEpoch && submit.status !== 'landed') {
    const tone: Tone = submit.tone === 'crit' ? 'crit' : 'warn';
    // The binding epoch of quarter N is also the deadline for quarter N-1, so the
    // two markers land on the same tick more often than not. Merge rather than stack.
    const collision = markers.find((m) => m.epoch === dl);
    if (collision) {
      collision.label = 'Opens · Q' + submit.dueQuarter + ' deadline';
      collision.sublabel = `Q${submit.dueQuarter} unsubmittable after this`;
      collision.tone = tone;
    } else {
      markers.push({
        key: 'deadline',
        label: 'Deadline',
        sublabel: `Q${submit.dueQuarter} lost after this`,
        epoch: dl,
        at: pos(dl),
        tone,
        clamped: false,
      });
    }
  }

  return {
    startEpoch,
    endEpoch,
    segments,
    markers,
    nowAt: pos(state.chain.epoch),
    nowClamped: state.chain.epoch < startEpoch || state.chain.epoch > endEpoch,
  };
}

/** "Quarter 5" / "Quarters 5 and 6" / "Quarters 5, 6 and 9" */
export function describeLost(quarters: number[]): string {
  const qs = quarters.map((q) => `${q}`);
  const noun = qs.length === 1 ? 'Quarter' : 'Quarters';
  if (qs.length === 1) return `${noun} ${qs[0]}`;
  return `${noun} ${qs.slice(0, -1).join(', ')} and ${qs[qs.length - 1]}`;
}

function findLastSharesSubmitted(events: ChainEvent[]): SharesSubmittedEvent | null {
  for (const e of events) if (isSharesSubmitted(e)) return e;
  return null;
}

export function deriveView(state: CrankerState): View {
  const g = geometryOf(state.quarters);
  const submit = deriveSubmit(state, g);
  const gate = deriveGate(state, g);
  const timeline = deriveTimeline(state, g, submit);

  const walletTone: Tone = state.wallet.belowThreshold ? 'warn' : 'neutral';
  const chainTone: Tone = !state.chain.connected || !state.contracts.deployed ? 'crit' : 'neutral';

  /*
   * Live signals only. `alerts` is deliberately NOT an input here.
   *
   * Alerts are a timestamped log, and the ones that matter most describe a
   * permanent loss — which is exactly the thing that must not keep the live status
   * line red forever. Letting them drive it produced "submitShares(6) is callable
   * now, 236 epochs of margin" rendered as a critical alarm, which teaches an
   * operator to ignore the colour. Alerts keep their own severity styling in the
   * alerts panel; the permanent record has its own element. This line answers only
   * "is the NEXT crank going to land?", from fields that describe the present.
   */
  const raw = worstTone([submit.tone, gate.tone, walletTone, chainTone]);
  // "Nothing wrong" should read as a positive statement, not an absence of one.
  const tone: Tone = raw === 'neutral' ? 'ok' : raw;

  const shareMapLost = submit.status === 'missed';
  const lostQuarters = Array.isArray(state.sra.missedQuarters) ? state.sra.missedQuarters : [];
  const latestRun = state.runs.length > 0 ? state.runs[0] : null;

  let headline: string;
  let subhead: string;

  if (!state.chain.connected) {
    headline = 'Chain unreachable';
    subhead = 'The devnet RPC is not answering. Nothing can be cranked until it is back.';
  } else if (!state.contracts.deployed) {
    headline = 'Contracts not deployed';
    subhead = 'The SRA and SWA are not on this chain yet. Run npm run devnet:deploy.';
  } else if (shareMapLost) {
    headline = `Quarter ${submit.dueQuarter} share map is permanently lost`;
    subhead = `submitShares(${submit.dueQuarter}) missed its window at epoch ${submit.deadlineEpoch}. This cannot be undone on chain.`;
  } else if (submit.tone === 'crit') {
    headline = `submitShares(${submit.dueQuarter}) will not land without intervention`;
    subhead = `${submit.marginEpochs} epochs of margin left before the quarter ${submit.dueQuarter} share map is lost.`;
  } else if (tone === 'warn') {
    headline = 'Next crank needs attention';
    subhead =
      submit.status === 'open'
        ? `submitShares(${submit.dueQuarter}) is callable with ${submit.marginEpochs} epochs of margin.`
        : gate.tone === 'warn'
          ? gate.detail
          : state.wallet.belowThreshold
            ? 'The cranker wallet is below its minimum balance.'
            : 'See alerts below.';
  } else if (submit.status === 'open') {
    headline = `submitShares(${submit.dueQuarter}) is callable now`;
    subhead = `${submit.marginEpochs} epochs of margin. The cranker picks it up on its next run.`;
  } else if (submit.status === 'landed') {
    headline = 'Next crank is on schedule';
    // deadlineEpoch is binding(dueQuarter + 1): the epoch the next quarter becomes
    // the due one. Same number, but the forward-looking framing is the useful one.
    subhead = `Quarter ${submit.dueQuarter} is submitted. Quarter ${submit.dueQuarter + 1} binds at epoch ${submit.deadlineEpoch} and becomes due then.`;
  } else {
    headline = 'Next crank is on schedule';
    subhead = `submitShares(${submit.dueQuarter}) opens at epoch ${submit.dueAtEpoch}; nothing is at risk.`;
  }

  // The permanent record is stated by its own element, not by the live status line.
  // But an otherwise-green strip must still carry the qualification, so the aria-live
  // region announces it too.
  if (lostQuarters.length > 0 && tone !== 'crit') {
    subhead += ` ${describeLost(lostQuarters)} — permanently unsubmitted, see the record above.`;
  }

  return {
    tone,
    headline,
    subhead,
    submit,
    gate,
    timeline,
    walletTone,
    lastSharesSubmitted: findLastSharesSubmitted(state.events),
    lostQuarters,
    shareMapLost,
    isDevnet: state.network.name === 'devnet',
    paused: latestRun?.paused ?? false,
    pauseReason: latestRun?.pauseReason ?? null,
  };
}

/** Exported for the fixture clock, which needs to know where a quarter starts. */
export { quarterStart };
