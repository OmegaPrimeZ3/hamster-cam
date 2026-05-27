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
  | 'hat_trick'
  | 'mile_high'
  | 'marathon_club'
  | 'ultra'
  // Daily badges added in extension
  | 'busy_bee'
  | 'hydration_hero'
  | 'sleepy_head'
  | 'globetrotter'
  // Once-ever milestones added in extension
  | 'snack_attack'
  | 'wheel_veteran'
  | 'paparazzi'
  | 'globe_runner'
  // Daily badges — second batch
  | 'wheelie'
  | 'wanderer'
  | 'hide_and_seek'
  | 'variety_pack'
  // Once-ever badges — second batch
  | 'regular'
  | 'loyal_friend'
  | 'aqua_lord'
  | 'wheel_legend';

export type BadgeRepeat = 'daily' | 'once';

export interface BadgeDefinition {
  id: BadgeId;
  /** Emoji + name shown in the popover. */
  label: string;
  description: string;
  /**
   * Earning policy.
   * - 'daily'  → earnable once per local calendar day; accumulates a count.
   * - 'once'   → earnable exactly once ever; repeat evaluations are no-ops.
   */
  repeat: BadgeRepeat;
}

/** Static catalog — pure data, single source of truth for all badge metadata. */
export const BADGES: Readonly<Record<BadgeId, BadgeDefinition>> = Object.freeze({
  // Daily badges — re-earnable once per local calendar day.
  marathon:        { id: 'marathon',        label: '🥇 Marathon Runner', description: '10+ minutes on the wheel in one day',           repeat: 'daily' },
  foodie:          { id: 'foodie',          label: '🍽️ Foodie',          description: '10+ snack visits in one day',                   repeat: 'daily' },
  night_owl:       { id: 'night_owl',       label: '🌙 Night Owl',       description: 'Active after 10pm',                             repeat: 'daily' },
  early_bird:      { id: 'early_bird',      label: '🌅 Early Bird',      description: 'Active before 6am',                             repeat: 'daily' },
  hat_trick:       { id: 'hat_trick',       label: '🏆 Hat Trick',       description: '3 different activities in an hour',             repeat: 'daily' },
  busy_bee:        { id: 'busy_bee',        label: '🐝 Busy Bee',        description: '20+ activities in one day',                     repeat: 'daily' },
  hydration_hero:  { id: 'hydration_hero',  label: '💧 Hydration Hero',  description: '5+ water visits in one day',                    repeat: 'daily' },
  sleepy_head:     { id: 'sleepy_head',     label: '😴 Sleepy Head',     description: '2+ hours resting in one day',                   repeat: 'daily' },
  globetrotter:    { id: 'globetrotter',    label: '🌍 Globetrotter',    description: 'Spotted on 2+ cameras in one day',              repeat: 'daily' },
  // Once-ever badges — awarded exactly once, idempotent thereafter.
  first_day:       { id: 'first_day',       label: '🎉 First Day',       description: 'Onboarded successfully',                        repeat: 'once'  },
  memory_keeper:   { id: 'memory_keeper',   label: '📸 Memory Keeper',   description: 'Saved 5 snapshots',                             repeat: 'once'  },
  mile_high:       { id: 'mile_high',       label: '🗺️ Mile High',        description: 'Ran 1 mile (1.609 km) total on the wheel',      repeat: 'once'  },
  marathon_club:   { id: 'marathon_club',   label: '🏅 Marathon Club',   description: 'Ran a marathon (42.195 km) total on the wheel', repeat: 'once'  },
  ultra:           { id: 'ultra',           label: '⚡ Ultra',            description: 'Ran 100 miles total on the wheel',              repeat: 'once'  },
  snack_attack:    { id: 'snack_attack',    label: '🍿 Snack Attack',    description: '100 snack visits all-time',                     repeat: 'once'  },
  wheel_veteran:   { id: 'wheel_veteran',   label: '🎢 Wheel Veteran',   description: '100 wheel runs all-time',                       repeat: 'once'  },
  paparazzi:       { id: 'paparazzi',       label: '🤳 Paparazzi',       description: '50 snapshots saved all-time',                   repeat: 'once'  },
  globe_runner:    { id: 'globe_runner',    label: '🌐 Globe Runner',    description: 'Ran 1,000 km total on the wheel',               repeat: 'once'  },
  // Daily badges — second batch
  wheelie:         { id: 'wheelie',         label: '🛞 Wheelie',         description: '5+ wheel runs in one day',                      repeat: 'daily' },
  wanderer:        { id: 'wanderer',        label: '🧭 Wanderer',        description: '5+ explore trips in one day',                   repeat: 'daily' },
  hide_and_seek:   { id: 'hide_and_seek',   label: '🙈 Hide & Seek',     description: 'Hid 3+ times in one day',                       repeat: 'daily' },
  variety_pack:    { id: 'variety_pack',    label: '🌈 Variety Pack',    description: '5+ different activities in one day',            repeat: 'daily' },
  // Once-ever badges — second batch
  regular:         { id: 'regular',         label: '📅 Regular',         description: 'Active on 7 different days',                    repeat: 'once'  },
  loyal_friend:    { id: 'loyal_friend',    label: '🐹 Loyal Friend',    description: 'Active on 30 different days',                   repeat: 'once'  },
  aqua_lord:       { id: 'aqua_lord',       label: '🚰 Aqua Lord',       description: '500 water visits all-time',                     repeat: 'once'  },
  wheel_legend:    { id: 'wheel_legend',    label: '👑 Wheel Legend',    description: '1,000 wheel runs all-time',                     repeat: 'once'  },
});

