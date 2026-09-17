import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'dark' | 'light';

const KEY = 'solstice-mission-control-theme';

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* private mode / blocked storage — fall through to system */
  }
  return 'system';
}

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

/**
 * Theme follows prefers-color-scheme by default; the toggle overrides it and the
 * override is remembered. Storage is best-effort — the page renders correctly
 * when it is unavailable.
 */
export function useTheme(): { choice: ThemeChoice; isDark: boolean; cycle: () => void } {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  const [systemDark, setSystemDark] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    apply(choice);
    try {
      if (choice === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      /* ignore */
    }
  }, [choice]);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const isDark = choice === 'dark' || (choice === 'system' && systemDark);
  const cycle = useCallback(() => {
    setChoice((c) => (c === 'system' ? (systemDark ? 'light' : 'dark') : c === 'dark' ? 'light' : 'dark'));
  }, [systemDark]);

  return { choice, isDark, cycle };
}
