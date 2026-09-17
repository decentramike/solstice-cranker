/**
 * Display formatting.
 *
 * Amounts arrive from the API as decimal strings and are formatted as strings.
 * Nothing in this file calls Number(), parseFloat() or toFixed() on a value that
 * came off the wire as an amount — a FIL balance can carry 18 fractional digits,
 * which is past the point where a double stops being able to represent it.
 */

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d*))?$/;

export interface DecimalFormatOptions {
  /** Fractional digits to keep. Extra digits are truncated, never rounded. */
  maxFractionDigits?: number;
  /** Fractional digits to pad out to with zeroes. */
  minFractionDigits?: number;
  /** Group the integer part in threes. Default true. */
  group?: boolean;
}

/**
 * Format a decimal string for display. Purely string surgery.
 * An unparseable value is passed through untouched rather than mangled.
 */
export function formatDecimal(value: string | null | undefined, opts: DecimalFormatOptions = {}): string {
  if (value === null || value === undefined) return '—';
  const raw = String(value).trim();
  const m = DECIMAL_RE.exec(raw);
  if (!m) return raw;

  const sign = m[1] === '-' ? '-' : '';
  let intPart = m[2].replace(/^0+(?=\d)/, '');
  let fracPart = m[3] ?? '';

  const { maxFractionDigits, minFractionDigits = 0, group = true } = opts;
  if (maxFractionDigits !== undefined && fracPart.length > maxFractionDigits) {
    fracPart = fracPart.slice(0, maxFractionDigits);
  }
  if (fracPart.length < minFractionDigits) {
    fracPart = fracPart.padEnd(minFractionDigits, '0');
  }
  // Drop a fraction that truncated away to nothing, unless a minimum was asked for.
  if (minFractionDigits === 0) fracPart = fracPart.replace(/0+$/, '');

  if (group) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return sign + intPart + (fracPart ? '.' + fracPart : '');
}

/** "9998.4207318452" -> "9,998.4207" */
export function formatFil(value: string | null | undefined): string {
  return formatDecimal(value, { maxFractionDigits: 4 });
}

/** "18420.75" -> "$18,420.75" */
export function formatUsd(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const body = formatDecimal(value, { maxFractionDigits: 2, minFractionDigits: 2 });
  return body.startsWith('-') ? '-$' + body.slice(1) : '$' + body;
}

/** Integers that are genuinely numbers in the contract (epochs, gas, counts). */
export function formatInt(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return formatDecimal(value, { maxFractionDigits: 0 });
  if (!Number.isFinite(value)) return '—';
  return Math.trunc(value).toLocaleString('en-US');
}

/** Always signed, for margins. */
export function formatSignedInt(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const n = Math.trunc(value);
  return (n > 0 ? '+' : '') + n.toLocaleString('en-US');
}

export function shortAddress(addr: string | null | undefined): string {
  if (!addr) return '—';
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

/**
 * Epoch count -> wall-clock duration at the chain's epoch length.
 * 240 epochs at 30s -> "2h 00m".
 */
export function formatEpochDuration(epochs: number, epochSeconds: number): string {
  if (!Number.isFinite(epochs) || !Number.isFinite(epochSeconds)) return '—';
  const sign = epochs < 0 ? '-' : '';
  const total = Math.abs(Math.trunc(epochs)) * epochSeconds;
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);

  if (d > 0) return `${sign}${d}d ${String(h).padStart(2, '0')}h`;
  if (h > 0) return `${sign}${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${sign}${m}m ${String(s).padStart(2, '0')}s`;
  return `${sign}${s}s`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Truncate a long hex blob for a cell, keeping it obviously hex. */
export function truncateHex(hex: string | null | undefined, keep = 18): string {
  if (!hex) return '—';
  return hex.length <= keep + 1 ? hex : `${hex.slice(0, keep)}…`;
}

/** FRC-42 method numbers are large; show them grouped so they are comparable at a glance. */
export function formatMethodNumber(method: number | null | undefined): string {
  if (method === null || method === undefined || !Number.isFinite(method)) return '—';
  return Math.trunc(method).toLocaleString('en-US');
}
