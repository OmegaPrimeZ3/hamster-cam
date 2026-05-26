// app/web/test/CameraGrid.test.tsx
//
// Regression coverage for the client-side recovery gap where a *failed*
// cameras.list query was rendered identically to "loaded successfully, zero
// cameras" — flashing a scary "Let's set up your first camera!" prompt for the
// ~20-30s it took the 15s background refetch to heal (same class of bug as the
// settings flow; see memory project_web_resilience).
//
// The fix gates the skeleton on `cameras.data === undefined`, so the setup
// prompt only appears on a genuine successful empty response.

import { afterEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import { mockQuery, clearMocks } from './msw/trpc-mock';
import { CameraGrid } from '../src/components/CameraGrid';

const CAMERAS_KEY = [['cameras', 'list'], { type: 'query' }] as const;

const LIVE_SETTINGS = {
  pet_name: 'Remy',
  pet_emoji: '🐹',
  theme: 'bubblegum' as const,
  theme_mode: 'auto' as const,
  read_aloud: false,
  auto_rotate: false,
  onboarding_complete: true,
  snapshot_retention_days: 7,
  timelapse_retention_days: 30,
  audit_retention_days: 90,
  disk_warn_pct: 80,
  disk_critical_pct: 95,
  transition_window_ms: 500,
  min_dwell_ms: 2000,
  share_rate_limit_per_hour: 10,
  distance_unit: 'mi' as const,
};

describe('CameraGrid — error vs empty', () => {
  afterEach(() => clearMocks());

  it('does NOT show the "set up your first camera" prompt when the query errors', async () => {
    mockQuery('settings.get', () => LIVE_SETTINGS);

    const { queryClient } = renderWithProviders(<CameraGrid />);

    // Wait for the query to settle into the error state — `data` stays
    // undefined, which is exactly the production failure shape that used to
    // trip the false empty prompt. (The cause of the error is incidental; what
    // matters is that an errored, data-less query renders the skeleton.)
    await waitFor(() =>
      expect(queryClient.getQueryState(CAMERAS_KEY)?.status).toBe('error'),
    );

    // The skeleton (the Cameras region) stays up; the false setup prompt must
    // never render on a transient failure.
    expect(screen.getByRole('region', { name: /cameras/i })).toBeInTheDocument();
    expect(screen.queryByText(/set up your first camera/i)).toBeNull();
  });

  it('shows the setup prompt on a genuine successful empty response', async () => {
    mockQuery('settings.get', () => LIVE_SETTINGS);

    const { queryClient } = renderWithProviders(<CameraGrid />);

    // Seed a successful empty result directly. jsdom's fetch can't carry the
    // AbortSignal through to a real round-trip, so we simulate the success the
    // same way AppShell.test does. With data defined-but-empty, the grid must
    // fall through to the real "no cameras configured yet" prompt.
    act(() => {
      queryClient.setQueryData(CAMERAS_KEY, []);
    });

    expect(
      await screen.findByText(/set up your first camera/i),
    ).toBeInTheDocument();
  });
});
