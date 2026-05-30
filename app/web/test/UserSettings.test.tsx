// app/web/test/UserSettings.test.tsx
//
// Behavior tests for UserSettings — empty state, loading state, and
// populated list.
//
// Strategy: pre-seed React Query cache directly so the component resolves
// synchronously without MSW network calls (same pattern as CameraSettings tests).

import { ReactNode } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse, server } from './msw/server';
import { mockQuery, clearMocks } from './msw/trpc-mock';
import { trpc, makeTrpcClient, RouterOutputs } from '../src/trpc';

type UserRow = RouterOutputs['users']['list'][number];

const AUTHED_ADMIN = {
  id: 1,
  email: 'admin@example.com',
  display_name: 'Admin',
  role: 'admin' as const,
};

const USERS_QUERY_KEY = [['users', 'list'], { type: 'query' }] as const;

function makeWrapper(usersData: UserRow[] | undefined): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  // Seed auth so useAuth() resolves to admin without a network call.
  queryClient.setQueryData(['auth', 'me'], { user: AUTHED_ADMIN });

  // Seed users list when provided; leave undefined to simulate loading.
  if (usersData !== undefined) {
    queryClient.setQueryData(USERS_QUERY_KEY, usersData);
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

// Lazy-import UserSettings inside each test so the mock is set before React
// renders.
import { UserSettings } from '../src/components/UserSettings';

beforeEach(() => {
  clearMocks();
  server.use(
    http.get('/auth/me', () =>
      HttpResponse.json({ user: AUTHED_ADMIN }, { status: 200 }),
    ),
  );
  // Backstop: prevent "unhandled request" error if the component re-fetches.
  mockQuery('users.list', () => []);
});

describe('UserSettings — empty state', () => {
  it('shows the empty-state message when users.data is []', () => {
    const { Wrapper } = makeWrapper([]);
    render(<UserSettings />, { wrapper: Wrapper });

    expect(screen.getByText(/no accounts yet/i)).toBeInTheDocument();
    expect(screen.getByText(/tap/i)).toBeInTheDocument();
  });

  it('does not show the empty state while data is undefined (loading)', () => {
    // usersData = undefined → cache has no entry → query is still loading
    const { Wrapper } = makeWrapper(undefined);
    render(<UserSettings />, { wrapper: Wrapper });

    // Loading indicator present
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    // Empty state absent
    expect(screen.queryByText(/no accounts yet/i)).toBeNull();
  });

  it('renders user rows when users are present', async () => {
    const alice: UserRow = {
      id: 2,
      email: 'alice@example.com',
      display_name: 'Alice',
      role: 'child',
      created_at: Date.now() - 86_400_000,
      last_seen_at: Date.now() - 5 * 60_000,
    };

    const { Wrapper } = makeWrapper([alice]);
    render(<UserSettings />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    // Empty state must NOT appear when there are users
    expect(screen.queryByText(/no accounts yet/i)).toBeNull();
  });
});
