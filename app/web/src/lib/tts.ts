// app/web/src/lib/tts.ts
//
// Browser Web Speech API helpers. Pure functions — no React, no state.
// Single-channel: calling speak() cancels any in-progress utterance so voices
// never overlap. Picks a child-friendly voice when available.

export function isTTSAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window
  );
}

/**
 * Speak `text` aloud. Cancels any current utterance first (single-channel).
 * Returns a cancel function that immediately stops playback.
 *
 * Voice selection: prefer an English voice whose name matches 'child', 'kid',
 * 'samantha', or 'google us english' (case-insensitive). Falls back to the
 * browser default when none match.
 */
export function speak(
  text: string,
  opts?: { onEnd?: () => void },
): () => void {
  if (!isTTSAvailable()) return () => {};

  // Cancel any in-progress utterance before starting a new one.
  window.speechSynthesis.cancel();

  const utt = new SpeechSynthesisUtterance(text);
  utt.rate = 0.95;
  utt.pitch = 1.05;

  // Voice selection — best-effort. getVoices() can be empty on first call
  // in some browsers (it loads async); we fall back to the default voice if
  // the list is empty or no match is found.
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    const CHILD_FRIENDLY = /child|kid|samantha|google us english/i;
    const preferred = voices.find(
      (v) => v.lang.startsWith('en') && CHILD_FRIENDLY.test(v.name),
    );
    if (preferred) {
      utt.voice = preferred;
    } else {
      // Fallback: any English voice.
      const anyEn = voices.find((v) => v.lang.startsWith('en'));
      if (anyEn) utt.voice = anyEn;
    }
  }

  if (opts?.onEnd) {
    utt.onend = opts.onEnd;
  }

  window.speechSynthesis.speak(utt);

  return () => {
    window.speechSynthesis.cancel();
  };
}
