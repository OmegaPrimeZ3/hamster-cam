// app/web/test/useNow.test.tsx
//
// Verifies that useNow ticks the returned timestamp forward every intervalMs.
// Uses vitest fake timers so the test doesn't actually wait 60 seconds.

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useNow } from '../src/hooks/useNow';
import { relativeTime } from '../src/lib/time';

// A tiny component that displays the relative time so we can assert the DOM.
function NowDisplay({ anchorMs }: { anchorMs: number }): JSX.Element {
  const now = useNow(60_000);
  return <span data-testid="ts">{relativeTime(anchorMs, now)}</span>;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useNow', () => {
  it('returns approximately Date.now() on mount', () => {
    const startMs = 1_748_000_000_000;
    vi.setSystemTime(startMs);

    // Anchor: 2 minutes ago → "2 minutes ago"
    const anchorMs = startMs - 2 * 60_000;
    render(<NowDisplay anchorMs={anchorMs} />);
    expect(screen.getByTestId('ts')).toHaveTextContent('2 minutes ago');
  });

  it('re-renders with an updated timestamp after 60 seconds', () => {
    const startMs = 1_748_000_000_000;
    vi.setSystemTime(startMs);

    // Anchor: 59 seconds ago → "just now" at t=0, "1 minute ago" at t=60s
    const anchorMs = startMs - 59_000;
    render(<NowDisplay anchorMs={anchorMs} />);

    // At mount, 59s elapsed → "just now" (< 30s threshold is 30_000; 59_000 > 30_000 → "1 minute ago")
    // Actually relativeTime rounds to max(1, round(59000/60000)) = max(1,1) = 1 → "1 minute ago"
    // but the point is that after advancing 61s the displayed relative time changes.
    const before = screen.getByTestId('ts').textContent;

    // Advance fake clock by 61 seconds — triggers the interval callback.
    act(() => {
      vi.advanceTimersByTime(61_000);
    });

    const after = screen.getByTestId('ts').textContent;
    // The timestamp must have changed (the anchor is now 120s older relative to `now`).
    expect(after).not.toBe(before);
  });

  it('cleans up the interval on unmount', () => {
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const startMs = 1_748_000_000_000;
    vi.setSystemTime(startMs);

    const anchorMs = startMs - 60_000;
    const { unmount } = render(<NowDisplay anchorMs={anchorMs} />);
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