// Thresholds — named constants, never inline magic numbers.
const MARATHON_MS = 10 * 60 * 1000;           // 10 minutes wheel time
const FOODIE_VISITS = 10;                      // 10 snack visits
const NIGHT_OWL_HOUR = 22;                     // active >= 22:00
const EARLY_BIRD_HOUR = 6;                     // active <  06:00
const MEMORY_KEEPER_SNAPSHOTS = 5;             // 5 saved snapshots
const HAT_TRICK_WINDOW_MS = 60 * 60 * 1000;   // 3 distinct activities within 1h
const HAT_TRICK_DISTINCT = 3;
const BUSY_BEE_ACTIVITIES = 20;                // 20 real activities in one day
const HYDRATION_HERO_VISITS = 5;              // 5 water visits in one day
const SLEEPY_HEAD_MS = 2 * 60 * 60 * 1000;   // 2 hours resting in one day
const GLOBETROTTER_CAMERAS = 2;               // spotted on 2+ distinct cameras
const SNACK_ATTACK_COUNT = 100;               // 100 all-time food visits
const WHEEL_VETERAN_COUNT = 100;              // 100 all-time wheel runs
const PAPARAZZI_SNAPSHOTS = 50;              // 50 all-time snapshots saved
const GLOBE_RUNNER_METRES = 1_000_000;        // 1,000 km
// Thresholds — second batch
const WHEELIE_RUNS = 5;                       // 5 wheel runs in one day
const WANDERER_TRIPS = 5;                     // 5 exploring trips in one day
const HIDE_AND_SEEK_HIDES = 3;               // 3 hiding entries in one day
const VARIETY_PACK_DISTINCT = 5;             // 5 distinct real activities in one day
const REGULAR_DAYS = 7;                       // active on 7 different days all-time
const LOYAL_FRIEND_DAYS = 30;                // active on 30 different days all-time
const AQUA_LORD_COUNT = 500;                 // 500 all-time water visits
const WHEEL_LEGEND_COUNT = 1_000;            // 1,000 all-time wheel runs

