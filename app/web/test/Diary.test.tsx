// app/web/test/Diary.test.tsx
//
// Tests for the Diary component and DiaryRangePicker:
//
//   1. Default preset is "Last 24 hours" — heading says so.
//   2. Diary fires activity.range (not activity.today).
//   3. Changing the preset updates the heading.
//   4. Range change marks all entries seen immediately (no TTS narration of
//      the newly loaded window).
//   5. DiaryRangePicker renders all five preset options.
//   6. Custom range inputs appear when "Custom range…" is selected.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ReactNode } from 'react';
import { http, HttpResponse, server } from './msw/server';
import { mockQuery, clearMocks } from './msw/trpc-mock';
import { trpc, makeTrpcClient } from '../src/trpc';
import { render } from '@testing-library/react';
import { Diary } from '../src/components/Diary';
import { DiaryRangePicker } from '../src/components/DiaryRangePicker';
import type { RouterOutputs } from '../src/trpc';
import { defaultRangeState } from '../src/lib/diaryRange';

type Entry = RouterOutputs['activity']['today'][number];

// Fixed "now" used throughout tests so we can compute deterministic cache keys.
// The component floors Date.now() to the nearest 30s.
const FIXED_NOW_MS = 1_748_000_000_000; // arbitrary fixed epoch

/** Compute the tRPC React Query cache key for activity.range with given input. */
function rangeQueryKey(from: number, to: number): unknown[] {
  return [['activity', 'range'], { input: { from, to }, type: 'query' }];
}

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 1,
    occurred_at: FIXED_NOW_MS - 60_000,
    kind: 'narrative',
    activity: 'wheel',
    narrative: '🎡 Remy went for a run!',
    pet_name: 'Remy',
    camera_id: 1,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: 5 * 60 * 1000,
    snapshot_id: null,
    media_path: null,
    thumbnail_url: null,
    ai_model: null,
    details: null,
    created_by: null,
    clip_available: false,
    ...overrides,
  };
}

const MIN_SETTINGS = {
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

/**
 * Build a wrapper that pre-seeds the QueryClient so queries resolve
 * synchronously in tests without hitting the network.
 *
 * `rangeEntries` — seeded into the last-24h cache key (the default preset).
 * `settingsOverride` — merged into MIN_SETTINGS.
 */
function makeWrapper(opts: {
  rangeEntries?: Entry[];
  settingsOverride?: Partial<typeof MIN_SETTINGS>;
}): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  // Auth
  queryClient.setQueryData(['auth', 'me'], {
    user: { id: 1, email: 'a@example.com', display_name: 'A', role: 'admin' },
  });

  // Settings
  const settings = { ...MIN_SETTINGS, ...(opts.settingsOverride ?? {}) };
  queryClient.setQueryData([['settings', 'get'], { type: 'query' }], settings);

  // Seed the default last-24h range key so the component never fires a network
  // request. We mirror the component's flooring logic: floor(now/30000)*30000.
  if (opts.rangeEntries !== undefined) {
    const floored = Math.floor(FIXED_NOW_MS / 30_000) * 30_000;
    const from24h = floored - 24 * 60 * 60 * 1000;
    queryClient.setQueryData(rangeQueryKey(from24h, floored), opts.rangeEntries);
  }

  const trpcClient = makeTrpcClient();

  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>{children}</MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    );
  }

  return { Wrapper, queryClient };
}

beforeEach(() => {
  clearMocks();
  sessionStorage.clear();
  // Pin Date.now() so the component's floored 30s buckets are deterministic,
  // allowing us to pre-seed the exact cache key.
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(FIXED_NOW_MS);

  server.use(
    http.get('/auth/me', () =>
      HttpResponse.json(
        { user: { id: 1, email: 'a@example.com', display_name: 'A', role: 'admin' } },
        { status: 200 },
      ),
    ),
  );
  // MSW fallback for tests that don't pre-seed the cache.
  mockQuery('activity.range', () => []);
  mockQuery('settings.get', () => MIN_SETTINGS);
});

afterEach(() => {
  clearMocks();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Diary component tests
// ---------------------------------------------------------------------------

describe('Diary — default preset and heading', () => {
  it('renders "Last 24 hours" heading by default', () => {
    const { Wrapper } = makeWrapper({ rangeEntries: [] });
    render(<Diary readAloud={false} petName="Remy" />, { wrapper: Wrapper });
    // The heading is rendered synchronously from component state (no data needed).
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /last 24 hours/i,
    );
  });

  it('renders the "Last 24 hours" option as selected in the picker by default', () => {
    const { Wrapper } = makeWrapper({ rangeEntries: [] });
    render(<Diary readAloud={false} petName="Remy" />, { wrapper: Wrapper });
    const trigger = screen.getByRole('button', { name: /diary time range/i });
    expect(trigger).toHaveTextContent(/last 24 hours/i);
  });

  it('does NOT render a heading that says "Today" by default', () => {
    const { Wrapper } = makeWrapper({ rangeEntries: [] });
    render(<Diary readAloud={false} petName="Remy" />, { wrapper: Wrapper });
    const h2 = screen.getByRole('heading', { level: 2 });
    expect(h2.textContent).not.toMatch(/— Today$/i);
  });
});

describe('Diary — range change updates heading', () => {
  it('shows "Today" heading after selecting Today preset', async () => {
    // userEvent.setup() needs real timers
    vi.useRealTimers();
    const user = userEvent.setup();
    const { Wrapper } = makeWrapper({ rangeEntries: [] });
    render(<Diary readAloud={false} petName="Remy" />, { wrapper: Wrapper });

    const trigger = screen.getByRole('button', { name: /diary time range/i });
    await user.click(trigger);

    const listbox = await screen.findByRole('listbox');
    const todayOption = within(listbox).getByRole('option', { name: /^today$/i });
    await user.click(todayOption);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
        /— Today/i,
      );
    });
  });

  it('shows "Last 7 days" heading after selecting Last 7 days preset', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const { Wrapper } = makeWrapper({ rangeEntries: [] });
    render(<Diary readAloud={false} petName="Remy" />, { wrapper: Wrapper });

    const trigger = screen.getByRole('button', { name: /diary time range/i });
    await user.click(trigger);

    const listbox = await screen.findByRole('listbox');
    const opt = within(listbox).getByRole('option', { name: /last 7 days/i });
    await user.click(opt);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
        /last 7 days/i,
      );
    });
  });
});

