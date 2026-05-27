// app/web/src/lib/diaryRange.ts
//
// Diary time-range helpers: preset definitions, window computation, and
// sessionStorage persistence. Pure functions — no React, no side-effects.

export type DiaryPreset =
  | 'last24h'
  | 'today'
  | 'last7d'
  | 'last30d'
  | 'custom';

export interface DiaryRange {
  from: number; // epoch ms
  to: number;   // epoch ms
}

export interface DiaryRangeState {
  preset: DiaryPreset;
  /** Only set when preset === 'custom'. */
  custom: DiaryRange | null;
}

export interface PresetOption {
  id: DiaryPreset;
  label: string;
  emoji: string;
}

export const PRESET_OPTIONS: PresetOption[] = [
  { id: 'last24h', label: 'Last 24 hours', emoji: '⏰' },
  { id: 'today',   label: 'Today',         emoji: '📅' },
  { id: 'last7d',  label: 'Last 7 days',   emoji: '🗓️' },
  { id: 'last30d', label: 'Last 30 days',  emoji: '📆' },
  { id: 'custom',  label: 'Custom range…', emoji: '✏️' },
];

/** Returns local midnight (00:00:00.000) for the current day as epoch ms. */
function localMidnightMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Resolve a preset to a concrete { from, to } epoch-ms window. */
export function resolvePreset(preset: DiaryPreset, now: number): DiaryRange {
  switch (preset) {
    case 'last24h':
      return { from: now - 24 * 60 * 60 * 1000, to: now };
    case 'today':
      return { from: localMidnightMs(), to: now };
    case 'last7d':
      return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
    case 'last30d':
      return { from: now - 30 * 24 * 60 * 60 * 1000, to: now };
    case 'custom':
      // Callers must supply a custom range separately; this fallback mirrors
      // last24h so the query always has valid bounds even if custom is null.
      return { from: now - 24 * 60 * 60 * 1000, to: now };
  }
}

// ---------------------------------------------------------------------------
// sessionStorage persistence
// ---------------------------------------------------------------------------

const SESSION_KEY = 'hamster-cam:diary-range';

interface PersistedState {
  preset: DiaryPreset;
  customFrom: number | null;
  customTo: number | null;
}

function isValidPreset(v: unknown): v is DiaryPreset {
  return (
    v === 'last24h' ||
    v === 'today' ||
    v === 'last7d' ||
    v === 'last30d' ||
    v === 'custom'
  );
}

export function loadPersistedRange(): DiaryRangeState {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return defaultRangeState();
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return defaultRangeState();
    const obj = parsed as Record<string, unknown>;
    const preset = isValidPreset(obj['preset']) ? obj['preset'] : 'last24h';
    const customFrom =
      typeof obj['customFrom'] === 'number' ? obj['customFrom'] : null;
    const customTo =
      typeof obj['customTo'] === 'number' ? obj['customTo'] : null;
    return {
      preset,
      custom:
        preset === 'custom' && customFrom !== null && customTo !== null
          ? { from: customFrom, to: customTo }
          : null,
    };
  } catch {
    return defaultRangeState();
  }
}

export function persistRangeState(state: DiaryRangeState): void {
  try {
    const payload: PersistedState = {
      preset: state.preset,
      customFrom: state.custom?.from ?? null,
      customTo: state.custom?.to ?? null,
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch {
    // sessionStorage write errors (e.g. private browsing quota) are non-fatal.
  }
}

export function defaultRangeState(): DiaryRangeState {
  return { preset: 'last24h', custom: null };
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Convert epoch ms to a local datetime-local input value string
 * (YYYY-MM-DDTHH:MM). Used to populate native date inputs.
 */
export function epochToLocalDatetimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * Parse a datetime-local input value string back to epoch ms.
 * Returns null on invalid input.
 */
export function localDatetimeInputToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return isNaN(ms) ? null : ms;
}
