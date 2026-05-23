// app/web/src/lib/activity-style.ts
//
// Decorative palette + emoji badge for diary entries. One source of truth
// so DiaryEntry (and anything else that wants a per-activity tint later)
// doesn't carry its own switch statement.
//
// `accent`     — 4px left-stripe colour on the card.
// `badgeEmoji` — top-right badge glyph.
// `bgTint`     — low-alpha rgba wash layered over var(--surface).
//
// Colours are mid-saturation so they read in both light and dark themes
// without setting your eyes on fire. Tints land around 6% alpha — a
// watercolour hint, not a highlight.

import type { RouterOutputs } from '../trpc';

// DiaryActivity is derived from the server contract — includes all known
// activity values including 'recap' (the daily summary entry type).
export type DiaryActivity = NonNullable<RouterOutputs['activity']['today'][number]['activity']>;

export interface ActivityStyle {
  accent: string;
  badgeEmoji: string;
  bgTint: string;
}

// Hex → rgba(...) with the supplied alpha. Keeps the palette table readable.
function tint(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const TINT_ALPHA = 0.06;

// Warm amber/gold for recap cards — visually distinct, inviting, not alarming.
const RECAP_ACCENT = '#E8A020';

const PALETTE: Record<DiaryActivity, { accent: string; badgeEmoji: string }> = {
  wheel:      { accent: '#FF7AAF', badgeEmoji: '🎡' },
  food:       { accent: '#FFA94D', badgeEmoji: '🥕' },
  water:      { accent: '#4FB3E0', badgeEmoji: '💧' },
  bathroom:   { accent: '#B89AE0', badgeEmoji: '🚽' },
  resting:    { accent: '#7E70B8', badgeEmoji: '💤' },
  tunnel:     { accent: '#6B7A8F', badgeEmoji: '🕳️' },
  exploring:  { accent: '#5AA66A', badgeEmoji: '🔍' },
  hiding:     { accent: '#5C9B95', badgeEmoji: '🙈' },
  transition: { accent: '#E89BB5', badgeEmoji: '🚶' },
  snapshot:   { accent: '#F7CB36', badgeEmoji: '📸' },
  timelapse:  { accent: '#E07F8E', badgeEmoji: '📽️' },
  recap:      { accent: RECAP_ACCENT, badgeEmoji: '📖' },
};

export function activityStyle(activity: DiaryActivity | null): ActivityStyle {
  if (activity == null || !(activity in PALETTE)) {
    return {
      accent: 'var(--accent)',
      badgeEmoji: '🐾',
      bgTint: 'transparent',
    };
  }
  const entry = PALETTE[activity];
  return {
    accent: entry.accent,
    badgeEmoji: entry.badgeEmoji,
    bgTint: tint(entry.accent, TINT_ALPHA),
  };
}

// ---------------------------------------------------------------------------
// Zone vocabulary — the subset of activities operators wire up on a camera.
// `snapshot` / `timelapse` are app-generated; `transition` is computed
// across cameras. None of those are valid zone keywords, so the camera
// settings form and the scoreboard both exclude them.
// ---------------------------------------------------------------------------

export type ZoneActivity =
  | 'wheel' | 'food' | 'water' | 'bathroom'
  | 'resting' | 'tunnel' | 'exploring' | 'hiding';

export const ZONE_ACTIVITIES: readonly ZoneActivity[] = [
  'wheel', 'food', 'water', 'bathroom',
  'resting', 'tunnel', 'exploring', 'hiding',
];

export function isZoneActivity(value: string): value is ZoneActivity {
  return (ZONE_ACTIVITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Live-status line — "Where's Remy right now?"
// Maps the pet.currentStatus activity value to a kid-friendly emoji + phrase.
// The caller interpolates the pet name. When stale, pass `stale: true` and
// optionally the last-known activity + sinceMs for the fallback line.
// ---------------------------------------------------------------------------

export type LiveActivity =
  | 'wheel' | 'food' | 'water' | 'bathroom'
  | 'resting' | 'tunnel' | 'exploring' | 'hiding';

interface StatusLineOptions {
  petName: string;
  activity: LiveActivity | null;
  stale: boolean;
  sinceMs: number | null;
}

const ACTIVITY_LINES: Record<LiveActivity, { emoji: string; phrase: (pet: string) => string }> = {
  wheel:     { emoji: '🎡', phrase: (p) => `${p} is running on the wheel!` },
  food:      { emoji: '🥕', phrase: (p) => `${p} is having a snack` },
  water:     { emoji: '💧', phrase: (p) => `${p} is sipping water` },
  bathroom:  { emoji: '🚽', phrase: (p) => `${p} is using the potty` },
  resting:   { emoji: '😴', phrase: (p) => `${p} is curled up napping` },
  tunnel:    { emoji: '🌀', phrase: (p) => `${p} is exploring the tunnel` },
  exploring: { emoji: '🐹', phrase: (p) => `${p} is pottering about` },
  hiding:    { emoji: '🫣', phrase: (p) => `${p} is hiding out` },
};

/** Formats a sinceMs value into a short human label, e.g. "4 min ago". */
function formatSinceMs(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  return min === 1 ? '1 min ago' : `${min} min ago`;
}

export interface StatusLine {
  emoji: string;
  text: string;
}

export function currentStatusLine({
  petName,
  activity,
  stale,
  sinceMs,
}: StatusLineOptions): StatusLine {
  const name = petName.trim() || 'Your pet';

  if (!stale && activity !== null) {
    const entry = ACTIVITY_LINES[activity];
    return { emoji: entry.emoji, text: entry.phrase(name) };
  }

  // Stale — prefer last-known fallback when we have one.
  if (activity !== null && sinceMs !== null) {
    const entry = ACTIVITY_LINES[activity];
    const ago = formatSinceMs(sinceMs);
    return {
      emoji: entry.emoji,
      text: `${name} was last at the ${activity} · ${ago}`,
    };
  }

  // Nothing known — quiet-time fallback.
  return { emoji: '😴', text: `${name} is having quiet time` };
}

interface ZoneVocab {
  /** Display label for the camera pill (Title Case). */
  label: string;
  /** Scoreboard primary metric — counts visits vs sums durations. */
  primaryMetric: 'count' | 'duration';
  /** Scoreboard label under the big number ("MIN ON WHEEL", "SNACKS", etc). */
  unitLabel: string;
}

const ZONE_VOCAB: Record<ZoneActivity, ZoneVocab> = {
  wheel:     { label: 'Wheel',    primaryMetric: 'duration', unitLabel: 'MIN ON WHEEL' },
  food:      { label: 'Food',     primaryMetric: 'count',    unitLabel: 'SNACKS' },
  water:     { label: 'Water',    primaryMetric: 'count',    unitLabel: 'SIPS' },
  bathroom:  { label: 'Bathroom', primaryMetric: 'count',    unitLabel: 'POTTY BREAKS' },
  resting:   { label: 'Resting',  primaryMetric: 'duration', unitLabel: 'MIN RESTING' },
  tunnel:    { label: 'Tunnel',   primaryMetric: 'count',    unitLabel: 'TUNNEL TRIPS' },
  exploring: { label: 'Explore',  primaryMetric: 'count',    unitLabel: 'EXPLORES' },
  hiding:    { label: 'Hideout',  primaryMetric: 'count',    unitLabel: 'HIDE-AND-SEEKS' },
};

export function zoneLabel(activity: ZoneActivity): string {
  return ZONE_VOCAB[activity].label;
}

export function zoneMetric(activity: ZoneActivity): ZoneVocab {
  return ZONE_VOCAB[activity];
}
