// app/web/test/CameraTile.test.tsx
//
// Exercises the per-tile state machine purely through props (no msw needed).
// State derives entirely from `last_frame_at` vs `now`.

import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { CameraTile, tileStateFor } from '../src/components/CameraTile';
import type { RouterOutputs } from '../src/trpc';
import { renderWithProviders } from './test-utils';

type CameraDTO = RouterOutputs['cameras']['list'][number];

function makeCamera(lastFrameAt: number | null): CameraDTO {
  return {
    id: 1,
    name: 'Wheel Cam',
    emoji: '🎡',
    stream_url: 'http://localhost/stream/1',
    position: 0,
    enabled: true,
    created_at: 0,
    zones: [],
    wheel_mark_enabled: false,
    wheel_diameter_mm: 152,
    wheel_band_y_pct: 50,
    wheel_band_height_pct: 10,
    wheel_threshold_pct: 50,
    last_frame_at: lastFrameAt,
  };
}

describe('CameraTile.tileStateFor', () => {
  const NOW = 1_700_000_000_000;
  it('returns loading when last_frame_at is null', () => {
    expect(tileStateFor(null, NOW)).toBe('loading');
  });
  it('returns live when a frame arrived within 30s', () => {
    expect(tileStateFor(NOW - 5_000, NOW)).toBe('live');
    expect(tileStateFor(NOW - 29_999, NOW)).toBe('live');
  });
  it('returns napping between 30s and 5min', () => {
    expect(tileStateFor(NOW - 30_000, NOW)).toBe('napping');
    expect(tileStateFor(NOW - 4 * 60_000, NOW)).toBe('napping');
  });
  it('returns offline after 5 minutes', () => {
    expect(tileStateFor(NOW - 5 * 60_000, NOW)).toBe('offline');
    expect(tileStateFor(NOW - 60 * 60_000, NOW)).toBe('offline');
  });
});

describe('CameraTile UI', () => {
  it('napping state renders the friendly nap copy', () => {
    const now = Date.now();
    const cam = makeCamera(now - 60_000);
    renderWithProviders(
      <CameraTile
        camera={cam}
        petName="Peanut"
        petEmoji="🐹"
        isAdmin={false}
        onMaximize={() => {}}
        now={now}
      />,
    );
    expect(screen.getByText(/taking a nap/i)).toBeInTheDocument();
  });

  it('offline state renders the deep-sleep copy', () => {
    const now = Date.now();
    const cam = makeCamera(now - 10 * 60_000);
    renderWithProviders(
      <CameraTile
        camera={cam}
        petName="Peanut"
        petEmoji="🐹"
        isAdmin={false}
        onMaximize={() => {}}
        now={now}
      />,
    );
    expect(screen.getByText(/deep sleep/i)).toBeInTheDocument();
  });

  it('loading state shows "Looking for {pet}..."', () => {
    const cam = makeCamera(null);
    renderWithProviders(
      <CameraTile
        camera={cam}
        petName="Peanut"
        petEmoji="🐹"
        isAdmin={false}
        onMaximize={() => {}}
        now={Date.now()}
      />,
    );
    expect(screen.getByText(/looking for peanut/i)).toBeInTheDocument();
  });
});
