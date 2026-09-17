import type { Tone } from '../lib/derive';

/**
 * Status glyphs. Each tone has its own SHAPE, not only its own colour: an
 * octagon for critical, a triangle for warning, a circle for everything else.
 * That is what keeps the critical state readable on a projector and for
 * colour-blind viewers.
 */
export function StatusGlyph({ tone, size = 14 }: { tone: Tone; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-hidden': true,
    focusable: false as const,
    style: { display: 'block', flex: 'none' },
  };

  if (tone === 'crit') {
    return (
      <svg {...common}>
        <path
          d="M5.2 1h5.6L15 5.2v5.6L10.8 15H5.2L1 10.8V5.2z"
          fill="var(--crit)"
          stroke="var(--crit)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <path
          d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"
          stroke="var(--crit-ink)"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (tone === 'warn') {
    return (
      <svg {...common}>
        <path
          d="M8 1.4l6.4 12.2H1.6z"
          fill="var(--warn-wash)"
          stroke="var(--warn)"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M8 6v3.4" stroke="var(--warn)" strokeWidth="1.7" strokeLinecap="round" />
        <circle cx="8" cy="11.7" r="0.95" fill="var(--warn)" />
      </svg>
    );
  }

  if (tone === 'ok') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--ok)" strokeWidth="1.4" />
        <path
          d="M4.9 8.2l2.1 2.1 4.1-4.5"
          fill="none"
          stroke="var(--ok)"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (tone === 'accent') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--accent)" strokeWidth="1.4" />
        <circle cx="8" cy="8" r="3" fill="var(--accent)" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--text-3)" strokeWidth="1.3" />
      <path d="M5 8h6" stroke="var(--text-3)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ClockIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 4.2V8.3l2.7 1.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SunMoonIcon({ dark, size = 15 }: { dark: boolean; size?: number }) {
  return dark ? (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        d="M13.4 10.3A5.8 5.8 0 0 1 5.7 2.6a5.9 5.9 0 1 0 7.7 7.7z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 .9v1.9M8 13.2v1.9M.9 8h1.9M13.2 8h1.9M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M13.1 2.9l-1.4 1.4M4.3 11.7l-1.4 1.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PauseIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <rect x="3.5" y="2.5" width="3.4" height="11" rx="0.8" fill="currentColor" />
      <rect x="9.1" y="2.5" width="3.4" height="11" rx="0.8" fill="currentColor" />
    </svg>
  );
}

export function PlayIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M4 2.6l9 5.4-9 5.4z" fill="currentColor" />
    </svg>
  );
}
