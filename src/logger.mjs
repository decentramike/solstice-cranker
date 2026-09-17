/**
 * Structured logging.
 *
 * Two audiences, one process: a human reading the Actions log, and the devnet server
 * parsing run records. Human lines go to stderr and the machine-readable run record
 * goes to stdout, so `node scripts/crank.mjs > run.json` yields clean JSON either way.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[process.env.CRANK_LOG_LEVEL ?? 'info'] ?? LEVELS.info;

const ESC = String.fromCharCode(27);

// GitHub renders ANSI; a log piped to a file should not carry it.
const COLOR = Boolean(process.stderr.isTTY) || process.env.GITHUB_ACTIONS === 'true';
const c = (code, s) => (COLOR ? `${ESC}[${code}m${s}${ESC}[0m` : s);

const TAG = {
  debug: c('2', 'debug'),
  info: c('36', ' info'),
  warn: c('33', ' warn'),
  error: c('31', 'error'),
};

function format(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function emit(level, message, fields) {
  if (LEVELS[level] < THRESHOLD) return;
  const extra =
    fields && Object.keys(fields).length
      ? ' ' + c('2', Object.entries(fields).map(([k, v]) => `${k}=${format(v)}`).join(' '))
      : '';
  process.stderr.write(`${TAG[level]} ${message}${extra}\n`);
}

export const log = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),

  /** A visually distinct header. The Actions log is scanned, not read. */
  section(title) {
    if (LEVELS.info < THRESHOLD) return;
    process.stderr.write(`\n${c('1', title)}\n${c('2', '-'.repeat(Math.max(title.length, 24)))}\n`);
  },
};

/** Appends a run record as NDJSON when CRANK_STATE_DIR is set. Never throws into the caller. */
export function persistRun(record) {
  const dir = process.env.CRANK_STATE_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'runs.ndjson'), JSON.stringify(record) + '\n');
  } catch (err) {
    log.warn('could not persist run record', { dir, error: err.message });
  }
}

/**
 * Appends to the GitHub Actions job summary, so a run's outcome is visible from the
 * run list without opening the log.
 */
export function writeJobSummary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, markdown + '\n');
  } catch (err) {
    log.warn('could not write job summary', { error: err.message });
  }
}
