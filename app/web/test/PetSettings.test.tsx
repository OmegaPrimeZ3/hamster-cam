// app/web/test/PetSettings.test.tsx
//
// Covers the boolean toggles in PetSettings — read_aloud, auto_rotate, and
// recap_enabled — verifying they render from settings data and that the
// Toggle component fires onChange correctly.
//
// Technique: pre-seed the React Query cache with settings data so the
// component sees data on its first render without a network round-trip
// (same pattern as AppShell.test.tsx / Header.test.tsx).
//
// Mutation wiring (update.mutate({ recap_enabled: v })) is proven at compile
// time: TypeScript rejects the call if recap_enabled is absent from
// settingsUpdateSchema. The interaction tests below verify Toggle's onChange
// in isolation to avoid the jsdom AbortSignal incompatibility with
// httpBatchLink that affects tRPC mutations throughout this test suite.

import { ReactNode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse, server } from './msw/server';
import { mockMutation, clearMocks } from './msw/trpc-mock';
import { trpc, makeTrpcClient } from '../src/trpc';
import { PetSettings, Toggle } from '../src/components/PetSettings';

// Base settings fixture — all required fields, recap_enabled: true.
const BASE_SETTINGS = {
  pet_name: 'Remy',
  pet_emoji: '🐹',
  theme: 'bubblegum' as const,
  theme_mode: 'auto' as const,
  read_aloud: false,
  auto_rotate: false,
  recap_enabled: true,
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

const AUTHED_ADMIN = {
  id: 1,
  email: 'admin@example.com',
  display_name: 'Admin',
  role: 'admin' as const,
};

function makeWrapper(settingsOverrides: Partial<typeof BASE_SETTINGS> = {}): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  // Seed auth so useAuth sees an admin.
  queryClient.setQueryData(['auth', 'me'], { user: AUTHED_ADMIN });
  // Seed settings so PetSettings renders immediately without a network call.
  queryClient.setQueryData([['settings', 'get'], { type: 'query' }], {
    ...BASE_SETTINGS,
    ...settingsOverrides,
  });

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

describe('PetSettings — boolean toggles', () => {
  beforeEach(() => {
    clearMocks();
    server.use(
      http.get('/auth/me', () =>
        HttpResponse.json({ user: AUTHED_ADMIN }, { status: 200 }),
      ),
    );
    // Provide a mutation handler so PetSettings doesn't get an unregistered-
    // procedure 500 if it fires settings.update (e.g. on blur from the name
    // input). This is a backstop — the toggle interaction tests use Toggle
    // in isolation so no mutation fires for those.
    mockMutation('settings.update', (input) => ({
      ...BASE_SETTINGS,
      ...(input as Partial<typeof BASE_SETTINGS>),
    }));
  });

  it('renders the read_aloud toggle reflecting settings data', () => {
    const { Wrapper } = makeWrapper({ read_aloud: false });
    render(<PetSettings />, { wrapper: Wrapper });

    const checkbox = screen.getByRole('checkbox', { name: /read aloud new diary entries/i });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it('renders the auto_rotate toggle reflecting settings data', () => {
    const { Wrapper } = makeWrapper({ auto_rotate: true });
    render(<PetSettings />, { wrapper: Wrapper });

    const checkbox = screen.getByRole('checkbox', { name: /auto-rotate cameras/i });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeChecked();
  });

  it('renders the recap_enabled toggle with correct label and helper text', () => {
    const { Wrapper } = makeWrapper({ recap_enabled: true });
    render(<PetSettings />, { wrapper: Wrapper });

    expect(screen.getByText(/AI Nightly Recap/)).toBeInTheDocument();
    expect(screen.getByText(/warm storybook summary/i)).toBeInTheDocument();

    const checkbox = screen.getByRole('checkbox', { name: /AI Nightly Recap/ });
    expect(checkbox).toBeChecked();
  });

  it('renders recap_enabled unchecked when settings.recap_enabled is false', () => {
    const { Wrapper } = makeWrapper({ recap_enabled: false });
    render(<PetSettings />, { wrapper: Wrapper });

    const checkbox = screen.getByRole('checkbox', { name: /AI Nightly Recap/ });
    expect(checkbox).not.toBeChecked();
  });
});

describe('Toggle — onChange callback', () => {
  // These tests render Toggle in isolation (no tRPC mutation involved) to verify
  // that the checkbox fires onChange with the correct inverted boolean value.

  it('fires onChange(false) when checked Toggle is clicked', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Toggle label="Test toggle" checked={true} onChange={spy} />);

    await user.click(screen.getByRole('checkbox', { name: /test toggle/i }));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(false);
  });

  it('fires onChange(true) when unchecked Toggle is clicked', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Toggle label="Test toggle" checked={false} onChange={spy} />);

    await user.click(screen.getByRole('checkbox', { name: /test toggle/i }));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('renders the hint text when provided', () => {
    render(
      <Toggle
        label="📖 AI Nightly Recap"
        hint="A warm storybook summary of each day, written automatically."
        checked={true}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/warm storybook summary/i)).toBeInTheDocument();
  });

  it('does not render hint text when hint is omitted', () => {
    render(
      <Toggle label="Read aloud" checked={false} onChange={vi.fn()} />,
    );
    // No hint span present — only the label text.
    expect(screen.queryByText(/warm storybook/i)).toBeNull();
  });
});