// Activities excluded from "real activity" counts (hat_trick, busy_bee).
const PSEUDO_ACTIVITIES = new Set(['snapshot', 'timelapse', 'recap']);

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
    if (db.earnBadge(id, when, BADGES[id].repeat)) earned.push(id);
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
    if (e.activity === null || PSEUDO_ACTIVITIES.has(e.activity)) continue;
    const hour = new Date(e.occurred_at).getHours();
    if (hour >= NIGHT_OWL_HOUR) tryEarn('night_owl', e.occurred_at);
    if (hour < EARLY_BIRD_HOUR) tryEarn('early_bird', e.occurred_at);
  }

  // memory_keeper — at least 5 manual snapshot diary entries ever.
  // We count kind='snapshot' diary entries all-time (NOT the raw `snapshots`
  // table, which also holds auto-captured nightly frames from the
  // snapshot-capture job — those must not award this badge).
  const snapshotCount = db.countDiaryKindAllTime('snapshot');
  if (snapshotCount >= MEMORY_KEEPER_SNAPSHOTS) tryEarn('memory_keeper', now);

  // hat_trick — 3 distinct activities within any 1-hour window today.
  if (hasHatTrick(entries)) tryEarn('hat_trick', now);

  // busy_bee — 20+ real activities today (excluding pseudo-activities).
  const realActivityCount = entries.filter(
    (e) => e.activity !== null && !PSEUDO_ACTIVITIES.has(e.activity),
  ).length;
  if (realActivityCount >= BUSY_BEE_ACTIVITIES) tryEarn('busy_bee', now);

  // hydration_hero — 5+ water visits today.
  const waterVisits = entries.filter((e) => e.activity === 'water').length;
  if (waterVisits >= HYDRATION_HERO_VISITS) tryEarn('hydration_hero', now);

  // sleepy_head — 2+ hours of resting today (sum of duration_ms).
  const restingMs = entries
    .filter((e) => e.activity === 'resting')
    .reduce((sum, e) => sum + (e.duration_ms ?? 0), 0);
  if (restingMs >= SLEEPY_HEAD_MS) tryEarn('sleepy_head', now);

  // globetrotter — spotted on 2+ distinct non-null cameras today.
  const distinctCameras = new Set(
    entries.map((e) => e.camera_id).filter((id): id is number => id !== null),
  );
  if (distinctCameras.size >= GLOBETROTTER_CAMERAS) tryEarn('globetrotter', now);

  // Wheel odometer distance badges — evaluated across all time, not just today.
  const totalMetres = db.sumAllWheelMeters();
  if (totalMetres >= MILE_HIGH_METRES) tryEarn('mile_high', now);
  if (totalMetres >= MARATHON_CLUB_METRES) tryEarn('marathon_club', now);
  if (totalMetres >= ULTRA_METRES) tryEarn('ultra', now);
  if (totalMetres >= GLOBE_RUNNER_METRES) tryEarn('globe_runner', now);

  // snack_attack — 100 all-time food diary entries.
  const allTimeFoodCount = db.countDiaryActivityAllTime('food');
  if (allTimeFoodCount >= SNACK_ATTACK_COUNT) tryEarn('snack_attack', now);

  // wheel_veteran — 100 all-time wheel diary entries.
  const allTimeWheelCount = db.countDiaryActivityAllTime('wheel');
  if (allTimeWheelCount >= WHEEL_VETERAN_COUNT) tryEarn('wheel_veteran', now);

  // paparazzi — 50 all-time manual snapshots. Same source of truth as
  // memory_keeper: count kind='snapshot' diary entries, not the raw snapshots
  // table (which includes auto-captured nightly frames).
  const allTimeSnapshots = db.countDiaryKindAllTime('snapshot');
  if (allTimeSnapshots >= PAPARAZZI_SNAPSHOTS) tryEarn('paparazzi', now);

  // wheelie — 5+ wheel runs today.
  const wheelRunsToday = entries.filter((e) => e.activity === 'wheel').length;
  if (wheelRunsToday >= WHEELIE_RUNS) tryEarn('wheelie', now);

  // wanderer — 5+ exploring trips today.
  const exploringTripsToday = entries.filter((e) => e.activity === 'exploring').length;
  if (exploringTripsToday >= WANDERER_TRIPS) tryEarn('wanderer', now);

  // hide_and_seek — 3+ hiding entries today.
  const hidingToday = entries.filter((e) => e.activity === 'hiding').length;
  if (hidingToday >= HIDE_AND_SEEK_HIDES) tryEarn('hide_and_seek', now);

  // variety_pack — 5+ distinct real activity types today (excluding pseudo-activities).
  const distinctActivitiesToday = new Set(
    entries
      .map((e) => e.activity)
      .filter((a): a is NonNullable<typeof a> => a !== null && !PSEUDO_ACTIVITIES.has(a)),
  );
  if (distinctActivitiesToday.size >= VARIETY_PACK_DISTINCT) tryEarn('variety_pack', now);

  // aqua_lord — 500 all-time water visits.
  const allTimeWaterCount = db.countDiaryActivityAllTime('water');
  if (allTimeWaterCount >= AQUA_LORD_COUNT) tryEarn('aqua_lord', now);

  // wheel_legend — 1,000 all-time wheel runs.
  const allTimeWheelRunCount = db.countDiaryActivityAllTime('wheel');
  if (allTimeWheelRunCount >= WHEEL_LEGEND_COUNT) tryEarn('wheel_legend', now);

  // regular / loyal_friend — distinct local calendar days with any diary entry.
  const activeDays = db.countDistinctActiveDaysAllTime();
  if (activeDays >= REGULAR_DAYS) tryEarn('regular', now);
  if (activeDays >= LOYAL_FRIEND_DAYS) tryEarn('loyal_friend', now);

  return earned;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// Cumulative wheel-odometer thresholds (metres) — kept near usage for clarity.
const MILE_HIGH_METRES = 1609.34;     // 1 mile
const MARATHON_CLUB_METRES = 42195;   // 42.195 km (marathon)
const ULTRA_METRES = 160934;          // 100 miles

function hasHatTrick(entries: readonly db.DiaryEntryRow[]): boolean {
  // Sort by time and sweep a 1-hour window of distinct activities.
  const filtered = entries
    .filter((e) => e.activity !== null && !PSEUDO_ACTIVITIES.has(e.activity))
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
