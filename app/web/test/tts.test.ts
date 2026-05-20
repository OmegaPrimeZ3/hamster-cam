// app/web/test/tts.test.ts
//
// Tests for the TTS helper module (isTTSAvailable, speak).
//
// Note: setup.ts stubs window.speechSynthesis (with speak, cancel, getVoices)
// and window.SpeechSynthesisUtterance so these tests run in jsdom.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isTTSAvailable, speak } from '../src/lib/tts';

describe('isTTSAvailable', () => {
  it('returns true when both speechSynthesis and SpeechSynthesisUtterance are present', () => {
    // setup.ts stubs both — the check should succeed.
    expect(isTTSAvailable()).toBe(true);
  });
});

describe('speak', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls speechSynthesis.cancel before speak to enforce single-channel', () => {
    const cancel = vi.spyOn(window.speechSynthesis, 'cancel');
    const speakFn = vi.spyOn(window.speechSynthesis, 'speak');

    speak('Hello, hamster!');

    // cancel must come first (enforces single-channel — no overlapping voices).
    expect(cancel).toHaveBeenCalledOnce();
    expect(speakFn).toHaveBeenCalledOnce();
  });

  it('returns a cancel function that stops synthesis', () => {
    const cancel = vi.spyOn(window.speechSynthesis, 'cancel');
    const cancelFn = speak('Testing cancel');

    // Call the returned cancel function.
    cancelFn();

    // Expect two calls: one pre-speech cancel + one explicit cancel.
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('sets rate=0.95 and pitch=1.05 on the utterance for storybook feel', () => {
    let capturedUtt: SpeechSynthesisUtterance | null = null;
    vi.spyOn(window.speechSynthesis, 'speak').mockImplementation((utt) => {
      capturedUtt = utt;
    });

    speak('Rate and pitch test');

    expect(capturedUtt).not.toBeNull();
    expect((capturedUtt as unknown as SpeechSynthesisUtterance).rate).toBe(0.95);
    expect((capturedUtt as unknown as SpeechSynthesisUtterance).pitch).toBe(1.05);
  });

  it('calls onEnd callback when the utterance fires onend', () => {
    vi.spyOn(window.speechSynthesis, 'speak').mockImplementation((utt) => {
      // Simulate the browser firing onend immediately.
      if (utt.onend) {
        utt.onend(new Event('end') as SpeechSynthesisEvent);
      }
    });

    const onEnd = vi.fn();
    speak('End callback test', { onEnd });

    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('handles getVoices returning an empty array without throwing', () => {
    vi.spyOn(window.speechSynthesis, 'getVoices').mockReturnValue([]);
    const speakFn = vi.spyOn(window.speechSynthesis, 'speak');

    expect(() => speak('Empty voices')).not.toThrow();
    expect(speakFn).toHaveBeenCalledOnce();
  });
});