describe('Diary — seen-ids reset on range change', () => {
  it('does not call speechSynthesis.speak for backlog when range changes', async () => {
    // userEvent needs real timers; we still have FIXED_NOW_MS set via
    // vi.setSystemTime before this test suite, but we switch to real for
    // interaction.
    vi.useRealTimers();
    const speakSpy = vi.spyOn(window.speechSynthesis, 'speak');
    const user = userEvent.setup();

    const entries = [
      makeEntry({ id: 10, narrative: '🎡 Remy ran!' }),
      makeEntry({ id: 11, narrative: '💤 Remy rested.' }),
    ];

    // Pre-seed cache using real Date.now() (since we switched to real timers).
    // The component floors to 30s; compute the same floor.
    const realNow = Date.now();
    const floored = Math.floor(realNow / 30_000) * 30_000;
    const { Wrapper, queryClient } = makeWrapper({});
    // Seed last-24h key with real now
    queryClient.setQueryData(
      rangeQueryKey(floored - 24 * 60 * 60 * 1000, floored),
      entries,
    );

    render(<Diary readAloud={true} petName="Remy" />, { wrapper: Wrapper });

    // Wait for entries to render from pre-seeded cache
    await waitFor(() => {
      expect(screen.getByText(/remy ran/i)).toBeInTheDocument();
    });

    // Initial load should NOT speak (all marked seen on first data).
    expect(speakSpy).not.toHaveBeenCalled();

    // Change range to "Today" — trigger treats new data as fresh load (mark seen, no TTS).
    const trigger = screen.getByRole('button', { name: /diary time range/i });
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox');
    const todayOpt = within(listbox).getByRole('option', { name: /^today$/i });
    await user.click(todayOpt);

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
        /— Today/i,
      );
    });

    // Still no TTS — range change marks backlog as seen
    expect(speakSpy).not.toHaveBeenCalled();
  });
});

describe('Diary — empty state', () => {
  it('shows empty-state message when no entries are returned', () => {
    // Pre-seed cache with empty array so rangeQuery.data = [] immediately
    // on first render (no network request, no waiting needed).
    const { Wrapper } = makeWrapper({ rangeEntries: [] });
    render(<Diary readAloud={false} petName="Remy" />, { wrapper: Wrapper });
    expect(
      screen.getByText(/nothing happened during this time/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// DiaryRangePicker standalone tests
// ---------------------------------------------------------------------------

describe('DiaryRangePicker', () => {
  it('renders a button showing the current preset label', () => {
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <DiaryRangePicker value={defaultRangeState()} onChange={onChange} />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('button', { name: /diary time range/i }),
    ).toHaveTextContent(/last 24 hours/i);
  });

  it('opens a listbox with five options on click', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <DiaryRangePicker value={defaultRangeState()} onChange={onChange} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /diary time range/i }));
    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(5);
  });

  it('calls onChange with the selected preset on option click', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <DiaryRangePicker value={defaultRangeState()} onChange={onChange} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /diary time range/i }));
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: /last 7 days/i }));
    expect(onChange).toHaveBeenCalledWith({ preset: 'last7d', custom: null });
  });

  it('reveals date inputs when "Custom range…" is selected', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <MemoryRouter>
        <DiaryRangePicker value={defaultRangeState()} onChange={onChange} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /diary time range/i }));
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByRole('option', { name: /custom range/i }));

    // Rerender with custom preset so date inputs appear (the picker stays open
    // in custom mode — onChange was called, parent would pass preset:'custom').
    rerender(
      <MemoryRouter>
        <DiaryRangePicker
          value={{ preset: 'custom', custom: null }}
          onChange={onChange}
        />
      </MemoryRouter>,
    );

    // datetime-local inputs are accessible via their aria-label
    expect(
      screen.getByLabelText(/custom range start date and time/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/custom range end date and time/i),
    ).toBeInTheDocument();
  });

  it('marks the current preset as aria-selected in the listbox', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <DiaryRangePicker
          value={{ preset: 'today', custom: null }}
          onChange={onChange}
        />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /diary time range/i }));
    const listbox = screen.getByRole('listbox');
    const todayOpt = within(listbox).getByRole('option', { name: /^today$/i });
    expect(todayOpt).toHaveAttribute('aria-selected', 'true');
    const last24hOpt = within(listbox).getByRole('option', { name: /last 24 hours/i });
    expect(last24hOpt).toHaveAttribute('aria-selected', 'false');
  });

  it('closes the listbox on Escape key', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <DiaryRangePicker value={defaultRangeState()} onChange={onChange} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: /diary time range/i }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });
});
