/**
 * The rehearsal schedule: what the cranker may send, and not before when.
 *
 * In rehearsal mode the cranker stops deciding for itself. It sends exactly the calls listed in
 * config/rehearsal-schedule.json, each no earlier than its `notBefore`, and nothing else. The file
 * is built from the runbook's Schedule tab (the plan of record) by
 * scripts/build-rehearsal-schedule.mjs, then reviewed and committed like any other change.
 *
 * One entry per call:
 *
 *   id          "80", or "93.1" / "93.2" when one runbook row holds two calls
 *   step        the runbook step number
 *   function    submitShares | quarterlyGateCheck
 *   args        [q] for submitShares, [] for quarterlyGateCheck
 *   gateQuarter quarterlyGateCheck only: the quarter the row says it checks. The SWA's next
 *               unchecked quarter must equal it at send time, or the call would test a different
 *               quarter than the plan describes. null switches the check off for that entry.
 *   notBefore   ISO 8601 UTC. Never sent before this.
 *   notAfter    ISO 8601 UTC. Never sent at or after this: the row's Closes time plus a grace
 *               period. Without it, switching rehearsal mode on would replay last week's rows.
 *   expect      pass | fail | revert:<ErrorName> | revert:*
 *                 pass    the message lands (exit code 0); a gate check reports passed = true
 *                 fail    a gate check lands and reports passed = false (step 79's "FAIL")
 *                 revert  the message lands on chain with a non-zero exit code; with a name, the
 *                         decoded revert must be that error
 *   status      the runbook's Status column when the file was built. Complete rows never send.
 *   source      the runbook's Action text, verbatim, for the reviewer
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import sraAbi from '../../abi/ServiceRewardsActor.json' with { type: 'json' };
import swaAbi from '../../abi/StreamWeightActor.json' with { type: 'json' };

export const REHEARSAL_CHAIN_ID = 314159;

/** The two permissionless calls, and which contract each one goes to. */
export const CALLS = {
  submitShares: { contract: 'sra', abi: sraAbi },
  quarterlyGateCheck: { contract: 'swa', abi: swaAbi },
};

/** Every custom error either contract declares. Only these count as a named revert. */
export const ERROR_NAMES = [
  ...new Set([...sraAbi, ...swaAbi].filter((f) => f.type === 'error').map((f) => f.name)),
];

const DONE_STATUSES = /^(complete|completed|done|skipped|skip|n\/a|cancelled|canceled)$/i;

export class ScheduleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScheduleError';
  }
}

// ---------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------

/** Parses and validates `expect`. Returns {kind, error} with error null for pass/fail/revert:*. */
export function parseExpect(value) {
  const v = String(value ?? '').trim();
  if (v === 'pass' || v === 'fail') return { kind: v, error: null };
  const m = v.match(/^revert:(\*|[A-Za-z_][A-Za-z0-9_]*)$/);
  if (m) {
    if (m[1] !== '*' && !ERROR_NAMES.includes(m[1])) {
      throw new ScheduleError(`expect "${v}": ${m[1]} is not an error either contract declares`);
    }
    return { kind: 'revert', error: m[1] === '*' ? null : m[1] };
  }
  throw new ScheduleError(`expect "${v}" is not pass, fail, revert:<ErrorName> or revert:*`);
}

