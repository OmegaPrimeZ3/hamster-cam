// app/web/test/AppShell.test.tsx
//
// Verifies the post-login loading splash in AppShell:
//
//   1. While settings.get is still loading (and the 8-second timeout hasn't
//      fired), the loading splash renders with the pet name from the brand
//      cache and no main app content.
//   2. Once settings.get resolves (pre-seeded into the QueryClient cache),
//      the splash disappears and the real app (Header h1) renders.
//   3. The safety timeout: if settings.get never resolves, the splash gives
//      up after the timeout and renders the real app anyway.
//
// Technique: pre-seed the React Query cache directly (same approach as
// Header.test.tsx) so we can control settings.get state without a network
// round-trip. The tRPC key for settings.get is [['settings','get'],{type:'query'}].

import { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse, server } from './msw/server';
import { mockQuery } from './msw/trpc-mock';
import { trpc, makeTrpcClient } from '../src/trpc';
import { AppShell } from '../src/App';
import { BRAND_CACHE_KEY } from '../src/lib/brandCache';

// Minimal settings shape satisfying the tRPC output type.
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

const AUTHED_USER = {
  id: 1,
  email: 'admin@example.com',
  display_name: 'Admin',
  role: 'admin' as const,
};

// Builds a wrapper with a pre-seeded QueryClient.
// Pass `seedSettings: true` to have settings.get resolve immediately.
function makeWrapper(opts: {
  seedSettings?: boolean;
}): { Wrapper: ({ children }: { children: ReactNode }) => JSX.Element; queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });

  // Always seed auth so AppShell's useAuth hook sees an admin user.
  queryClient.setQueryData(['auth', 'me'], { user: AUTHED_USER });

  if (opts.seedSettings) {
    queryClient.setQueryData([['settings', 'get'], { type: 'query' }], LIVE_SETTINGS);
    // Pre-seed all child component queries so the real app can render without
    // network calls hitting the unregistered-mock error.
    queryClient.setQueryData([['cameras', 'list'], { type: 'query' }], []);
    queryClient.setQueryData([['activity', 'today'], { type: 'query' }], []);
    queryClient.setQueryData([['activity', 'range'], { type: 'query' }], []);
    queryClient.setQueryData([['stats', 'today'], { type: 'query' }], { zones: [] });
    queryClient.setQueryData([['stats', 'wheelRecords'], { type: 'query' }], {
      todayMeters: 0,
      weekMeters: 0,
      allTimeMeters: 0,
      bestDayMeters: 0,
      bestDayDate: null,
      bestSessionMeters: 0,
      dailySeries: [],
    });
    queryClient.setQueryData([['pet', 'currentStatus'], { type: 'query' }], {
      activity: null,
      zone: null,
      cameraId: null,
      sinceMs: null,
      stale: true,
    });
    queryClient.setQueryData([['badges', 'earned'], { type: 'query' }], []);
  }

  const trpcClient = makeTrpcClient();

  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            {children}
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    );
  }

  return { Wrapper, queryClient };
}

describe('AppShell — post-login loading splash', () => {
  beforeEach(() => {
    localStorage.clear();
    server.use(
      http.get('/auth/me', () =>
        HttpResponse.json({ user: AUTHED_USER }, { status: 200 }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the loading splash while settings.get is pending', () => {
    // settings.get is NOT pre-seeded. With retry:false the query will fire and
    // fail (no mock registered), but settings.isLoading is true synchronously
    // on first render before the async request resolves. We assert the
    // synchronous first paint shows the splash.
    const { Wrapper } = makeWrapper({ seedSettings: false });

    render(<AppShell />, { wrapper: Wrapper });

    // Loading splash renders on first paint (settings not yet loaded).
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/getting your camera ready/i)).toBeInTheDocument();

    // The real app (Header h1) should NOT be present.
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('shows the pet name in the splash when the brand cache is populated', () => {
    localStorage.setItem(
      BRAND_CACHE_KEY,
      JSON.stringify({ petName: 'Remy', petEmoji: '🐹' }),
    );

    const { Wrapper } = makeWrapper({ seedSettings: false });

    render(<AppShell />, { wrapper: Wrapper });

    expect(screen.getByText(/getting remy's camera ready/i)).toBeInTheDocument();
  });

  it('renders the real app once settings.get is pre-loaded', () => {
    // settings.get is pre-seeded — component sees data on first render.
    // All child queries are also pre-seeded so the real app can mount.
    mockQuery('settings.get', () => LIVE_SETTINGS);
    mockQuery('cameras.list', () => []);
    mockQuery('activity.today', () => []);
    mockQuery('activity.range', () => []);
    mockQuery('stats.today', () => ({ zones: [] }));
    mockQuery('stats.wheelRecords', () => ({
      todayMeters: 0,
      weekMeters: 0,
      allTimeMeters: 0,
      bestDayMeters: 0,
      bestDayDate: null,
      bestSessionMeters: 0,
      dailySeries: [],
    }));
    mockQuery('pet.currentStatus', () => ({
      activity: null,
      zone: null,
      cameraId: null,
      sinceMs: null,
      stale: true,
    }));
    mockQuery('badges.earned', () => []);

    const { Wrapper } = makeWrapper({ seedSettings: true });

    render(<AppShell />, { wrapper: Wrapper });

    // settings.data is pre-populated → no splash, real app (Header h1) renders.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('falls through the splash after the safety timeout fires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });

    // settings not seeded → stays in loading state (synchronous first render).
    // Seed child queries so the real app renders cleanly after the timeout.
    const { Wrapper, queryClient } = makeWrapper({ seedSettings: false });
    queryClient.setQueryData([['cameras', 'list'], { type: 'query' }], []);
    queryClient.setQueryData([['activity', 'today'], { type: 'query' }], []);
    queryClient.setQueryData([['activity', 'range'], { type: 'query' }], []);
    queryClient.setQueryData([['stats', 'today'], { type: 'query' }], { zones: [] });
    queryClient.setQueryData([['stats', 'wheelRecords'], { type: 'query' }], {
      todayMeters: 0,
      weekMeters: 0,
      allTimeMeters: 0,
      bestDayMeters: 0,
      bestDayDate: null,
      bestSessionMeters: 0,
      dailySeries: [],
    });
    queryClient.setQueryData([['pet', 'currentStatus'], { type: 'query' }], {
      activity: null,
      zone: null,
      cameraId: null,
      sinceMs: null,
      stale: true,
    });
    queryClient.setQueryData([['badges', 'earned'], { type: 'query' }], []);

    render(<AppShell />, { wrapper: Wrapper });

    // Splash is showing on first synchronous render.
    expect(screen.getByRole('status')).toBeInTheDocument();

    // Fire the 8-second timeout. Use act so React flushes state updates.
    act(() => {
      vi.advanceTimersByTime(8_001);
    });

    // After the timeout, settingsTimedOut=true → splash is gone, real app renders.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});
