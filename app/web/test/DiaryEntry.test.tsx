// app/web/test/DiaryEntry.test.tsx
//
// Renders the three variants and verifies the right DOM lands for each.

import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { DiaryEntry } from '../src/components/DiaryEntry';
import type { RouterOutputs } from '../src/trpc';
import { renderWithProviders } from './test-utils';

type Entry = RouterOutputs['activity']['today'][number];

function makeEntry(overrides: Partial<Entry>): Entry {
  return {
    id: 1,
    occurred_at: Date.now() - 60_000,
    kind: 'narrative',
    activity: 'wheel',
    narrative: '🎡 Peanut went for a run on the wheel — 8 min!',
    pet_name: 'Peanut',
    camera_id: 1,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: 8 * 60 * 1000,
    snapshot_id: null,
    media_path: null,
    ...overrides,
  };
}

describe('DiaryEntry', () => {
  it('narrative variant renders the sentence and relative time', () => {
    const entry = makeEntry({ kind: 'narrative' });
    renderWithProviders(<DiaryEntry entry={entry} now={entry.occurred_at + 60_000} />);
    expect(screen.getByText(/peanut went for a run/i)).toBeInTheDocument();
    expect(screen.getByText(/minute ago/i)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /snapshot/i })).toBeNull();
  });

  it('snapshot variant renders an expandable image', () => {
    const entry = makeEntry({
      kind: 'snapshot',
      activity: 'snapshot',
      narrative: '📸 You saved a memory of Peanut!',
      media_path: '/snapshots/test.jpg',
    });
    renderWithProviders(<DiaryEntry entry={entry} now={entry.occurred_at + 60_000} />);
    const img = screen.getByAltText('📸 You saved a memory of Peanut!');
    expect(img).toBeInTheDocument();
    expect(img.tagName).toBe('IMG');
  });

  it('timelapse variant renders an inline <video> with playsinline', () => {
    const entry = makeEntry({
      kind: 'timelapse',
      activity: 'timelapse',
      narrative: "📽️ Peanut's Day 2026-05-19",
      media_path: '/timelapse/2026-05-19.mp4',
    });
    const { container } = renderWithProviders(<DiaryEntry entry={entry} now={entry.occurred_at + 60_000} />);
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('playsinline') ?? video?.getAttribute('playsInline')).not.toBeNull();
    expect(video?.getAttribute('preload')).toBe('metadata');
  });
});
