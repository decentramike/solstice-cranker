import { useState } from 'react';
import type { ActionDecision, ActionOutcome, RunAction, RunRecord } from '../types';
import { actionTone, isExpectedSkip, runTone } from '../lib/derive';
import { formatClock, formatDurationMs, formatInt, shortHash } from '../lib/format';
import { StatusGlyph } from './Glyphs';
import { Panel } from './Panels';

const OUTCOME_LABEL: Record<ActionOutcome, string> = {
  landed: 'landed',
  'not-due': 'not due',
  'already-done': 'already done',
  'gate-closed': 'gate closed',
  'missed-window': 'missed window',
  error: 'error',
};

const DECISION_LABEL: Record<ActionDecision, string> = {
  sent: 'sent',
  skipped: 'skipped',
  failed: 'failed',
  'dry-run': 'dry run',
};

const PAGE = 8;

export function RunHistory({ runs }: { runs: RunRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? runs.slice(0, 50) : runs.slice(0, PAGE);

  return (
    <Panel
      title="Run history"
      right={
        <>
          <span className="mono">{runs.length} runs</span>
          {runs.length > PAGE ? (
            <button type="button" className="btn sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Show recent' : `Show all ${runs.length}`}
            </button>
          ) : null}
        </>
      }
      flush
    >
      {shown.length === 0 ? (
        <p className="empty-note">No runs recorded yet.</p>
      ) : (
        <div className="runs">
          {shown.map((run) => (
            <Run key={run.runId} run={run} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function Run({ run }: { run: RunRecord }) {
  const tone = runTone(run);
  return (
    <article className={`run t-${tone}`}>
      <header className="run-head">
        <span className="when">{formatClock(run.startedAt)}</span>
        <span className="epoch">epoch {formatInt(run.epoch)}</span>
        {run.paused ? (
          <span className="chip" title={run.pauseReason ?? undefined}>
            Paused
          </span>
        ) : null}
        {!run.schedule.chainAgreesWithConfig ? (
          <span className="chip warn" title={run.schedule.divergence ?? undefined}>
            Config divergence
          </span>
        ) : null}
        <span className="spacer" />
        <span className="meta">
          {formatDurationMs(run.durationMs)}
          {run.exitCode !== 0 ? ` · exit ${run.exitCode}` : ''}
        </span>
      </header>

      <ul className="actions">
        {run.actions.map((a, i) => (
          <ActionRow key={`${run.runId}-${a.call}-${i}`} action={a} />
        ))}
      </ul>
    </article>
  );
}

/**
 * Expected skips (NotBound, AlreadySubmitted, StepsComplete) are the normal,
 * healthy output of a cranker that runs every few minutes. They get the neutral
 * treatment. Severity is carried on the action; it drives the tone.
 */
function ActionRow({ action }: { action: RunAction }) {
  const tone = actionTone(action);
  const routine = isExpectedSkip(action) && tone === 'neutral';

  return (
    <li className={`action t-${tone}`}>
      <span className="glyph">
        <StatusGlyph tone={tone} />
      </span>

      <span className="who">
        <span className="call">
          {action.call}
          {action.quarter !== null ? `(${action.quarter})` : '()'}
        </span>
        <span className="outcome">
          {DECISION_LABEL[action.decision]} · {OUTCOME_LABEL[action.outcome]}
          {routine ? ' · routine' : ''}
        </span>
      </span>

      <span className="msg">
        {action.reason ? <code className="reason">{action.reason}</code> : null}
        {action.message}
      </span>

      <span className="tail">
        {action.txHash ? <span title={action.txHash}>{shortHash(action.txHash)}</span> : null}
        {action.gasUsed ? <span>{formatInt(action.gasUsed)} gas</span> : null}
      </span>
    </li>
  );
}
