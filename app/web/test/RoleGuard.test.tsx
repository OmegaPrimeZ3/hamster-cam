// app/web/test/RoleGuard.test.tsx
//
// Admin sees the gear; child does not. We render the Header (which uses the
// gear via RoleGuard) under both identities.

import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse, server } from './msw/server';
import { mockQuery, clearMocks } from './msw/trpc-mock';
import { renderWithProviders } from './test-utils';
import { Header } from '../src/components/Header';
import { afterEach, beforeEach } from 'vitest';

function meHandler(role: 'admin' | 'child') {
  return http.get('/auth/me', () =>
    HttpResponse.json(
      { user: { id: 9, email: 'u@example.com', display_name: 'U', role } },
      { status: 200 },
    ),
  );
}

beforeEach(() => {
  clearMocks();
  // Header pulls settings + cameras — mock minimal valid responses.
  mockQuery('settings.get', () => ({
    pet_name: 'Peanut',
    pet_emoji: '🐹',
    theme: 'bubblegum',
    theme_mode: 'auto' as const,
    read_aloud: false,
    auto_rotate: false,
    onboarding_complete: true,
    snapshot_retention_days: 90,
    timelapse_retention_days: 30,
    audit_retention_days: 365,
    disk_warn_pct: 85,
    disk_critical_pct: 95,
    transition_window_ms: 8000,
    min_dwell_ms: 2000,
    share_rate_limit_per_hour: 10,
  }));
  mockQuery('cameras.list', () => []);
});

afterEach(() => {
  clearMocks();
});

describe('RoleGuard via Header gear', () => {
  it('renders the gear for admins', async () => {
    server.use(meHandler('admin'));
    renderWithProviders(<Header onOpenSettings={() => {}} onOpenChangePassword={() => {}} />);
    await waitFor(() => {
      expect(screen.getByLabelText(/open settings/i)).toBeInTheDocument();
    });
  });

  it('hides the gear for child accounts', async () => {
    server.use(meHandler('child'));
    renderWithProviders(<Header onOpenSettings={() => {}} onOpenChangePassword={() => {}} />);
    // Wait for /auth/me to resolve and Header to render the user menu
    await waitFor(() => {
      expect(screen.getByText(/^Hi, U!$/)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/open settings/i)).toBeNull();
  });
});
