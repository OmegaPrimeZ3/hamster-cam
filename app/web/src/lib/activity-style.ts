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
