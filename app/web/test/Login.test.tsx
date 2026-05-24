// app/web/test/Login.test.tsx
//
// Covers: happy-path login, wrong-creds inline error, MFA-required morph,
// rate-limit (429) message, publicBrand branding on cold first load.

import { ReactNode } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse, server } from './msw/server';
import { mockQuery } from './msw/trpc-mock';
import { renderWithProviders } from './test-utils';
import { trpc, makeTrpcClient } from '../src/trpc';
import { Login } from '../src/components/Login';
import { BRAND_CACHE_KEY } from '../src/lib/brandCache';

// tRPC queries fired inside components error in jsdom due to an AbortSignal
// incompatibility with httpBatchLink (documented in Header.test.tsx). For the
// publicBrand test we bypass the network layer by pre-seeding the React Query
// cache directly — same technique as the "live settings wins" Header test.
// The tRPC key for settings.publicBrand is [['settings','publicBrand'],{type:'query'}].
function renderLoginWithPublicBrand(
  publicBrandData: {
    pet_name: string | null;
    pet_emoji: string | null;
    theme: string;
    theme_mode: 'light' | 'dark' | 'auto';
  },
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  queryClient.setQueryData(
    [['settings', 'publicBrand'], { type: 'query' }],
    publicBrandData,
  );
  const trpcClient = makeTrpcClient();
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/login']}>
            {children}
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    );
  }
  render(<Login />, { wrapper: Wrapper });
}

describe('Login', () => {
  beforeEach(() => {
    localStorage.clear();
    // Register a default publicBrand mock for tests that use renderWithProviders
    // (which hits the network layer). This prevents "unregistered procedure" 500s.
    mockQuery('settings.publicBrand', () => ({
      pet_name: null,
      pet_emoji: null,
      theme: 'bubblegum',
      theme_mode: 'light' as const,
    }));
  });

  it('shows the publicBrand pet name when the query resolves on a cold first load', () => {
    // Pre-seed the QueryClient with a real configured pet name so Login sees
    // publicBrand.data immediately on first render (no network round-trip).
    renderLoginWithPublicBrand({
      pet_name: 'Remy',
      pet_emoji: '🐹',
      theme: 'bubblegum',
      theme_mode: 'light',
    });

    // publicBrand.data is pre-seeded → title shows "Remy Cam!" on first paint.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Remy Cam!');
  });

  it('falls back to "Pet Cam!" when publicBrand returns null pet_name and cache is empty', () => {
    // Pre-seed with null name → generic fallback.
    renderLoginWithPublicBrand({
      pet_name: null,
      pet_emoji: null,
      theme: 'bubblegum',
      theme_mode: 'light',
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Pet Cam!');
  });

  it('shows the cached pet name while publicBrand is still loading (not yet seeded)', () => {
    // Populate cache before render.
    localStorage.setItem(
      BRAND_CACHE_KEY,
      JSON.stringify({ petName: 'Nugget', petEmoji: '🐭' }),
    );
    // Use renderWithProviders — publicBrand query fires but errors in jsdom.
    // The cache is read synchronously before the async query resolves,
    // so "Nugget Cam!" shows immediately.
    renderWithProviders(<Login />, { route: '/login' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Nugget Cam!');
  });

  it('happy path: signs in and the success state replaces error UI', async () => {
    server.use(
      http.post('/auth/login', async () =>
        HttpResponse.json(
          { user: { id: 1, email: 'me@example.com', display_name: 'Me', role: 'admin' } },
          { status: 200 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<Login />, { route: '/login' });

    await user.type(screen.getByLabelText(/email/i), 'me@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'hunter2');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // The submit button is the only programmatically-disabled element; once
    // success returns it re-enables (no spinner stuck).
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
    });
    // No error rendered
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('wrong creds: renders the friendly inline error', async () => {
    server.use(
      http.post('/auth/login', async () =>
        HttpResponse.json({ code: 'invalid_credentials' }, { status: 401 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<Login />, { route: '/login' });

    await user.type(screen.getByLabelText(/email/i), 'me@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/that didn't match/i);
  });

  it('rate limit: surfaces the 429 message', async () => {
    server.use(
      http.post('/auth/login', async () =>
        HttpResponse.json({ code: 'rate_limited' }, { status: 429 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<Login />, { route: '/login' });

    await user.type(screen.getByLabelText(/email/i), 'a@b.com');
    await user.type(screen.getByLabelText(/^password$/i), 'whatever');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too many tries/i);
  });

  it('mfa: morphs into the MFA challenge step', async () => {
    server.use(
      http.post('/auth/login', async () =>
        HttpResponse.json({ mfa_required: true, mfa_challenge: { token: 'ch_abc' } }, { status: 200 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<Login />, { route: '/login' });

    await user.type(screen.getByLabelText(/email/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'hunter2');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const code = await screen.findByLabelText(/two-factor code/i);
    expect(code).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();

    await user.type(code, '123456');
    expect(screen.getByRole('button', { name: /verify/i })).toBeEnabled();
  });
});
