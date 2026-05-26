// app/web/test/BadgesSection.test.tsx
//
// Tests for the BadgesSection component:
//   1. Shows all 26 badge labels (catalog-driven grid).
//   2. Locked badges (absent from query data) have "locked" in aria-label.
//   3. Earned badge (present, count=1) shows "earned on <date>", no "×" pill.
//   4. Earned badge with count > 1 shows the "×N" pill text.
//   5. Loading state renders a busy skeleton (aria-busy=true) not the grid.
//
// Strategy: pre-seed the React Query cache directly (same technique as
// AppShell.test.tsx) so data bypasses the tRPC Zod output validation that
// strips unknown fields. This lets us feed the new BadgeEarned shape
// { badge_id, count, first_earned_at, last_earned_at } even though the current
// server schema only validates { badge_id, earned_at }.

import { ReactNode } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { trpc, makeTrpcClient } from '../src/trpc';
import { BadgesSection } from '../src/components/BadgesSection';
import { BADGE_CATALOG, type BadgeEarned } from '../src/badges';
import { clearMocks } from './msw/trpc-mock';

// The tRPC cache key for badges.earned.
const BADGES_KEY = [['badges', 'earned'], { type: 'query' }] as const;

// A fixed epoch-ms: noon UTC on May 24 2026 (stable across timezones ≥ UTC-12).
const MAY_24_UTC_NOON = Date.UTC(2026, 4, 24, 12, 0, 0);

function makeEarned(badge_id: string, count: number, last_earned_at = MAY_24_UTC_NOON): BadgeEarned {
  return { badge_id, count, first_earned_at: last_earned_at - 1000, last_earned_at };
}

/** Build a wrapper that pre-seeds the QueryClient cache and skips MSW entirely. */
function makeWrapper(seedData: BadgeEarned[] | null): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });

  // Seed auth so useAuth hooks don't redirect.
  queryClient.setQueryData(['auth', 'me'], {
    user: { id: 1, email: 'u@example.com', display_name: 'Test', role: 'admin' },
  });

  if (seedData !== null) {
    // Pre-seeding bypasses Zod validation — the new BadgeEarned shape flows
    // straight through to the component.
    queryClient.setQueryData(BADGES_KEY, seedData);
  }
  // When seedData is null we intentionally leave the key absent so the
  // component stays in isLoading=true (no data in cache + retry disabled).

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

beforeEach(() => {
  clearMocks();
});

describe('BadgesSection', () => {
  it('renders all 26 badge labels', () => {
    const { Wrapper } = makeWrapper([]);

    render(<BadgesSection />, { wrapper: Wrapper });

    // Catalog-driven: every entry must produce a visible label.
    for (const badge of BADGE_CATALOG) {
      expect(screen.getByText(badge.label)).toBeInTheDocument();
    }

    // Spot-check batch-1 badges.
    expect(screen.getByText('Busy Bee')).toBeInTheDocument();
    expect(screen.getByText('Hydration Hero')).toBeInTheDocument();
    expect(screen.getByText('Sleepy Head')).toBeInTheDocument();
    expect(screen.getByText('Globetrotter')).toBeInTheDocument();
    expect(screen.getByText('Snack Attack')).toBeInTheDocument();
    expect(screen.getByText('Wheel Veteran')).toBeInTheDocument();
    expect(screen.getByText('Paparazzi')).toBeInTheDocument();
    expect(screen.getByText('Globe Runner')).toBeInTheDocument();

    // Spot-check batch-2 badges (the 8 new entries).
    expect(screen.getByText('Wheelie')).toBeInTheDocument();
    expect(screen.getByText('Wanderer')).toBeInTheDocument();
    expect(screen.getByText('Hide & Seek')).toBeInTheDocument();
    expect(screen.getByText('Variety Pack')).toBeInTheDocument();
    expect(screen.getByText('Regular')).toBeInTheDocument();
    expect(screen.getByText('Loyal Friend')).toBeInTheDocument();
    expect(screen.getByText('Aqua Lord')).toBeInTheDocument();
    expect(screen.getByText('Wheel Legend')).toBeInTheDocument();
  });

  it('all badges are locked when earned data is empty', () => {
    const { Wrapper } = makeWrapper([]);

    render(<BadgesSection />, { wrapper: Wrapper });

    // Every tile should have "locked" in its aria-label.
    const tiles = screen.getAllByLabelText(/locked/i);
    expect(tiles).toHaveLength(BADGE_CATALOG.length);
  });

  it('earned badge (count=1) has aria-label with date, no "×" pill', () => {
    const { Wrapper } = makeWrapper([makeEarned('marathon', 1)]);

    render(<BadgesSection />, { wrapper: Wrapper });

    // Aria-label should mention "earned on" (not "locked", not "earned N times").
    const tile = screen.getByLabelText(/marathon runner.*earned on/i);
    expect(tile).toBeInTheDocument();

    // Verify the "earned N times" phrase is absent (count=1 shows no multiplier).
    expect(tile.getAttribute('aria-label')).not.toMatch(/earned \d+ times/i);

    // No ×N pill anywhere in the document.
    expect(screen.queryByText(/×\d/)).toBeNull();
  });

  it('earned badge with count > 1 shows the ×N pill and "earned N times" in aria-label', () => {
    const { Wrapper } = makeWrapper([makeEarned('foodie', 3)]);

    render(<BadgesSection />, { wrapper: Wrapper });

    // Aria-label must mention "earned 3 times".
    screen.getByLabelText(/foodie.*earned 3 times/i);

    // Visible ×3 pill is in the DOM.
    expect(screen.getByText('×3')).toBeInTheDocument();
  });

  it('shows a loading skeleton while data is pending', () => {
    // Pass null → cache is not seeded → component stays in isLoading=true.
    const { Wrapper } = makeWrapper(null);

    render(<BadgesSection />, { wrapper: Wrapper });

    // The section heading is always rendered (not inside the conditional).
    expect(screen.getByRole('region', { name: /badges/i })).toBeInTheDocument();

    // Skeleton has aria-busy.
    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();

    // No badge label tiles rendered yet.
    expect(screen.queryByText('Marathon Runner')).toBeNull();
  });
});
