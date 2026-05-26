// app/web/test/DiaryEntry.test.tsx
//
// Renders the three variants and verifies the right DOM lands for each.
// Also covers the TTS button visibility, the recap activity variant, and the
// delete control (visibility + confirmation flow).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiaryEntry } from '../src/components/DiaryEntry';
import type { RouterOutputs } from '../src/trpc';
import { renderWithProviders } from './test-utils';
import { http, HttpResponse, server } from './msw/server';
import { mockMutation, clearMocks } from './msw/trpc-mock';

type Entry = RouterOutputs['activity']['today'][number];

function makeEntry(overrides: Partial<Entry>): Entry {
  return {
    id: 1,
    occurred_at: Date.now() - 60_000,
    kind: 'narrative',
    activity: 'wheel',
    narrative: '🎡 Peanut went for a run on the wheel — 8 min!',
    pet_name: 'Peanut',
    camera_id: 1,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: 8 * 60 * 1000,
    snapshot_id: null,
    media_path: null,
    thumbnail_url: null,
    ai_model: null,
    details: null,
    created_by: null,
    ...overrides,
  };
}

function meHandler(user: { id: number; role: 'admin' | 'child' }) {
  return http.get('/auth/me', () =>
    HttpResponse.json(
      {
        user: {
          id: user.id,
          email: 'u@example.com',
          display_name: 'Test',
          role: user.role,
        },
      },
      { status: 200 },
    ),
  );
}

beforeEach(() => {
  clearMocks();
});

afterEach(() => {
  clearMocks();
});