function isoInstant(value, what) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(value)) {
    throw new ScheduleError(`${what} "${value}" is not an ISO 8601 UTC instant like 2026-10-06T08:00:00Z`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ScheduleError(`${what} "${value}" is not a real date`);
  return ms;
}

/** Validates one entry and returns it with parsed fields attached. Throws ScheduleError. */
export function validateEntry(e) {
  const where = `schedule entry ${JSON.stringify(e?.id ?? '?')}`;
  if (!e || typeof e !== 'object') throw new ScheduleError(`${where} is not an object`);
  if (typeof e.id !== 'string' || !e.id) throw new ScheduleError(`${where}: id must be a non-empty string`);
  const call = CALLS[e.function];
  if (!call) {
    throw new ScheduleError(`${where}: function "${e.function}" is not one of ${Object.keys(CALLS).join(', ')}`);
  }
  if (!Array.isArray(e.args)) throw new ScheduleError(`${where}: args must be an array`);
  if (e.function === 'submitShares') {
    if (e.args.length !== 1 || !Number.isInteger(e.args[0]) || e.args[0] < 1) {
      throw new ScheduleError(`${where}: submitShares takes one quarter, an integer >= 1`);
    }
  } else if (e.args.length !== 0) {
    throw new ScheduleError(`${where}: quarterlyGateCheck takes no arguments`);
  }
  if (e.gateQuarter !== undefined && e.gateQuarter !== null) {
    if (e.function !== 'quarterlyGateCheck') throw new ScheduleError(`${where}: gateQuarter applies to quarterlyGateCheck only`);
    if (!Number.isInteger(e.gateQuarter) || e.gateQuarter < 1) throw new ScheduleError(`${where}: gateQuarter must be an integer >= 1`);
  }
  const notBeforeMs = isoInstant(e.notBefore, `${where}: notBefore`);
  const notAfterMs = isoInstant(e.notAfter, `${where}: notAfter`);
  if (notAfterMs <= notBeforeMs) throw new ScheduleError(`${where}: notAfter must be after notBefore`);
  let expect;
  try {
    expect = parseExpect(e.expect);
  } catch (err) {
    throw new ScheduleError(`${where}: ${err.message}`);
  }
  if (expect.kind === 'fail' && e.function !== 'quarterlyGateCheck') {
    throw new ScheduleError(`${where}: "fail" means a gate check that lands with passed = false; submitShares has no such result`);
  }
  return {
    ...e,
    gateQuarter: e.gateQuarter ?? null,
    contract: call.contract,
    notBeforeMs,
    notAfterMs,
    expectParsed: expect,
    done: typeof e.status === 'string' && DONE_STATUSES.test(e.status.trim()),
  };
}

/** Validates a whole schedule object. Entries come back sorted by notBefore, then file order. */
export function validateSchedule(doc) {
  if (!doc || typeof doc !== 'object') throw new ScheduleError('the schedule is not a JSON object');
  if (doc.chainId !== REHEARSAL_CHAIN_ID) {
    throw new ScheduleError(`the schedule is for chain ${doc.chainId}; rehearsal mode runs on calibnet (${REHEARSAL_CHAIN_ID}) only`);
  }
  if (!Array.isArray(doc.entries)) throw new ScheduleError('the schedule has no entries array');
  const seen = new Set();
  const entries = doc.entries.map((raw, index) => {
    const e = validateEntry(raw);
    if (seen.has(e.id)) throw new ScheduleError(`schedule entry id "${e.id}" appears twice`);
    seen.add(e.id);
    return { ...e, index };
  });
  entries.sort((a, b) => a.notBeforeMs - b.notBeforeMs || a.index - b.index);
  return { ...doc, entries };
}

export function loadSchedule(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ScheduleError(`cannot read the rehearsal schedule at ${path}: ${err.code ?? err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new ScheduleError(`${path} is not valid JSON: ${err.message}`);
  }
  return validateSchedule(doc);
}

/** The label a person reads: `quarterlyGateCheck()`, `submitShares(8)`. */
export const callLabel = (e) => `${e.function}(${e.args.join(',')})`;

// ---------------------------------------------------------------------------------------------
// Building it from the runbook's CSV export
// ---------------------------------------------------------------------------------------------

/** RFC 4180: quoted fields may hold commas, doubled quotes and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon 2026-10-05 22:25" -> "2026-10-05T22:25:00Z". Returns {iso, warning} or null. */
export function parseRunbookTime(text) {
  const m = String(text ?? '').match(/(?:\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\w*\s+)?(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, day, y, mo, d, h, mi] = m;
  const iso = `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:00Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const actual = WEEKDAYS[new Date(ms).getUTCDay()];
  const warning = day && day !== actual ? `"${text}" says ${day} but ${y}-${mo}-${d} is a ${actual}` : null;
  return { iso, ms, warning };
}

const CALL_RE = /\b(SubmitShares|QuarterlyGateCheck)\s*\(\s*Q?\s*(\d+)\s*\)/gi;

/** Finds the first declared error name in `text`, as a whole word. */
function firstErrorName(text) {
  let best = null;
  for (const name of ERROR_NAMES) {
    const m = new RegExp(`\\b${name}\\b`).exec(text);
    if (m && (best === null || m.index < best.index)) best = { name, index: m.index };
  }
  return best?.name ?? null;
}

/**
 * Turns one runbook Action cell into the calls it sends.
 *
 * The cell is prose, e.g. "SubmitShares(Q8), then QuarterlyGateCheck(Q8), PASS, weight 40%".
 * Each call's own outcome is read from the text between it and the next call, so "revert" in
 * the second half of a row never attaches to the first. A second call counts only when "then"
 * introduces it; any other mention is reported for a person to look at, not sent.
 */
export function parseActionCalls(actionText, watchText = '') {
  const text = String(actionText ?? '');
  const matches = [...text.matchAll(CALL_RE)];
  const calls = [];
  const warnings = [];

  matches.forEach((m, i) => {
    const between = i === 0 ? '' : text.slice(matches[i - 1].index + matches[i - 1][0].length, m.index);
    if (i > 0 && !/\bthen\b/i.test(between)) {
      warnings.push(`"${m[0]}" is mentioned, not introduced with "then" -- not treated as a call to send`);
      return;
    }
    const segmentEnd = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const segment = text.slice(m.index + m[0].length, segmentEnd);
    const fn = m[1].toLowerCase() === 'submitshares' ? 'submitShares' : 'quarterlyGateCheck';
    const q = Number(m[2]);

    let expect;
    let note = null;
    if (/\brevert(s|ed)?\b/i.test(segment)) {
      const named = firstErrorName(segment);
      expect = named ? `revert:${named}` : null;
      if (!expect) {
        const fromWatch = firstErrorName(String(watchText ?? ''));
        expect = fromWatch ? `revert:${fromWatch}` : 'revert:*';
        note = fromWatch
          ? `revert name ${fromWatch} taken from the Watchtower validation column`
          : 'revert without a named error: any revert matches';
      }
    } else if (/\bFAIL(ED)?\b/.test(segment)) {
      expect = 'fail';
    } else if (/\b(PASS(ED)?|success(ful)?|ok)\b/i.test(segment)) {
      expect = 'pass';
    } else {
      expect = 'pass';
      note = 'no outcome stated: expecting the message to land';
    }
    calls.push({
      function: fn,
      args: fn === 'submitShares' ? [q] : [],
      gateQuarter: fn === 'quarterlyGateCheck' ? q : null,
      expect,
      note,
    });
  });

  return { calls, warnings };
}

function findColumn(header, ...names) {
  const norm = (s) => String(s).trim().toLowerCase();
  const idx = header.findIndex((h) => names.some((n) => norm(h) === norm(n)));
  return idx;
}

/**
 * Builds the schedule document from the runbook's CSV export.
 *
 * Reads only. Nothing here writes to the sheet; the caller writes the JSON file.
 */
export function buildScheduleFromCsv(csvText, { graceMinutes = 120, source = {} } = {}) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new ScheduleError('the CSV has no data rows');
  const header = rows[0];
  const col = {
    step: findColumn(header, 'Step'),
    actor: findColumn(header, 'Actor'),
    action: findColumn(header, 'Action / command', 'Action'),
    watch: findColumn(header, 'Watchtower validation'),
    opens: findColumn(header, 'Opens (UTC)'),
    closes: findColumn(header, 'Closes (UTC)'),
    status: findColumn(header, 'Status'),
  };
  for (const key of ['step', 'actor', 'action', 'opens']) {
    if (col[key] < 0) throw new ScheduleError(`the CSV header has no "${key}" column: ${header.join(' | ')}`);
  }

  const entries = [];
  const warnings = [];
  const crankerRows = [];
  for (const r of rows.slice(1)) {
    if (String(r[col.actor] ?? '').trim().toLowerCase() !== 'cranker') continue;
    crankerRows.push([col.step, col.action, col.watch, col.opens, col.closes, col.status].map((i) => (i >= 0 ? r[i] ?? '' : '')));
    const step = String(r[col.step] ?? '').trim();
    const action = String(r[col.action] ?? '').trim();
    const where = `step ${step}`;
    const opens = parseRunbookTime(r[col.opens]);
    if (!opens) {
      warnings.push(`${where}: no usable Opens (UTC) time ("${r[col.opens] ?? ''}"); skipped`);
      continue;
    }
    if (opens.warning) warnings.push(`${where}: ${opens.warning}`);
    const closes = col.closes >= 0 ? parseRunbookTime(r[col.closes]) : null;
    if (closes?.warning) warnings.push(`${where}: ${closes.warning}`);
    const closesMs = closes && closes.ms > opens.ms ? closes.ms : opens.ms + 15 * 60_000;
    const notAfter = new Date(closesMs + graceMinutes * 60_000).toISOString().replace('.000Z', 'Z');

    const { calls, warnings: callWarnings } = parseActionCalls(action, col.watch >= 0 ? r[col.watch] : '');
    for (const w of callWarnings) warnings.push(`${where}: ${w}`);
    if (calls.length === 0) {
      warnings.push(`${where}: no SubmitShares or QuarterlyGateCheck call found in "${action}"; skipped`);
      continue;
    }
    calls.forEach((c, i) => {
      if (c.note) warnings.push(`${where}${calls.length > 1 ? `.${i + 1}` : ''}: ${c.note}`);
      entries.push({
        id: calls.length > 1 ? `${step}.${i + 1}` : step,
        step: Number.isFinite(Number(step)) ? Number(step) : step,
        function: c.function,
        args: c.args,
        gateQuarter: c.gateQuarter,
        notBefore: opens.iso,
        notAfter,
        expect: c.expect,
        status: col.status >= 0 ? String(r[col.status] ?? '').trim() : '',
        source: action,
      });
    });
  }

  const doc = {
    $comment: [
      'Built by scripts/build-rehearsal-schedule.mjs from the runbook Schedule tab (Actor = Cranker).',
      'Do not edit by hand and then rebuild: rebuilding replaces the file. Review the diff like code.',
      'Rehearsal mode sends exactly these calls, each in [notBefore, notAfter), at most once. See docs/RUNBOOK.md.',
    ],
    network: 'calibnet',
    chainId: REHEARSAL_CHAIN_ID,
    // Hash of the Cranker rows only, so a note added to some other row does not mark this stale.
    source: {
      ...source,
      crankerRowsSha256: createHash('sha256').update(JSON.stringify(crankerRows)).digest('hex'),
      graceMinutes,
    },
    entries,
  };
  validateSchedule(doc); // fail the build, not the cranker
  return { doc, warnings };
}
