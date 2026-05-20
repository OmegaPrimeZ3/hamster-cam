// app/server/src/push.ts
// Web Push notification subsystem: VAPID key lifecycle, send helpers,
// subscription CRUD, and the rare-event evaluation predicate.
//
// Safety contract: every exported function that touches the push gateway
// swallows errors via a warn log — the narrator path must never be disrupted.

import webpush, { type PushSubscription, type SendResult } from 'web-push';

import * as db from './db.js';
import { childLogger } from './logger.js';

const logger = childLogger('push');

// ---------------------------------------------------------------------------
// VAPID lifecycle
// ---------------------------------------------------------------------------

/**
 * Ensure VAPID keys exist in the settings table. Called once at server boot.
 * Generates a fresh keypair on first run and persists it; subsequent boots
 * reuse the stored keys.
 */
export function initVapidKeys(): void {
  let publicKey = db.getSetting('vapid_public_key');
  let privateKey = db.getSetting('vapid_private_key');

  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    db.setSetting('vapid_public_key', keys.publicKey);
    db.setSetting('vapid_private_key', keys.privateKey);
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    logger.info('VAPID keypair generated and persisted');
  }

  webpush.setVapidDetails(
    'mailto:hamster-cam@localhost',
    publicKey,
    privateKey,
  );
}

export function getVapidPublicKey(): string | null {
  return db.getSetting('vapid_public_key');
}

// ---------------------------------------------------------------------------
// Push payload shape
// ---------------------------------------------------------------------------

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

export interface SendPushDeps {
  sendNotification?: (
    sub: PushSubscription,
    payload: string,
    options?: webpush.RequestOptions,
  ) => Promise<SendResult>;
}

/**
 * Send a push notification to all subscriptions for a given user. Dead
 * subscriptions (410 Gone / 404 Not Found) are removed from the DB. All
 * other errors are logged and swallowed.
 */
