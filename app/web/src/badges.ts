// app/web/src/badges.ts
//
// Single source of truth for badge metadata. Consumed by BadgesSection (the
// persistent grid on the main screen) and BadgePopover (the earn-notification
// toast). Keeping this in one module prevents the id/emoji/label drift that
// existed in the old BadgePopover BADGE_META (marathon_runner vs marathon,
// ⛰️ vs 🗺️, etc.).
//
// The canonical IDs here MUST match the badge_id values the backend emits.

export interface BadgeMeta {
  /** Canonical backend ID — must match db badge_id exactly. */
  id: string;
  emoji: string;
  label: string;
  description: string;
}

/** Aggregated badge returned by `trpc.badges.earned` (post-backend migration). */
export interface BadgeEarned {
  badge_id: string;
  count: number;
  first_earned_at: number;
  last_earned_at: number;
}

/**
 * Ordered catalog of all 26 badges. Order is canonical — BadgesSection
 * renders them in this order so the grid is stable across earn state.
 *
 * Entries 1-10: original set.
 * Entries 11-14: daily badges (batch 1).
 * Entries 15-18: cumulative badges (batch 1).
 * Entries 19-22: daily badges (batch 2).
 * Entries 23-26: cumulative badges (batch 2).
 */
export const BADGE_CATALOG: readonly BadgeMeta[] = [
  {
    id: 'marathon',
    emoji: '🥇',
    label: 'Marathon Runner',
    description: '10+ minutes on the wheel in one day',
  },
  {
    id: 'foodie',
    emoji: '🍽️',
    label: 'Foodie',
    description: '10+ snack visits in one day',
  },
  {
    id: 'night_owl',
    emoji: '🌙',
    label: 'Night Owl',
    description: 'Active after 10pm',
  },
  {
    id: 'early_bird',
    emoji: '🌅',
    label: 'Early Bird',
    description: 'Active before 6am',
  },
  {
    id: 'first_day',
    emoji: '🎉',
    label: 'First Day',
    description: 'Onboarded successfully',
  },
  {
    id: 'memory_keeper',
    emoji: '📸',
    label: 'Memory Keeper',
    description: 'Saved 5 snapshots',
  },
  {
    id: 'hat_trick',
    emoji: '🏆',
    label: 'Hat Trick',
    description: '3 different activities in an hour',
  },
  {
    id: 'mile_high',
    emoji: '🗺️',
    label: 'Mile High',
    description: 'Ran 1 mile total on the wheel',
  },
  {
    id: 'marathon_club',
    emoji: '🏅',
    label: 'Marathon Club',
    description: 'Ran a marathon total on the wheel',
  },
  {
    id: 'ultra',
    emoji: '⚡',
    label: 'Ultra',
    description: 'Ran 100 miles total on the wheel',
  },
  // --- Daily badges (new) ---
  {
    id: 'busy_bee',
    emoji: '🐝',
    label: 'Busy Bee',
    description: '20+ activities in one day',
  },
  {
    id: 'hydration_hero',
    emoji: '💧',
    label: 'Hydration Hero',
    description: '5+ water visits in one day',
  },
  {
    id: 'sleepy_head',
    emoji: '😴',
    label: 'Sleepy Head',
    description: '2+ hours resting in one day',
  },
  {
    id: 'globetrotter',
    emoji: '🌍',
    label: 'Globetrotter',
    description: 'Spotted on 2+ cameras in one day',
  },
  // --- Cumulative badges (new) ---
  {
    id: 'snack_attack',
    emoji: '🍿',
    label: 'Snack Attack',
    description: '100 snack visits all-time',
  },
  {
    id: 'wheel_veteran',
    emoji: '🎢',
    label: 'Wheel Veteran',
    description: '100 wheel runs all-time',
  },
  {
    id: 'paparazzi',
    emoji: '🤳',
    label: 'Paparazzi',
    description: '50 snapshots saved all-time',
  },
  {
    id: 'globe_runner',
    emoji: '🌐',
    label: 'Globe Runner',
    description: 'Ran 1,000 km total on the wheel',
  },
  // --- Daily badges (batch 2) ---
  {
    id: 'wheelie',
    emoji: '🛞',
    label: 'Wheelie',
    description: '5+ wheel runs in one day',
  },
  {
    id: 'wanderer',
    emoji: '🧭',
    label: 'Wanderer',
    description: '5+ explore trips in one day',
  },
  {
    id: 'hide_and_seek',
    emoji: '🙈',
    label: 'Hide & Seek',
    description: 'Hid 3+ times in one day',
  },
  {
    id: 'variety_pack',
    emoji: '🌈',
    label: 'Variety Pack',
    description: '5+ different activities in one day',
  },
  // --- Cumulative badges (batch 2) ---
  {
    id: 'regular',
    emoji: '📅',
    label: 'Regular',
    description: 'Active on 7 different days',
  },
  {
    id: 'loyal_friend',
    emoji: '🐹',
    label: 'Loyal Friend',
    description: 'Active on 30 different days',
  },
  {
    id: 'aqua_lord',
    emoji: '🚰',
    label: 'Aqua Lord',
    description: '500 water visits all-time',
  },
  {
    id: 'wheel_legend',
    emoji: '👑',
    label: 'Wheel Legend',
    description: '1,000 wheel runs all-time',
  },
] as const;

/** Look up badge metadata by id. Returns undefined for unknown ids. */
export function badgeMeta(id: string): BadgeMeta | undefined {
  return BADGE_CATALOG.find((b) => b.id === id);
}