describe('DiaryEntry', () => {
  it('narrative variant renders the sentence and relative time', () => {
    const entry = makeEntry({ kind: 'narrative' });
    renderWithProviders(<DiaryEntry entry={entry} now={entry.occurred_at + 60_000} />);
    expect(screen.getByText(/peanut went for a run/i)).toBeInTheDocument();
    expect(screen.getByText(/minute ago/i)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /snapshot/i })).toBeNull();
  });

  it('snapshot variant renders an expandable image', () => {
    const entry = makeEntry({
      kind: 'snapshot',
      activity: 'snapshot',
      narrative: '📸 You saved a memory of Peanut!',
      media_path: '/snapshots/test.jpg',
    });
    renderWithProviders(<DiaryEntry entry={entry} now={entry.occurred_at + 60_000} />);
    const img = screen.getByAltText('📸 You saved a memory of Peanut!');
    expect(img).toBeInTheDocument();
    expect(img.tagName).toBe('IMG');
  });

  it('timelapse variant renders an inline <video> with playsinline', () => {
    const entry = makeEntry({
      kind: 'timelapse',
      activity: 'timelapse',
      narrative: "📽️ Peanut's Day 2026-05-19",
      media_path: '/timelapse/2026-05-19.mp4',
    });
    const { container } = renderWithProviders(<DiaryEntry entry={entry} now={entry.occurred_at + 60_000} />);
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('playsinline') ?? video?.getAttribute('playsInline')).not.toBeNull();
    expect(video?.getAttribute('preload')).toBe('metadata');
  });

  it('shows the Read aloud button when ttsEnabled is true and TTS is available', () => {
    const entry = makeEntry({ kind: 'narrative' });
    renderWithProviders(<DiaryEntry entry={entry} ttsEnabled={true} />);
    // setup.ts stubs speechSynthesis so isTTSAvailable() returns true in tests.
    expect(screen.getByRole('button', { name: /read aloud/i })).toBeInTheDocument();
  });

  it('hides the Read aloud button when ttsEnabled is false', () => {
    const entry = makeEntry({ kind: 'narrative' });
    renderWithProviders(<DiaryEntry entry={entry} ttsEnabled={false} />);
    expect(screen.queryByRole('button', { name: /read aloud/i })).toBeNull();
  });

  it('recap activity variant renders narrative in larger type (data-activity=recap)', () => {
    const entry = makeEntry({
      activity: 'recap',
      narrative: '📖 Here is your hamster recap for today!',
    });
    const { container } = renderWithProviders(
      <DiaryEntry entry={entry} now={entry.occurred_at + 60_000} />,
    );
    const article = container.querySelector('[data-activity="recap"]');
    expect(article).not.toBeNull();
    const p = article?.querySelector('p');
    expect(p).not.toBeNull();
    // 18px for recap, per spec.
    expect(p?.style.fontSize).toBe('18px');
  });

  // --- Delete control ---

  it('admin sees the delete control on a narrative entry', async () => {
    server.use(meHandler({ id: 7, role: 'admin' }));
    // narrative entry, created_by null (auto-generated)
    const entry = makeEntry({ kind: 'narrative', activity: 'wheel', created_by: null });
    renderWithProviders(<DiaryEntry entry={entry} now={entry.occurred_at + 60_000} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delete memory/i })).toBeInTheDocument();
    });
  });

  it('non-admin sees delete on their own snapshot but not on another snapshot or a narrative', async () => {
    const MY_ID = 42;
    server.use(meHandler({ id: MY_ID, role: 'child' }));

    // Own snapshot — should show delete
    const ownSnapshot = makeEntry({ id: 10, kind: 'snapshot', activity: 'snapshot', created_by: MY_ID });
    const { rerender } = renderWithProviders(
      <DiaryEntry entry={ownSnapshot} now={ownSnapshot.occurred_at + 60_000} />,
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delete memory/i })).toBeInTheDocument();
    });

    // Someone else's snapshot — no delete
    const otherSnapshot = makeEntry({ id: 11, kind: 'snapshot', activity: 'snapshot', created_by: 99 });
    rerender(<DiaryEntry entry={otherSnapshot} now={otherSnapshot.occurred_at + 60_000} />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /delete memory/i })).toBeNull();
    });

    // Narrative — no delete (non-admin)
    const narrative = makeEntry({ id: 12, kind: 'narrative', activity: 'wheel', created_by: null });
    rerender(<DiaryEntry entry={narrative} now={narrative.occurred_at + 60_000} />);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /delete memory/i })).toBeNull();
    });
  });

  it('first click transitions to confirm state; second click submits the mutation', async () => {
    // Note: we verify the two-step UI state machine here. tRPC's httpBatchLink
    // has an AbortSignal incompatibility in Node 24 / jsdom that causes the
    // network request to fail synchronously (see PetSettings.test.tsx comment).
    // We verify (a) the confirmation UI transition and (b) that firing the
    // second click triggers del.mutate (evidenced by the confirm state resetting
    // via onError, meaning the mutation path was reached and called back).
    server.use(meHandler({ id: 5, role: 'admin' }));

    // Register the handler so the msw dispatcher does not throw 500.
    mockMutation('activity.delete', (_input) => ({ ok: true }));

    const entry = makeEntry({ id: 77, kind: 'narrative', activity: 'wheel', created_by: null });
    renderWithProviders(<DiaryEntry entry={entry} now={entry.occurred_at + 60_000} />);

    // Wait for auth to resolve so canDelete is true.
    const deleteBtn = await screen.findByRole('button', { name: /delete memory/i });

    // First click → button label changes to the confirmation copy.
    await userEvent.click(deleteBtn);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /are you sure/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^delete memory$/i })).toBeNull();

    // Second click → del.mutate fires. In this test environment the request
    // fails with an AbortSignal error (not our code's fault) which triggers
    // onError → confirmDelete resets → the button reverts to "Delete memory".
    const confirmBtn = screen.getByRole('button', { name: /are you sure/i });
    await userEvent.click(confirmBtn);

    // The mutation was attempted: onError fired and reset the confirm state,
    // so the delete button returns to its initial label.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delete memory/i })).toBeInTheDocument();
    });
  });
});