export async function sendPushToUser(
  userId: number,
  payload: PushPayload,
  deps: SendPushDeps = {},
): Promise<void> {
  const sendFn = deps.sendNotification ?? webpush.sendNotification.bind(webpush);
  const subs = db.listPushSubscriptionsForUser(userId);
  if (subs.length === 0) return;

  const payloadStr = JSON.stringify(payload);
  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await sendFn(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payloadStr,
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 410 || statusCode === 404) {
          db.deletePushSubscriptionByEndpoint(sub.endpoint);
          logger.info(
            { userId, endpoint: sub.endpoint.slice(0, 40), statusCode },
            'removed dead push subscription',
          );
        } else {
          logger.warn(
            { userId, endpoint: sub.endpoint.slice(0, 40), err: (err as Error).message },
            'push send failed',
          );
        }
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Rare-event predicate
// ---------------------------------------------------------------------------

export interface RareEventContext {
  activity: db.DiaryActivity;
  durationMs: number | null;
  occurredAt: number;
  dayStart: number;
  recentEntries: db.DiaryEntryRow[];
}

/**
 * Returns true when this event qualifies as "rare" and should trigger a push
 * regardless of the user's `rare_only` toggle. Pure function — testable
 * without mocking the DB.
 *
 * Conditions (OR):
 *   a) first occurrence of this activity for the current local day
 *   b) no diary entry in the last 6 hours (pet just woke up)
 *   c) activity === 'wheel' && duration_ms >= 20 min
 */
export function isRareEvent(ctx: RareEventContext): boolean {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const WHEEL_DURATION_THRESHOLD_MS = 20 * 60 * 1000;

  // (a) first occurrence of this activity today
  const prevToday = ctx.recentEntries.filter(
    (e) =>
      e.occurred_at >= ctx.dayStart &&
      e.occurred_at < ctx.occurredAt &&
      e.activity === ctx.activity,
  );
  if (prevToday.length === 0) return true;

  // (b) no entry in the last 6 hours
  const cutoff = ctx.occurredAt - SIX_HOURS_MS;
  const recentActivity = ctx.recentEntries.filter((e) => e.occurred_at >= cutoff);
  if (recentActivity.length === 0) return true;

  // (c) wheel marathon
  if (
    ctx.activity === 'wheel' &&
    ctx.durationMs !== null &&
    ctx.durationMs >= WHEEL_DURATION_THRESHOLD_MS
  ) {
    return true;
  }

  return false;
}

/**
 * Returns true when the current local minute-of-day falls within the quiet
 * window. Handles overnight wrap-around (e.g. quiet 21:00–07:00).
 */
export function isQuietHour(
  nowMs: number,
  quietStartMinute: number,
  quietEndMinute: number,
): boolean {
  const d = new Date(nowMs);
  const minuteOfDay = d.getHours() * 60 + d.getMinutes();

  if (quietStartMinute <= quietEndMinute) {
    // Same-day window: e.g. 08:00–18:00
    return minuteOfDay >= quietStartMinute && minuteOfDay < quietEndMinute;
  }
  // Overnight window: e.g. 21:00 (1260) – 07:00 (420)
  return minuteOfDay >= quietStartMinute || minuteOfDay < quietEndMinute;
}

// ---------------------------------------------------------------------------
// Entry-point called by narrator after each diary write
// ---------------------------------------------------------------------------

export interface EvaluatePushDeps extends SendPushDeps {
  now?: () => number;
}

/**
 * Evaluate whether any subscribed users should receive a push for the given
 * diary entry. Designed to be called after every narrator write.
 *
 * Skips: timelapse, recap, snapshot entries.
 * All errors are swallowed — narrator path must never throw from here.
 */
export async function evaluatePushForEntry(
  entry: db.DiaryEntryRow,
  deps: EvaluatePushDeps = {},
): Promise<void> {
  const nowFn = deps.now ?? (() => Date.now());

  if (entry.kind === 'timelapse' || entry.kind === 'recap' || entry.activity === 'snapshot') {
    return;
  }

  try {
    const allUsers = db.listUsers();
    const nowMs = nowFn();
    const dayStart = startOfLocalDay(new Date(nowMs));

    // Fetch entries once for rare-event evaluation (shared across users).
    const recentEntries = db.listDiaryEntriesBetween(
      nowMs - 6 * 60 * 60 * 1000,
      nowMs + 1,
    );

    for (const user of allUsers) {
      await evaluatePushForUser(user.id, entry, nowMs, dayStart, recentEntries, deps);
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, entry_id: entry.id }, 'evaluatePushForEntry failed');
  }
}

async function evaluatePushForUser(
  userId: number,
  entry: db.DiaryEntryRow,
  nowMs: number,
  dayStart: number,
  recentEntries: db.DiaryEntryRow[],
  deps: EvaluatePushDeps,
): Promise<void> {
  const prefs = db.getNotificationPreferences(userId);

  if (!prefs.enabled) return;

  if (isQuietHour(nowMs, prefs.quiet_start_minute, prefs.quiet_end_minute)) return;

  const activity = entry.activity;
  if (!activity) return;

  let allowedActivities: string[];
  try {
    const parsed = JSON.parse(prefs.activities) as unknown;
    allowedActivities = Array.isArray(parsed)
      ? parsed.filter((a): a is string => typeof a === 'string')
      : [];
  } catch {
    allowedActivities = [];
  }

  if (!allowedActivities.includes(activity)) return;

  if (prefs.rare_only) {
    const rare = isRareEvent({
      activity,
      durationMs: entry.duration_ms,
      occurredAt: entry.occurred_at,
      dayStart,
      recentEntries,
    });
    if (!rare) return;
  }

  const petName = db.getSetting('pet_name') ?? 'Your hamster';
  await sendPushToUser(
    userId,
    {
      title: petName,
      body: entry.narrative,
      url: '/',
      tag: `activity-${activity}`,
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfLocalDay(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}
