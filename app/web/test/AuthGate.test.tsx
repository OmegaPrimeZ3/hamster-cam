// app/web/test/AuthGate.test.tsx

import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse, server } from './msw/server';
import { renderWithProviders } from './test-utils';
import { AuthGate } from '../src/components/AuthGate';

function TreeUnderTest(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<div>LOGIN_SCREEN</div>} />
      <Route
        path="*"
        element={
          <AuthGate>
            <div>APP_RENDERED</div>
          </AuthGate>
        }
      />
    </Routes>
  );
}

describe('AuthGate', () => {
  it('redirects to /login when /auth/me returns 401', async () => {
    server.use(
      http.get('/auth/me', () => HttpResponse.json(null, { status: 401 })),
    );
    renderWithProviders(<TreeUnderTest />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('LOGIN_SCREEN')).toBeInTheDocument();
    });
    expect(screen.queryByText('APP_RENDERED')).toBeNull();
  });

  it('renders the wrapped tree when /auth/me returns a user', async () => {
    server.use(
      http.get('/auth/me', () =>
        HttpResponse.json(
          { user: { id: 1, email: 'a@b.com', display_name: 'A', role: 'admin' } },
          { status: 200 },
        ),
      ),
    );
    renderWithProviders(<TreeUnderTest />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('APP_RENDERED')).toBeInTheDocument();
    });
    expect(screen.queryByText('LOGIN_SCREEN')).toBeNull();
  });
});
