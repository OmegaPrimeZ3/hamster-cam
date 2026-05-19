// app/server/src/badges.ts
// Badge rules + idempotent earning. PLAN §5.4 Stats & badges.

import * as db from './db.js';

export type BadgeId =
  | 'marathon'
  | 'foodie'
  | 'night_owl'
  | 'early_bird'
  | 'first_day'
  | 'memory_keeper'
  | 'hat_trick';

export interface BadgeDefinition {
  id: BadgeId;
  /** Emoji + name shown in the popover. */
  label: string;
  description: string;
}

/** Static catalog — pure data. */
export const BADGES: Readonly<Record<BadgeId, BadgeDefinition>> = Object.freeze({
  marathon:      { id: 'marathon',      label: '🥇 Marathon Runner', description: '1+ hour on the wheel in one day' },
  foodie:        { id: 'foodie',        label: '🍽️ Foodie',          description: '10+ snack visits in one day' },
  night_owl:     { id: 'night_owl',     label: '🌙 Night Owl',       description: 'Active after 10pm' },
  early_bird:    { id: 'early_bird',    label: '🌅 Early Bird',      description: 'Active before 6am' },
  first_day:     { id: 'first_day',     label: '🎉 First Day',       description: 'Onboarded successfully' },
  memory_keeper: { id: 'memory_keeper', label: '📸 Memory Keeper',   description: 'Saved 5 snapshots' },
  hat_trick:     { id: 'hat_trick',     label: '🏆 Hat Trick',       description: '3 different activities in an hour' },
});

const MARATHON_MS = 60 * 60 * 1000;       // 1 hour wheel time
const FOODIE_VISITS = 10;                 // 10 snack visits
const NIGHT_OWL_HOUR = 22;                // active >= 22:00
const EARLY_BIRD_HOUR = 6;                // active <  06:00
const MEMORY_KEEPER_SNAPSHOTS = 5;        // 5 saved snapshots
const HAT_TRICK_WINDOW_MS = 60 * 60 * 1000; // 3 distinct activities within 1h
const HAT_TRICK_DISTINCT = 3;

export interface BadgeEvaluationOptions {
  /** Override "now" — primarily for tests; defaults to Date.now(). */
  now?: number;
}

/**
 * Evaluate all badge rules against the current DB state and earn any newly
 * satisfied ones. Returns the badges newly earned during this call. Safe to
 * call after every diary insert — the underlying `INSERT OR IGNORE` makes
 * each earn idempotent at the row level.
 */
export async function evaluateBadges(
  opts: BadgeEvaluationOptions = {},
): Promise<BadgeId[]> {
  const now = opts.now ?? Date.now();
  const todayStart = startOfLocalDay(new Date(now));
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  const entries = db.listDiaryEntriesBetween(todayStart, todayEnd);

  const earned: BadgeId[] = [];
  const tryEarn = (id: BadgeId, when: number): void => {
    if (db.earnBadge(id, when)) earned.push(id);
  };

  // first_day — settings.onboarding_complete flips → award immediately.
  if (db.getSetting('onboarding_complete') === 'true') {
    tryEarn('first_day', now);
  }

  // marathon — sum of wheel durations today.
  const wheelMs = entries
    .filter((e) => e.activity === 'wheel')
    .reduce((sum, e) => sum + (e.duration_ms ?? 0), 0);
  if (wheelMs >= MARATHON_MS) tryEarn('marathon', now);

  // foodie — count of food entries today.
  const foodVisits = entries.filter((e) => e.activity === 'food').length;
  if (foodVisits >= FOODIE_VISITS) tryEarn('foodie', now);

  // night_owl / early_bird — any activity in the night/dawn window.
  for (const e of entries) {
    if (e.activity === 'snapshot' || e.activity === 'timelapse') continue;
    const hour = new Date(e.occurred_at).getHours();
    if (hour >= NIGHT_OWL_HOUR) tryEarn('night_owl', e.occurred_at);
    if (hour < EARLY_BIRD_HOUR) tryEarn('early_bird', e.occurred_at);
  }

  // memory_keeper — at least 5 snapshot rows ever.
  const snapshotCount = entries.filter((e) => e.kind === 'snapshot').length
    + countAllSnapshotEntriesIfHistoric();
  if (snapshotCount >= MEMORY_KEEPER_SNAPSHOTS) tryEarn('memory_keeper', now);

  // hat_trick — 3 distinct activities within any 1-hour window today.
  if (hasHatTrick(entries)) tryEarn('hat_trick', now);

  return earned;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function countAllSnapshotEntriesIfHistoric(): number {
  // Snapshots earned on previous days also count toward "5 ever saved". We
  // ask the DB rather than scanning everything: a single COUNT(*) over the
  // snapshots table is the simplest signal.
  return db
    .listSnapshotsBetween(0, Number.MAX_SAFE_INTEGER)
    .length;
}

function hasHatTrick(entries: readonly db.DiaryEntryRow[]): boolean {
  // Sort by time and sweep a 1-hour window of distinct activities.
  const filtered = entries
    .filter((e) => e.activity !== null && e.activity !== 'snapshot' && e.activity !== 'timelapse')
    .slice()
    .sort((a, b) => a.occurred_at - b.occurred_at);

  for (let i = 0; i < filtered.length; i += 1) {
    const windowEnd = (filtered[i]?.occurred_at ?? 0) + HAT_TRICK_WINDOW_MS;
    const set = new Set<string>();
    for (let j = i; j < filtered.length; j += 1) {
      const e = filtered[j];
      if (!e || e.occurred_at > windowEnd) break;
      if (e.activity) set.add(e.activity);
      if (set.size >= HAT_TRICK_DISTINCT) return true;
    }
  }
  return false;
}

function startOfLocalDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}
