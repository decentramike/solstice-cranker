import type { ChainEvent } from '../types';
import { isFvmActorCall, isGateCheckResult, isSharesSubmitted } from '../types';
import { formatInt, formatMethodNumber, formatUsd, shortHash, truncateHex } from '../lib/format';
import { StatusGlyph } from './Glyphs';
import { Panel } from './Panels';

const CAP = 14;

export function ChainEvents({ events }: { events: ChainEvent[] }) {
  const shown = events.slice(0, CAP);

  return (
    <Panel
      title="Chain events"
      right={<span className="mono">{events.length} captured</span>}
      flush
    >
      {shown.length === 0 ? (
        <p className="empty-note">No events yet on this chain.</p>
      ) : (
        shown.map((e, i) => <EventRow key={`${e.txHash}-${e.type}-${i}`} event={e} />)
      )}
    </Panel>
  );
}

function EventRow({ event }: { event: ChainEvent }) {
  const fvm = isFvmActorCall(event);
  return (
    <div className={`evt${fvm ? ' fvm' : ''}`}>
      <StatusGlyph tone={fvm ? 'neutral' : 'ok'} size={13} />
      <div>
        <div className="name">
          {event.type}
          {'quarter' in event && event.quarter !== null && event.quarter !== undefined
            ? ` · Q${event.quarter}`
            : ''}
        </div>
        <div className="args">{describeArgs(event)}</div>
      </div>
      <div className="block">
        <div>block {formatInt(event.blockNumber)}</div>
        <div title={event.txHash}>{shortHash(event.txHash)}</div>
      </div>
    </div>
  );
}

function describeArgs(event: ChainEvent) {
  if (isSharesSubmitted(event)) {
    return (
      <>
        <span className="k">recipients </span>
        <span className="v">{formatInt(event.args.recipientCount)}</span>
        <span className="k"> · bound volume </span>
        <span className="v">{formatUsd(event.args.totalUsd)}</span>
      </>
    );
  }

  if (isGateCheckResult(event)) {
    return (
      <>
        <span className="k">threshold </span>
        <span className="v">{event.args.passed ? 'cleared' : 'not cleared'}</span>
        <span className="k"> · steps </span>
        <span className="v">{formatInt(event.args.steps)}</span>
      </>
    );
  }

  if (isFvmActorCall(event)) {
    return (
      <>
        <span className="k">f0</span>
        <span className="v">{formatInt(event.args.actorId)}</span>
        <span className="k"> · </span>
        <span className="v">{event.args.methodName}</span>
        <span className="k"> (method </span>
        <span className="v">{formatMethodNumber(event.args.method)}</span>
        <span className="k">) · params </span>
        <span className="v">{truncateHex(event.args.paramsHex, 20)}</span>
      </>
    );
  }

  const args = event.args ?? {};
  const keys = Object.keys(args).slice(0, 4);
  if (keys.length === 0) return <span className="k">no decoded arguments</span>;
  return (
    <>
      {keys.map((k, i) => (
        <span key={k}>
          {i > 0 ? <span className="k"> · </span> : null}
          <span className="k">{k} </span>
          <span className="v">{String(args[k])}</span>
        </span>
      ))}
    </>
  );
}
