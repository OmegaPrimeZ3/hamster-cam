// app/server/src/badges.ts
// The six-ish badge rules. Stage 2a wires the per-event evaluation against
// the diary + stats tables and inserts idempotently via db.earnBadge.
// PLAN §5.4 Stats & badges.

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

/** Static catalog — pure data, safe to ship at Stage 1. */
export const BADGES: Readonly<Record<BadgeId, BadgeDefinition>> = Object.freeze({
  marathon:      { id: 'marathon',      label: '🥇 Marathon Runner', description: '1+ hour on the wheel in one day' },
  foodie:        { id: 'foodie',        label: '🍽️ Foodie',          description: '10+ snack visits in one day' },
  night_owl:     { id: 'night_owl',     label: '🌙 Night Owl',       description: 'Active after 10pm' },
  early_bird:    { id: 'early_bird',    label: '🌅 Early Bird',      description: 'Active before 6am' },
  first_day:     { id: 'first_day',     label: '🎉 First Day',       description: 'Onboarded successfully' },
  memory_keeper: { id: 'memory_keeper', label: '📸 Memory Keeper',   description: 'Saved 5 snapshots' },
  hat_trick:     { id: 'hat_trick',     label: '🏆 Hat Trick',       description: '3 different activities in an hour' },
});

/**
 * Evaluate all badge rules against the current DB state and earn any newly
 * satisfied ones. Returns the badges newly earned during this call.
 */
export async function evaluateBadges(): Promise<BadgeId[]> {
  throw new Error('Stage 2a will implement badges.evaluateBadges');
}
