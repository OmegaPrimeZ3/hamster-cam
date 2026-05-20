// app/server/src/narratives.ts
// Pure template strings — no I/O, no SDK calls. The narrator that picks
// from these templates lives in narrator.ts.
//
// PLAN §5.4 Diary.

export type NarrativeKey =
  | 'wheel'
  | 'food'
  | 'water'
  | 'bathroom'
  | 'resting'
  | 'exploring'
  | 'hiding'
  | 'snapshot'
  | 'transition'
  | 'timelapse';

/**
 * Rotated randomly inside narrator.ts so the feed never feels repetitive.
 * Placeholders: `{pet}` always; `{duration}` for activities with a span;
 * `{from}`/`{to}` for transitions; `{date}` for the timelapse card.
 */
export const narratives: Readonly<Record<NarrativeKey, readonly string[]>> = Object.freeze({
  wheel: [
    '🎡 {pet} went for a run on the wheel — {duration}!',
    '🏃 {pet} is zooming on the wheel!',
    '💨 Wheel time! {pet} clocked {duration}.',
  ],
  food: [
    '🥕 {pet} had a snack!',
    '😋 {pet} stopped by the food bowl.',
    '🍴 Dinner time for {pet}!',
  ],
  water: [
    '💧 {pet} took a sip of water.',
    '🚰 Stayed hydrated! Good {pet}.',
  ],
  bathroom: [
    '🚽 {pet} popped into the bathroom corner.',
    '🧻 {pet} took a potty break.',
    '💩 {pet} did their business — clean cage soon!',
  ],
  resting: [
    '💤 {pet} is napping — shhh!',
    '😴 Cozy snooze time for {pet}.',
  ],
  exploring: [
    '🔍 {pet} is exploring the cage!',
    '🗺️ Adventure time for {pet}!',
  ],
  hiding: [
    '🙈 Where did {pet} go? Hide and seek!',
    "🕵️ {pet} is being sneaky...",
  ],
  snapshot: ['📸 You saved a memory of {pet}!'],
  transition: [
    '🚶 {pet} wandered from the {from} to the {to}.',
    '🐾 {pet} took a stroll: {from} → {to}.',
    '🔀 {pet} hopped over from the {from} to the {to}.',
  ],
  timelapse: ["📽️ {pet}'s Day {date}"],
});

/** Picks a deterministic-ish template — random by default but injectable for tests. */
export function pickTemplate(
  key: NarrativeKey,
  rng: () => number = Math.random,
): string {
  const choices = narratives[key];
  const idx = Math.min(Math.floor(rng() * choices.length), choices.length - 1);
  const tpl = choices[idx];
  // narratives is non-empty by construction; defensive fallback satisfies the
  // strict noUncheckedIndexedAccess type without an `!`.
  return tpl ?? choices[0] ?? '';
}

/**
 * Fill a template with the provided values. Unknown placeholders are left as
 * literal `{name}` so missing data is loud rather than silent.
 */
export function render(
  template: string,
  vars: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}
