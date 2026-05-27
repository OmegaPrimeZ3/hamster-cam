// app/web/src/lib/tts.ts
//
// Browser Web Speech API helpers. Pure functions — no React, no state.
// Single-channel: calling speak() cancels any in-progress utterance so voices
// never overlap. Strips the leading badge emoji before speaking and picks the
// most natural English voice the device offers.

export function isTTSAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window
  );
}

// Narrative templates start with an emoji (e.g. "🥕 {pet} had a snack!"). The
// circle badge already shows that glyph, so we strip it both from the visible
// header (avoids a double-icon) and from the spoken text (otherwise the synth
// reads it aloud as "carrot"). Handles VS16 (U+FE0F) / ZWJ (U+200D) joiners
// used by composed emoji like 🕳️ and 🗺️.
const LEADING_EMOJI = /^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*\s*/u;
export function stripLeadingEmoji(text: string): string {
  return text.replace(LEADING_EMOJI, '');
}

// Voice naturalness ranking. We can only choose among voices already installed
// on the device — the Web Speech API can't bundle one. The biggest quality
// lever is the user installing an OS "Enhanced"/"Premium" voice (macOS/iOS:
// Settings → Accessibility → Spoken Content → System Voice → manage voices).
// These hints score those high-quality variants — and a few pleasant defaults —
// above the robotic compact voice a device ships with.
const HQ_VARIANT = /enhanced|premium|neural|natural/i; // downloadable HD voices
const SIRI_VOICE = /siri/i;
const NICE_NAME = /samantha|ava|allison|zoe|nicky|aaron|google us english/i;

function scoreVoice(v: SpeechSynthesisVoice): number {
  let s = 0;
  if (HQ_VARIANT.test(v.name)) s += 100; // an installed HD variant — best win
  if (SIRI_VOICE.test(v.name)) s += 60;
  if (NICE_NAME.test(v.name)) s += 20;
  if (/^en-US/i.test(v.lang)) s += 5;
  else if (/^en/i.test(v.lang)) s += 3;
  if (v.default) s += 1;
  return s;
}

/** Pick the highest-scoring English voice, or undefined to use the browser default. */
function pickVoice(): SpeechSynthesisVoice | undefined {
  // getVoices() can be empty on first call (it loads async); callers fire on
  // user interaction by which point it's populated. Empty → browser default.
  const english = window.speechSynthesis
    .getVoices()
    .filter((v) => v.lang.startsWith('en'));
  if (english.length === 0) return undefined;
  return english.reduce((best, v) => (scoreVoice(v) > scoreVoice(best) ? v : best));
}

/**
 * Speak `text` aloud. Cancels any current utterance first (single-channel).
 * Strips the leading badge emoji so it isn't narrated. Returns a cancel
 * function that immediately stops playback.
 */
export function speak(
  text: string,
  opts?: { onEnd?: () => void },
): () => void {
  if (!isTTSAvailable()) return () => {};

  // Cancel any in-progress utterance before starting a new one.
  window.speechSynthesis.cancel();

  const utt = new SpeechSynthesisUtterance(stripLeadingEmoji(text));
  utt.rate = 0.95;
  utt.pitch = 1.05;

  const voice = pickVoice();
  if (voice) utt.voice = voice;

  if (opts?.onEnd) {
    utt.onend = opts.onEnd;
  }

  window.speechSynthesis.speak(utt);

  return () => {
    window.speechSynthesis.cancel();
  };
}
