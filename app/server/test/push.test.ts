// Tests for push.ts
// Covers: rare-event predicate, quiet-hours predicate, dead-subscription
// cleanup, send-to-user happy path, and evaluatePushForEntry filtering.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiaryEntryRow, DiaryActivity, DiaryKind, UpsertPushSubscriptionInput } from '../src/db.js';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'hamster-push-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  delete process.env['FRIGATE_URL'];
  delete process.env['MQTT_URL'];
});

afterEach(async () => {
  const db = await import('../src/db.js');
  const { resetConfigForTests } = await import('../src/config.js');
  db.resetDbForTests();
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedUser(): Promise<number> {
  const db = await import('../src/db.js');
  const user = db.createUser({
    zyphr_user_id: 'zyphr-test-1',
    email: 'test@example.com',
    display_name: 'Test User',
    role: 'admin',
    created_by: null,
  });
  return user.id;
}

function makePushSub(endpoint: string): UpsertPushSubscriptionInput {
  return {
    user_id: 0,
    endpoint,
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtwe6YZZ',
    auth: 'tBHItJI5svbpez7KI4CCXg==',
    user_agent: 'test-browser/1.0',
  };
}

function makeDiaryEntry(
  overrides: Partial<DiaryEntryRow> & { id: number; kind: DiaryKind; activity: DiaryActivity | null },
): DiaryEntryRow {
  return {
    occurred_at: Date.now(),
    narrative: 'test narrative',
    pet_name: null,
    camera_id: null,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: null,
    snapshot_id: null,
    media_path: null,
    details: null,
    ai_model: null,
    created_by: null,
    ...overrides,
  };
}

type MockSendResult = { statusCode: number } | null;

function makeSendFn(result: MockSendResult) {
  return vi.fn(async (_sub: unknown, _payload: string) => {
    if (result && result.statusCode >= 400) {
      const err = Object.assign(new Error(`Push failed: ${result.statusCode}`), {
        statusCode: result.statusCode,
      });
      throw err;
    }
    return { statusCode: 201 } as import('web-push').SendResult;
  });
}

// ---------------------------------------------------------------------------
// isRareEvent
// ---------------------------------------------------------------------------

describe('isRareEvent', () => {
  it('returns true for first occurrence of activity today', async () => {
    const { isRareEvent } = await import('../src/push.js');
    const dayStart = new Date('2026-05-20').setHours(0, 0, 0, 0);
    const occurredAt = dayStart + 2 * 60 * 60 * 1000;
    expect(
      isRareEvent({
        activity: 'wheel',
        durationMs: 5_000,
        occurredAt,
        dayStart,
        recentEntries: [],
      }),
    ).toBe(true);
  });

  it('returns false for a repeat activity within the same day', async () => {
    const { isRareEvent } = await import('../src/push.js');
    const dayStart = new Date('2026-05-20').setHours(0, 0, 0, 0);
    const first = dayStart + 1 * 60 * 60 * 1000;
    const second = dayStart + 2 * 60 * 60 * 1000;

    const priorEntry = makeDiaryEntry({
      id: 1, kind: 'narrative', activity: 'wheel', occurred_at: first, duration_ms: 5_000,
    });

    expect(
      isRareEvent({
        activity: 'wheel',
        durationMs: 5_000,
        occurredAt: second,
        dayStart,
        recentEntries: [priorEntry],
      }),
    ).toBe(false);
  });

  it('returns true when no entry in the last 6 hours (pet woke up)', async () => {
    const { isRareEvent } = await import('../src/push.js');
    const dayStart = new Date('2026-05-20').setHours(0, 0, 0, 0);
    const occurredAt = dayStart + 2 * 60 * 60 * 1000;
    // Prior entry is older than 6 hours.
    const veryOldEntry = makeDiaryEntry({
      id: 1, kind: 'narrative', activity: 'wheel', occurred_at: occurredAt - 7 * 60 * 60 * 1000,
    });

    expect(
      isRareEvent({
        activity: 'wheel',
        durationMs: null,
        occurredAt,
        dayStart,
        recentEntries: [veryOldEntry],
      }),
    ).toBe(true);
  });

  it('returns true for wheel run >= 20 min even if already occurred today', async () => {
    const { isRareEvent } = await import('../src/push.js');
    const dayStart = new Date('2026-05-20').setHours(0, 0, 0, 0);
    const first = dayStart + 1 * 60 * 60 * 1000;
    const second = dayStart + 2 * 60 * 60 * 1000;

    const priorEntry = makeDiaryEntry({
      id: 1, kind: 'narrative', activity: 'wheel', occurred_at: first, duration_ms: 5_000,
    });

    expect(
      isRareEvent({
        activity: 'wheel',
        durationMs: 20 * 60 * 1000,
        occurredAt: second,
        dayStart,
        recentEntries: [priorEntry],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isQuietHour
// ---------------------------------------------------------------------------

describe('isQuietHour', () => {
  it('returns true during overnight quiet window', async () => {
    const { isQuietHour } = await import('../src/push.js');
    // quiet: 21:00–07:00 (1260–420). Test at 23:00 (1380 min).
    const midnight = new Date('2026-05-20T23:00:00').getTime();
    expect(isQuietHour(midnight, 1260, 420)).toBe(true);
  });

  it('returns true in the early-morning part of the overnight window', async () => {
    const { isQuietHour } = await import('../src/push.js');
    const earlyMorning = new Date('2026-05-20T03:00:00').getTime();
    expect(isQuietHour(earlyMorning, 1260, 420)).toBe(true);
  });

  it('returns false outside the quiet window', async () => {
    const { isQuietHour } = await import('../src/push.js');
    const afternoon = new Date('2026-05-20T14:00:00').getTime();
    expect(isQuietHour(afternoon, 1260, 420)).toBe(false);
  });

  it('handles a same-day window (08:00–18:00)', async () => {
    const { isQuietHour } = await import('../src/push.js');
    const noon = new Date('2026-05-20T12:00:00').getTime();
    expect(isQuietHour(noon, 480, 1080)).toBe(true);
    const evening = new Date('2026-05-20T19:00:00').getTime();
    expect(isQuietHour(evening, 480, 1080)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendPushToUser — dead-subscription cleanup
// ---------------------------------------------------------------------------

describe('sendPushToUser', () => {
  it('removes a 410-Gone subscription from the DB', async () => {
    const db = await import('../src/db.js');
    const { sendPushToUser } = await import('../src/push.js');
    const userId = await seedUser();

    db.upsertPushSubscription({ ...makePushSub('https://push.example.com/gone'), user_id: userId });
    expect(db.listPushSubscriptionsForUser(userId)).toHaveLength(1);

    const sendFn = makeSendFn({ statusCode: 410 });
    await sendPushToUser(userId, { title: 'T', body: 'B', url: '/', tag: 'test' }, { sendNotification: sendFn });

    expect(db.listPushSubscriptionsForUser(userId)).toHaveLength(0);
  });

  it('removes a 404 subscription from the DB', async () => {
    const db = await import('../src/db.js');
    const { sendPushToUser } = await import('../src/push.js');
    const userId = await seedUser();

    db.upsertPushSubscription({ ...makePushSub('https://push.example.com/404sub'), user_id: userId });
    const sendFn = makeSendFn({ statusCode: 404 });
    await sendPushToUser(userId, { title: 'T', body: 'B', url: '/', tag: 'test' }, { sendNotification: sendFn });

    expect(db.listPushSubscriptionsForUser(userId)).toHaveLength(0);
  });

  it('keeps the subscription on transient errors', async () => {
    const db = await import('../src/db.js');
    const { sendPushToUser } = await import('../src/push.js');
    const userId = await seedUser();

    db.upsertPushSubscription({ ...makePushSub('https://push.example.com/transient'), user_id: userId });
    const sendFn = makeSendFn({ statusCode: 500 });
    await sendPushToUser(userId, { title: 'T', body: 'B', url: '/', tag: 'test' }, { sendNotification: sendFn });

    expect(db.listPushSubscriptionsForUser(userId)).toHaveLength(1);
  });

  it('delivers payload to a live subscription', async () => {
    const db = await import('../src/db.js');
    const { sendPushToUser } = await import('../src/push.js');
    const userId = await seedUser();

    db.upsertPushSubscription({ ...makePushSub('https://push.example.com/live'), user_id: userId });
    const sendFn = makeSendFn(null);
    await sendPushToUser(userId, { title: 'Hi', body: 'Body', url: '/', tag: 'wheel' }, { sendNotification: sendFn });

    expect(sendFn).toHaveBeenCalledOnce();
    const payloadStr = sendFn.mock.calls[0]![1];
    const payload = JSON.parse(payloadStr) as { title: string; body: string; tag: string };
    expect(payload.title).toBe('Hi');
    expect(payload.tag).toBe('wheel');
  });
});

// ---------------------------------------------------------------------------
// evaluatePushForEntry — filtering
// ---------------------------------------------------------------------------

describe('evaluatePushForEntry', () => {
  it('skips timelapse entries without calling send', async () => {
    const db = await import('../src/db.js');
    const { evaluatePushForEntry } = await import('../src/push.js');
    const userId = await seedUser();
    db.upsertPushSubscription({ ...makePushSub('https://push.example.com/skip-tl'), user_id: userId });

    const sendFn = makeSendFn(null);
    const entry = makeDiaryEntry({ id: 1, kind: 'timelapse', activity: 'timelapse' });

    await evaluatePushForEntry(entry, { sendNotification: sendFn });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('skips recap entries without calling send', async () => {
    const db = await import('../src/db.js');
    const { evaluatePushForEntry } = await import('../src/push.js');
    const userId = await seedUser();
    db.upsertPushSubscription({ ...makePushSub('https://push.example.com/skip-recap'), user_id: userId });

    const sendFn = makeSendFn(null);
    const entry = makeDiaryEntry({ id: 2, kind: 'recap', activity: 'recap', ai_model: 'gemini-2.0-flash' });

    await evaluatePushForEntry(entry, { sendNotification: sendFn });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('sends for a rare wheel event during active hours', async () => {
    const db = await import('../src/db.js');
    const { evaluatePushForEntry } = await import('../src/push.js');
    const userId = await seedUser();
    db.upsertPushSubscription({ ...makePushSub('https://push.example.com/wheel-ok'), user_id: userId });
    db.setSetting('pet_name', 'Peanut');

    db.upsertNotificationPreferences({
      user_id: userId,
      enabled: 1,
      activities: '["wheel","food","water","resting","hiding"]',
      quiet_start_minute: 1260,
      quiet_end_minute: 420,
      rare_only: 1,
    });

    const sendFn = makeSendFn(null);
    const noonMs = new Date('2026-05-20T12:00:00').getTime();
    const entry = makeDiaryEntry({
      id: 3, kind: 'narrative', activity: 'wheel', occurred_at: noonMs,
      narrative: 'Peanut ran on the wheel!', pet_name: 'Peanut', duration_ms: 5_000,
    });

    await evaluatePushForEntry(entry, { sendNotification: sendFn, now: () => noonMs });
    expect(sendFn).toHaveBeenCalledOnce();
  });

  it('suppresses during quiet hours', async () => {
    const db = await import('../src/db.js');
    const { evaluatePushForEntry } = await import('../src/push.js');
    const userId = await seedUser();
    db.upsertPushSubscription({ ...makePushSub('https://push.example.com/quiet'), user_id: userId });
    db.setSetting('pet_name', 'Peanut');

    db.upsertNotificationPreferences({
      user_id: userId,
      enabled: 1,
      activities: '["wheel"]',
      quiet_start_minute: 1260,
      quiet_end_minute: 420,
      rare_only: 0,
    });

    const sendFn = makeSendFn(null);
    const nightMs = new Date('2026-05-20T23:00:00').getTime();
    const entry = makeDiaryEntry({
      id: 4, kind: 'narrative', activity: 'wheel', occurred_at: nightMs,
      narrative: 'Peanut ran at night!', pet_name: 'Peanut', duration_ms: 5_000,
    });

    await evaluatePushForEntry(entry, { sendNotification: sendFn, now: () => nightMs });
    expect(sendFn).not.toHaveBeenCalled();
  });
});
