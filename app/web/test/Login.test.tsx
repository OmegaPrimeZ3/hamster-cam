// app/web/test/Login.test.tsx
//
// Covers: happy-path login, wrong-creds inline error, MFA-required morph,
// rate-limit (429) message.

import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse, server } from './msw/server';
import { renderWithProviders } from './test-utils';
import { Login } from '../src/components/Login';

describe('Login', () => {
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
