// app/server/src/db.ts
// better-sqlite3 connection + prepared-statement data-access layer.
// Every table read/write the rest of the backend will ever need is named and
// exported from here so business logic in higher layers stays SQL-free.
//
// Statements are prepared lazily once at first use of `getDb()` — re-running
// migrations against the same path inside a single process is supported by
// resetting the cached handle (used by tests).

import Database from 'better-sqlite3';

import { emitDiaryEvent } from './diary-events.js';
import { migrate } from './migrate.js';

// ---------------------------------------------------------------------------
// Domain types — these flow into tRPC outputs and frontend types via inference.
// ---------------------------------------------------------------------------

export type UserRole = 'admin' | 'child';

export interface UserRow {
  id: number;
  zyphr_user_id: string;
  email: string;
  display_name: string;
  role: UserRole;
  created_at: number;
  last_seen_at: number;
  created_by: number | null;
  /** Epoch-ms when the user was soft-deleted. NULL means the account is active. */
  deleted_at: number | null;
}

export interface PublicUser {
  id: number;
  email: string;
  display_name: string;
  role: UserRole;
  created_at: number;
  last_seen_at: number;
}

export interface SessionRow {
  id: string;
  user_id: number;
  zyphr_refresh_token: string | null;
  created_at: number;
  expires_at: number;
  user_agent: string | null;
}

export interface CameraRow {
  id: number;
  name: string;
  emoji: string;
  stream_url: string;
  /** go2rtc stream name — drives the /live/ws?src=<name> proxy. Null until set by operator. */
  live_src: string | null;
  position: number;
  enabled: 0 | 1;
  created_at: number;
  /** Operator-configured zone keywords for this camera (matches narrator vocabulary). */
  zones: string[];
  /** Whether optical-mark wheel odometry is active for this camera. */
  wheel_mark_enabled: 0 | 1;
  /** Physical wheel diameter in millimetres — used to convert rotations → metres. */
  wheel_diameter_mm: number;
  /** Left edge of the ROI box as a percentage of frame width (0–100). */
  wheel_band_x_pct: number;
  /** ROI box width as a percentage of frame width (0–100). */
  wheel_band_width_pct: number;
  /** Centre of the sampling band as a percentage of frame height (0–100). */
  wheel_band_y_pct: number;
  /** Sampling band height as a percentage of frame height (0–100). */
  wheel_band_height_pct: number;
  /** Pixels with mean intensity below `255 * (1 − threshold_pct/100)` are "dark" (0–100). */
  wheel_threshold_pct: number;
}

export interface SnapshotRow {
  id: number;
  camera_id: number;
  taken_at: number;
  path: string;
}

export type DiaryKind = 'narrative' | 'snapshot' | 'timelapse' | 'recap';
export type DiaryActivity =
  | 'wheel'
  | 'food'
  | 'water'
  | 'bathroom'
  | 'resting'
  | 'tunnel'
  | 'exploring'
  | 'hiding'
  | 'transition'
  | 'snapshot'
  | 'timelapse'
  | 'recap';

export interface DiaryEntryRow {
  id: number;
  occurred_at: number;
  kind: DiaryKind;
  activity: DiaryActivity | null;
  narrative: string;
  pet_name: string | null;
  camera_id: number | null;
  from_camera_id: number | null;
  to_camera_id: number | null;
  duration_ms: number | null;
  snapshot_id: number | null;
  media_path: string | null;
  details: string | null;
  ai_model: string | null;
  /** User who triggered this entry manually. NULL for auto-generated entries. */
  created_by: number | null;
  /** Relative path under STORAGE_PATH to a downscaled ~480px JPEG thumbnail. */
  thumbnail_path: string | null;
  /** Relative path under STORAGE_PATH to a cached extracted MP4 clip. */
  clip_path: string | null;
  /** How many times the backfill job has attempted (and failed transiently) to generate media. */
  media_backfill_attempts: number;
  /** Last error message from a backfill attempt — null until the first failure. */
  media_backfill_last_error: string | null;
  /** 0/1 flag: when 1 the entry is excluded from future backfill runs (permanent give-up). */
  media_unavailable: 0 | 1;
}

export interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: number;
}

export interface NotificationPreferencesRow {
  user_id: number;
  enabled: 0 | 1;
  activities: string;
  quiet_start_minute: number;
  quiet_end_minute: number;
  rare_only: 0 | 1;
}

export interface BadgeRow {
  id: number;
  badge_id: string;
  earned_at: number;
  earned_day: string;
}

export interface BadgeSummaryRow {
  badge_id: string;
  count: number;
  first_earned_at: number;
  last_earned_at: number;
}

export interface AuditLogRow {
  id: number;
  actor_user_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: string | null;
  at: number;
}

export interface ShareRecipientRow {
  id: number;
  display_name: string;
  email: string;
  added_by: number | null;
  created_at: number;
}

export type ShareStatus = 'queued' | 'sent' | 'failed';

export interface ShareLogRow {
  id: number;
  user_id: number;
  recipient_id: number;
  diary_entry_id: number;
  status: ShareStatus;
  sent_at: number | null;
  error: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

let cached: { db: Database.Database; path: string } | null = null;

/** Get (or open) the singleton DB handle. Migrations are applied on first open. */
export function getDb(dbPath?: string): Database.Database {
  if (cached) return cached.db;
  const path = dbPath ?? process.env['DATABASE_PATH'];
  if (!path) {
    throw new Error('DATABASE_PATH env var must be set before getDb() is called');
  }
  const db = migrate(path);
  cached = { db, path };
  return db;
}

/** Test helper — checkpoints WAL then closes & forgets the cached handle. */
export function resetDbForTests(): void {
  if (cached) {
    // Checkpoint the WAL before closing so macOS releases the WAL file
    // immediately. Without this, rmSync in afterEach can hit ENOTEMPTY because
    // the WAL file is still open at the OS level.
    try {
      cached.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Non-fatal — close anyway.
    }
    cached.db.close();
    cached = null;
  }
}

// ---------------------------------------------------------------------------
// Statement cache. Lazy so that getDb() can be initialized later in tests.
// ---------------------------------------------------------------------------

interface Statements {
  // settings
  settingsGetAll: Database.Statement;
  settingsGetOne: Database.Statement;
  settingsUpsert: Database.Statement;
  // users
  userById: Database.Statement;
  userByEmail: Database.Statement;
  userByZyphrId: Database.Statement;
  userDeletedByEmail: Database.Statement;
  userInsert: Database.Statement;
  userUpdate: Database.Statement;
  userSoftDelete: Database.Statement;
  userReactivate: Database.Statement;
  userList: Database.Statement;
  userCount: Database.Statement;
  userAdminCount: Database.Statement;
  userTouchLastSeen: Database.Statement;
  // sessions
  sessionById: Database.Statement;
  sessionInsert: Database.Statement;
  sessionDelete: Database.Statement;
  sessionsDeleteForUser: Database.Statement;
  sessionsDeleteExpired: Database.Statement;
  // cameras
  cameraById: Database.Statement;
  cameraList: Database.Statement;
  cameraListEnabled: Database.Statement;
  cameraInsert: Database.Statement;
  cameraUpdate: Database.Statement;
  cameraSetEnabled: Database.Statement;
  cameraDelete: Database.Statement;
  cameraSetPosition: Database.Statement;
  cameraMaxPosition: Database.Statement;
  // snapshots
  snapshotInsert: Database.Statement;
  snapshotById: Database.Statement;
  snapshotDelete: Database.Statement;
  snapshotListByCamera: Database.Statement;
  snapshotListByDay: Database.Statement;
  snapshotListByCameraAndDay: Database.Statement;
  snapshotDeleteOlderThan: Database.Statement;
  snapshotCountSince: Database.Statement;
  // diary
  diaryInsert: Database.Statement;
  diaryById: Database.Statement;
  diaryDelete: Database.Statement;
  diaryLatest: Database.Statement;
  diaryExtend: Database.Statement;
  diaryListBetween: Database.Statement;
  diaryListByKindBetween: Database.Statement;
  diaryUpsertTimelapseForDate: Database.Statement;
  diaryUpsertRecapForDate: Database.Statement;
  diaryDeleteOlderThan: Database.Statement;
  diaryClearMediaOlderThan: Database.Statement;
  diaryUpdateThumbnailPath: Database.Statement;
  diaryUpdateClipPath: Database.Statement;
  diaryUpdateDetails: Database.Statement;
  diaryUpdateBackfillAttempt: Database.Statement;
  diaryMarkMediaUnavailable: Database.Statement;
  diaryClearThumbnailOlderThan: Database.Statement;
  diaryMissingThumbnail: Database.Statement;
  // badges
  badgeInsertDaily: Database.Statement;
  badgeInsertOnce: Database.Statement;
  badgeHasAny: Database.Statement;
  badgeList: Database.Statement;
  badgeSummarize: Database.Statement;
  // audit
  auditInsert: Database.Statement;
  auditList: Database.Statement;
  auditDeleteOlderThan: Database.Statement;
  // share recipients
  recipientInsert: Database.Statement;
  recipientList: Database.Statement;
  recipientById: Database.Statement;
  recipientUpdate: Database.Statement;
  recipientDelete: Database.Statement;
  // share log
  shareInsert: Database.Statement;
  shareById: Database.Statement;
  shareUpdateStatus: Database.Statement;
  shareCountSinceForUser: Database.Statement;
  shareListForUser: Database.Statement;
  // wheel odometer — aggregate for badge evaluation + stats
  diaryWheelEntriesAll: Database.Statement;
  diaryWheelEntriesBetween: Database.Statement;
  diaryWheelEntriesGroupedByDay: Database.Statement;
  diaryWheelBestSession: Database.Statement;
  diaryWheelDurationAll: Database.Statement;
  diaryWheelDurationBetween: Database.Statement;
  // push subscriptions
  pushSubUpsert: Database.Statement;
  pushSubDeleteByEndpointForUser: Database.Statement;
  pushSubDeleteByEndpoint: Database.Statement;
  pushSubListForUser: Database.Statement;
  // notification preferences
  notifPrefsGet: Database.Statement;
  notifPrefsUpsert: Database.Statement;
  // diary activity counts (badge evaluation)
  diaryCountActivityAllTime: Database.Statement;
  diaryCountDistinctActiveDaysAllTime: Database.Statement;
  diaryCountKindAllTime: Database.Statement;
}

let statementsCache: { db: Database.Database; s: Statements } | null = null;

function statements(): Statements {
  const db = getDb();
  if (statementsCache && statementsCache.db === db) return statementsCache.s;

  const s: Statements = {
    // settings ---------------------------------------------------------
    settingsGetAll: db.prepare('SELECT key, value FROM settings'),
    settingsGetOne: db.prepare('SELECT value FROM settings WHERE key = ?'),
    settingsUpsert: db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),

    // users ------------------------------------------------------------
    // `userById` intentionally includes soft-deleted rows: audit log / history
    // lookups (actor_user_id resolution) must still resolve deleted users by id.
    // Callers that need to gate on active status check deleted_at themselves.
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    // Access-control / login paths filter to active (non-deleted) rows only.
    userByEmail: db.prepare(
      'SELECT * FROM users WHERE email = ? COLLATE NOCASE AND deleted_at IS NULL',
    ),
    userByZyphrId: db.prepare(
      'SELECT * FROM users WHERE zyphr_user_id = ? AND deleted_at IS NULL',
    ),
    // Reactivation path: find a previously-deleted row by email (deleted_at NOT NULL).
    userDeletedByEmail: db.prepare(
      'SELECT * FROM users WHERE email = ? COLLATE NOCASE AND deleted_at IS NOT NULL',
    ),
    userInsert: db.prepare(`
      INSERT INTO users (
        zyphr_user_id, email, display_name, role,
        created_at, last_seen_at, created_by
      ) VALUES (
        @zyphr_user_id, @email, @display_name, @role,
        @created_at, @last_seen_at, @created_by
      )
    `),
    userUpdate: db.prepare(`
      UPDATE users
         SET display_name = @display_name,
             role         = @role
       WHERE id = @id
    `),
    // Soft-delete: stamp deleted_at; leave all other columns intact so the
    // Zyphr account linkage (zyphr_user_id) is preserved for reactivation.
    userSoftDelete: db.prepare(
      'UPDATE users SET deleted_at = @deleted_at WHERE id = @id',
    ),
    // Reactivation: clear deleted_at and apply the new profile supplied by
    // the re-adding admin. `created_at` is refreshed so the UI shows the
    // new creation time rather than the original one.
    userReactivate: db.prepare(`
      UPDATE users
         SET deleted_at    = NULL,
             display_name  = @display_name,
             role          = @role,
             created_by    = @created_by,
             created_at    = @created_at,
             last_seen_at  = @last_seen_at
       WHERE id = @id
    `),
    // Listing and counts are restricted to active users only.
    userList: db.prepare(
      'SELECT * FROM users WHERE deleted_at IS NULL ORDER BY role DESC, display_name COLLATE NOCASE ASC',
    ),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL'),
    userAdminCount: db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND deleted_at IS NULL",
    ),
    userTouchLastSeen: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),

    // sessions ---------------------------------------------------------
    sessionById: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    sessionInsert: db.prepare(`
      INSERT INTO sessions (
        id, user_id, zyphr_refresh_token, created_at, expires_at, user_agent
      ) VALUES (
        @id, @user_id, @zyphr_refresh_token, @created_at, @expires_at, @user_agent
      )
    `),
    sessionDelete: db.prepare('DELETE FROM sessions WHERE id = ?'),
    sessionsDeleteForUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    sessionsDeleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

    // cameras ----------------------------------------------------------
    cameraById: db.prepare('SELECT * FROM cameras WHERE id = ?'),
    cameraList: db.prepare('SELECT * FROM cameras ORDER BY position ASC, id ASC'),
    cameraListEnabled: db.prepare(
      'SELECT * FROM cameras WHERE enabled = 1 ORDER BY position ASC, id ASC',
    ),
    cameraInsert: db.prepare(`
      INSERT INTO cameras (
        name, emoji, stream_url, live_src, position, enabled, created_at, zones,
        wheel_mark_enabled, wheel_diameter_mm,
        wheel_band_x_pct, wheel_band_width_pct,
        wheel_band_y_pct, wheel_band_height_pct, wheel_threshold_pct
      )
      VALUES (
        @name, @emoji, @stream_url, @live_src, @position, @enabled, @created_at, @zones,
        @wheel_mark_enabled, @wheel_diameter_mm,
        @wheel_band_x_pct, @wheel_band_width_pct,
        @wheel_band_y_pct, @wheel_band_height_pct, @wheel_threshold_pct
      )
    `),
    cameraUpdate: db.prepare(`
      UPDATE cameras
         SET name                  = @name,
             emoji                 = @emoji,
             stream_url            = @stream_url,
             live_src              = @live_src,
             enabled               = @enabled,
             zones                 = @zones,
             wheel_mark_enabled    = @wheel_mark_enabled,
             wheel_diameter_mm     = @wheel_diameter_mm,
             wheel_band_x_pct      = @wheel_band_x_pct,
             wheel_band_width_pct  = @wheel_band_width_pct,
             wheel_band_y_pct      = @wheel_band_y_pct,
             wheel_band_height_pct = @wheel_band_height_pct,
             wheel_threshold_pct   = @wheel_threshold_pct
       WHERE id = @id
    `),
    cameraSetEnabled: db.prepare('UPDATE cameras SET enabled = ? WHERE id = ?'),
    cameraDelete: db.prepare('DELETE FROM cameras WHERE id = ?'),
    cameraSetPosition: db.prepare('UPDATE cameras SET position = ? WHERE id = ?'),
    cameraMaxPosition: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM cameras'),

    // snapshots --------------------------------------------------------
    snapshotInsert: db.prepare(`
      INSERT INTO snapshots (camera_id, taken_at, path)
      VALUES (@camera_id, @taken_at, @path)
    `),
    snapshotById: db.prepare('SELECT * FROM snapshots WHERE id = ?'),
    snapshotDelete: db.prepare('DELETE FROM snapshots WHERE id = ?'),
    snapshotListByCamera: db.prepare(`
      SELECT * FROM snapshots
       WHERE camera_id = ?
       ORDER BY taken_at DESC
       LIMIT ?
    `),
    snapshotListByDay: db.prepare(`
      SELECT * FROM snapshots
       WHERE taken_at >= ? AND taken_at < ?
       ORDER BY taken_at ASC
    `),
    snapshotListByCameraAndDay: db.prepare(`
      SELECT * FROM snapshots
       WHERE camera_id = ? AND taken_at >= ? AND taken_at < ?
       ORDER BY taken_at ASC
    `),
    snapshotDeleteOlderThan: db.prepare('DELETE FROM snapshots WHERE taken_at < ?'),
    snapshotCountSince: db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE taken_at >= ?'),

    // diary ------------------------------------------------------------
    diaryInsert: db.prepare(`
      INSERT INTO diary_entries (
        occurred_at, kind, activity, narrative, pet_name,
        camera_id, from_camera_id, to_camera_id,
        duration_ms, snapshot_id, media_path, details, ai_model, created_by
      ) VALUES (
        @occurred_at, @kind, @activity, @narrative, @pet_name,
        @camera_id, @from_camera_id, @to_camera_id,
        @duration_ms, @snapshot_id, @media_path, @details, @ai_model, @created_by
      )
    `),
    diaryById: db.prepare('SELECT * FROM diary_entries WHERE id = ?'),
    diaryDelete: db.prepare('DELETE FROM diary_entries WHERE id = ?'),
    // Most recent entry by wall-clock time — backs narrator same-activity
    // coalescing (id DESC breaks ties so the truly-latest row wins).
    diaryLatest: db.prepare(
      'SELECT * FROM diary_entries ORDER BY occurred_at DESC, id DESC LIMIT 1',
    ),
    // Extend an existing entry to absorb a back-to-back same-activity visit.
    diaryExtend: db.prepare(
      'UPDATE diary_entries SET occurred_at = @occurred_at, duration_ms = @duration_ms WHERE id = @id',
    ),
    diaryListBetween: db.prepare(`
      SELECT * FROM diary_entries
       WHERE occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at DESC
    `),
    diaryListByKindBetween: db.prepare(`
      SELECT * FROM diary_entries
       WHERE kind = ? AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at DESC
    `),
    // Used by jobs/timelapse.ts to idempotently replace today's reel.
    diaryUpsertTimelapseForDate: db.prepare(`
      DELETE FROM diary_entries
       WHERE kind = 'timelapse'
         AND occurred_at >= ? AND occurred_at < ?
    `),
    // Used by jobs/recap.ts to idempotently replace today's recap.
    diaryUpsertRecapForDate: db.prepare(`
      DELETE FROM diary_entries
       WHERE kind = 'recap'
         AND occurred_at >= ? AND occurred_at < ?
    `),
    diaryDeleteOlderThan: db.prepare(
      "DELETE FROM diary_entries WHERE kind = 'snapshot' AND occurred_at < ?",
    ),
    diaryClearMediaOlderThan: db.prepare(`
      UPDATE diary_entries
         SET media_path = NULL
       WHERE kind = 'timelapse' AND occurred_at < ?
    `),
    diaryUpdateThumbnailPath: db.prepare(
      'UPDATE diary_entries SET thumbnail_path = @thumbnail_path WHERE id = @id',
    ),
    diaryUpdateClipPath: db.prepare(
      'UPDATE diary_entries SET clip_path = @clip_path WHERE id = @id',
    ),
    diaryUpdateDetails: db.prepare(
      'UPDATE diary_entries SET details = @details WHERE id = @id',
    ),
    // Backfill attempt tracking: increment the attempt counter and record the
    // last error message so operators can diagnose without log scraping.
    diaryUpdateBackfillAttempt: db.prepare(`
      UPDATE diary_entries
         SET media_backfill_attempts   = @media_backfill_attempts,
             media_backfill_last_error = @media_backfill_last_error
       WHERE id = @id
    `),
    // Terminal give-up: once set to 1 this row is excluded from all future
    // candidate queries. The last_error is also updated so the reason is visible.
    diaryMarkMediaUnavailable: db.prepare(`
      UPDATE diary_entries
         SET media_unavailable         = 1,
             media_backfill_last_error = @media_backfill_last_error
       WHERE id = @id
    `),
    // Retention helper: when the thumbnails directory is pruned the DB column
    // must be nulled out so the backfill job can regenerate those thumbnails
    // the next time the entry comes within the Frigate retention window.
    // Only clears entries that still have a thumbnail_path set — entries
    // that never had one, or that were already cleared, are unaffected.
    // Does NOT touch media_unavailable: a permanent Frigate failure that was
    // independently set on the same entry should remain respected.
    diaryClearThumbnailOlderThan: db.prepare(`
      UPDATE diary_entries
         SET thumbnail_path = NULL
       WHERE thumbnail_path IS NOT NULL
         AND occurred_at < ?
    `),
    // Backfill query: entries that lack a thumbnail, have a resolvable camera,
    // fall within the Frigate recording retention window (passed as a cutoff
    // epoch-ms via the positional parameter), and have NOT been marked as
    // permanently unavailable. Excludes 'recap' entries which never get
    // thumbnails. Newest first so recent races are fixed first.
    diaryMissingThumbnail: db.prepare(`
      SELECT * FROM diary_entries
       WHERE thumbnail_path IS NULL
         AND media_unavailable = 0
         AND kind != 'recap'
         AND occurred_at >= ?
         AND (camera_id IS NOT NULL
              OR to_camera_id IS NOT NULL
              OR from_camera_id IS NOT NULL)
       ORDER BY occurred_at DESC
       LIMIT ?
    `),

    // badges -----------------------------------------------------------
    // Daily policy: INSERT OR IGNORE on the UNIQUE(badge_id, earned_day) key.
    // The earning day is provided by the caller (derived from `when` in local time).
    badgeInsertDaily: db.prepare(
      'INSERT OR IGNORE INTO badges_earned (badge_id, earned_at, earned_day) VALUES (?, ?, ?)',
    ),
    // Once-ever policy: insert only when NO row exists for this badge_id at all.
    // Uses INSERT OR IGNORE with a WHERE NOT EXISTS guard so it stays atomic.
    badgeInsertOnce: db.prepare(`
      INSERT OR IGNORE INTO badges_earned (badge_id, earned_at, earned_day)
      SELECT ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM badges_earned WHERE badge_id = ?)
    `),
    // Check whether any row exists for a badge_id (used by earnBadge once-check).
    badgeHasAny: db.prepare('SELECT 1 AS hit FROM badges_earned WHERE badge_id = ?'),
    badgeList: db.prepare('SELECT * FROM badges_earned ORDER BY earned_at DESC'),
    badgeSummarize: db.prepare(`
      SELECT badge_id,
             COUNT(*)     AS count,
             MIN(earned_at) AS first_earned_at,
             MAX(earned_at) AS last_earned_at
        FROM badges_earned
       GROUP BY badge_id
    `),

    // audit ------------------------------------------------------------
    auditInsert: db.prepare(`
      INSERT INTO audit_log (actor_user_id, action, target_type, target_id, details, at)
      VALUES (@actor_user_id, @action, @target_type, @target_id, @details, @at)
    `),
    auditList: db.prepare(`
      SELECT * FROM audit_log
       WHERE (@actor_user_id IS NULL OR actor_user_id = @actor_user_id)
         AND (@action_prefix IS NULL OR action LIKE @action_prefix)
         AND (@since IS NULL OR at >= @since)
         AND (@until IS NULL OR at < @until)
         AND (@cursor IS NULL OR id < @cursor)
       ORDER BY id DESC
       LIMIT @limit
    `),
    auditDeleteOlderThan: db.prepare('DELETE FROM audit_log WHERE at < ?'),

    // share recipients -------------------------------------------------
    recipientInsert: db.prepare(`
      INSERT INTO share_recipients (display_name, email, added_by, created_at)
      VALUES (@display_name, @email, @added_by, @created_at)
    `),
    recipientList: db.prepare(
      'SELECT * FROM share_recipients ORDER BY display_name COLLATE NOCASE ASC',
    ),
    recipientById: db.prepare('SELECT * FROM share_recipients WHERE id = ?'),
    recipientUpdate: db.prepare(`
      UPDATE share_recipients
         SET display_name = @display_name,
             email        = @email
       WHERE id = @id
    `),
    recipientDelete: db.prepare('DELETE FROM share_recipients WHERE id = ?'),

    // share log --------------------------------------------------------
    shareInsert: db.prepare(`
      INSERT INTO share_log (
        user_id, recipient_id, diary_entry_id, status, sent_at, error, created_at
      ) VALUES (
        @user_id, @recipient_id, @diary_entry_id, @status, @sent_at, @error, @created_at
      )
    `),
    shareById: db.prepare('SELECT * FROM share_log WHERE id = ?'),
    shareUpdateStatus: db.prepare(`
      UPDATE share_log
         SET status  = @status,
             sent_at = @sent_at,
             error   = @error
       WHERE id = @id
    `),
    shareCountSinceForUser: db.prepare(`
      SELECT COUNT(*) AS n FROM share_log
       WHERE user_id = ? AND created_at >= ?
    `),
    shareListForUser: db.prepare(`
      SELECT * FROM share_log
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?
    `),

    // wheel odometer ---------------------------------------------------
    diaryWheelEntriesAll: db.prepare(`
      SELECT details FROM diary_entries
       WHERE activity = 'wheel' AND details IS NOT NULL
    `),
    diaryWheelEntriesBetween: db.prepare(`
      SELECT details FROM diary_entries
       WHERE activity = 'wheel' AND details IS NOT NULL
         AND occurred_at >= ? AND occurred_at < ?
    `),
    // Returns one row per local date (YYYY-MM-DD) summing wheel_meters for
    // sparkline / trend display. SQLite's date() uses UTC by default; we work
    // in UTC consistently — the day boundary logic in tRPC handles local-tz.
    diaryWheelEntriesGroupedByDay: db.prepare(`
      SELECT date(occurred_at / 1000, 'unixepoch') AS day,
             json_group_array(details)              AS details_arr
        FROM diary_entries
       WHERE activity = 'wheel'
         AND details IS NOT NULL
         AND occurred_at >= ?
       GROUP BY day
       ORDER BY day ASC
    `),
    // SQLite JSON_EXTRACT for best single session — returns the max
    // wheel_meters numeric value across all wheel diary entries.
    diaryWheelBestSession: db.prepare(`
      SELECT MAX(CAST(json_extract(details, '$.wheel_meters') AS REAL)) AS best
        FROM diary_entries
       WHERE activity = 'wheel'
         AND details IS NOT NULL
         AND json_extract(details, '$.wheel_meters') IS NOT NULL
    `),
    // Sum duration_ms directly from the row (not from the JSON details blob)
    // for all-time and bounded wheel-time aggregation.
    diaryWheelDurationAll: db.prepare(`
      SELECT COALESCE(SUM(duration_ms), 0) AS total_ms
        FROM diary_entries
       WHERE activity = 'wheel'
         AND duration_ms IS NOT NULL
    `),
    diaryWheelDurationBetween: db.prepare(`
      SELECT COALESCE(SUM(duration_ms), 0) AS total_ms
        FROM diary_entries
       WHERE activity = 'wheel'
         AND duration_ms IS NOT NULL
         AND occurred_at >= ? AND occurred_at < ?
    `),

    // push subscriptions -----------------------------------------------
    pushSubUpsert: db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
      VALUES (@user_id, @endpoint, @p256dh, @auth, @user_agent, @created_at)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id    = excluded.user_id,
        p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        user_agent = excluded.user_agent,
        created_at = excluded.created_at
    `),
    pushSubDeleteByEndpointForUser: db.prepare(
      'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
    ),
    pushSubDeleteByEndpoint: db.prepare(
      'DELETE FROM push_subscriptions WHERE endpoint = ?',
    ),
    pushSubListForUser: db.prepare(
      'SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC',
    ),

    // notification preferences -----------------------------------------
    notifPrefsGet: db.prepare(
      'SELECT * FROM notification_preferences WHERE user_id = ?',
    ),
    notifPrefsUpsert: db.prepare(`
      INSERT INTO notification_preferences
        (user_id, enabled, activities, quiet_start_minute, quiet_end_minute, rare_only)
      VALUES
        (@user_id, @enabled, @activities, @quiet_start_minute, @quiet_end_minute, @rare_only)
      ON CONFLICT(user_id) DO UPDATE SET
        enabled            = excluded.enabled,
        activities         = excluded.activities,
        quiet_start_minute = excluded.quiet_start_minute,
        quiet_end_minute   = excluded.quiet_end_minute,
        rare_only          = excluded.rare_only
    `),

    // diary activity counts ------------------------------------------------
    // Returns the all-time COUNT(*) for a given activity value. Used by badge
    // rules that track cumulative milestones (snack_attack, wheel_veteran).
    diaryCountActivityAllTime: db.prepare(`
      SELECT COUNT(*) AS n FROM diary_entries WHERE activity = ?
    `),
    // Counts distinct local calendar days on which any diary entry exists.
    // Uses the same localtime convention as the migration-generated earned_day:
    // date(occurred_at/1000,'unixepoch','localtime'). Used by regular/loyal_friend.
    diaryCountDistinctActiveDaysAllTime: db.prepare(`
      SELECT COUNT(DISTINCT date(occurred_at / 1000, 'unixepoch', 'localtime')) AS n
        FROM diary_entries
    `),
    // Count all diary entries of a given kind across all time. Used by
    // memory_keeper / paparazzi badge rules: only diary entries with
    // kind='snapshot' represent genuine manual snapshots — the raw `snapshots`
    // table also holds auto-captured nightly frames which must NOT count.
    diaryCountKindAllTime: db.prepare(`
      SELECT COUNT(*) AS n FROM diary_entries WHERE kind = ?
    `),
  };

  statementsCache = { db, s };
  return s;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsKV {
  [key: string]: string;
}

export function getSettings(): SettingsKV {
  const rows = statements().settingsGetAll.all() as Array<{ key: string; value: string }>;
  const out: SettingsKV = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export function getSetting(key: string): string | null {
  const row = statements().settingsGetOne.get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  statements().settingsUpsert.run(key, value);
}

export function setSettings(kv: SettingsKV): void {
  const db = getDb();
  const upsert = statements().settingsUpsert;
  const tx = db.transaction((entries: Array<[string, string]>) => {
    for (const [k, v] of entries) upsert.run(k, v);
  });
  tx(Object.entries(kv));
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function getUserById(id: number): UserRow | null {
  return (statements().userById.get(id) as UserRow | undefined) ?? null;
}

export function getUserByEmail(email: string): UserRow | null {
  return (statements().userByEmail.get(email) as UserRow | undefined) ?? null;
}

export function getUserByZyphrId(zyphrUserId: string): UserRow | null {
  return (statements().userByZyphrId.get(zyphrUserId) as UserRow | undefined) ?? null;
}

export interface CreateUserInput {
  zyphr_user_id: string;
  email: string;
  display_name: string;
  role: UserRole;
  created_by: number | null;
}

export function createUser(input: CreateUserInput): UserRow {
  const now = Date.now();
  const result = statements().userInsert.run({
    zyphr_user_id: input.zyphr_user_id,
    email: input.email,
    display_name: input.display_name,
    role: input.role,
    created_at: now,
    last_seen_at: now,
    created_by: input.created_by,
  });
  const id = Number(result.lastInsertRowid);
  const row = getUserById(id);
  if (!row) throw new Error(`createUser: row ${id} not found immediately after insert`);
  return row;
}

export interface UpdateUserInput {
  id: number;
  display_name: string;
  role: UserRole;
}

export function updateUser(input: UpdateUserInput): UserRow | null {
  statements().userUpdate.run(input);
  return getUserById(input.id);
}

/**
 * Soft-delete a user: stamps `deleted_at` so the row becomes invisible to all
 * login / listing paths while remaining resolvable by id for audit-log lookups.
 * Does NOT touch Zyphr — the Zyphr account stays live so a future re-add via
 * `reactivateUser` can re-attach to the same Zyphr account without re-registering.
 */
export function deleteUser(id: number, when: number = Date.now()): void {
  statements().userSoftDelete.run({ id, deleted_at: when });
}

/**
 * Returns a soft-deleted user row matching `email`, or null if no such deleted
 * row exists. Used by the reactivation path in `users.create` to detect that a
 * previously-deleted account can be restored rather than re-registered at Zyphr.
 */
export function getDeletedUserByEmail(email: string): UserRow | null {
  return (statements().userDeletedByEmail.get(email) as UserRow | undefined) ?? null;
}

export interface ReactivateUserInput {
  id: number;
  display_name: string;
  role: UserRole;
  created_by: number | null;
}

/**
 * Reactivate a soft-deleted user: clears `deleted_at`, applies the new profile
 * supplied by the re-adding admin, and refreshes `created_at` / `last_seen_at`.
 * The `zyphr_user_id` and `email` columns are deliberately untouched — the
 * existing Zyphr account is reused as-is.
 */
export function reactivateUser(input: ReactivateUserInput): UserRow {
  const now = Date.now();
  statements().userReactivate.run({
    id: input.id,
    display_name: input.display_name,
    role: input.role,
    created_by: input.created_by,
    created_at: now,
    last_seen_at: now,
  });
  const row = getUserById(input.id);
  if (!row) throw new Error(`reactivateUser: row ${input.id} not found after reactivation`);
  return row;
}

export function listUsers(): UserRow[] {
  return statements().userList.all() as UserRow[];
}

export function countUsers(): number {
  const row = statements().userCount.get() as { n: number };
  return row.n;
}

export function countAdmins(): number {
  const row = statements().userAdminCount.get() as { n: number };
  return row.n;
}

export function touchLastSeen(userId: number, when: number = Date.now()): void {
  statements().userTouchLastSeen.run(when, userId);
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    created_at: u.created_at,
    last_seen_at: u.last_seen_at,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  id: string;
  user_id: number;
  zyphr_refresh_token: string | null;
  user_agent: string | null;
  ttl_ms: number;
}

export function createSession(input: CreateSessionInput): SessionRow {
  const now = Date.now();
  statements().sessionInsert.run({
    id: input.id,
    user_id: input.user_id,
    zyphr_refresh_token: input.zyphr_refresh_token,
    created_at: now,
    expires_at: now + input.ttl_ms,
    user_agent: input.user_agent,
  });
  const row = statements().sessionById.get(input.id) as SessionRow | undefined;
  if (!row) throw new Error(`createSession: session ${input.id} not found after insert`);
  return row;
}

/** Returns the session row only when it exists *and* hasn't expired. */
export function getValidSession(id: string, now: number = Date.now()): SessionRow | null {
  const row = statements().sessionById.get(id) as SessionRow | undefined;
  if (!row) return null;
  if (row.expires_at < now) return null;
  return row;
}

export function deleteSession(id: string): void {
  statements().sessionDelete.run(id);
}

export function deleteSessionsForUser(userId: number): void {
  statements().sessionsDeleteForUser.run(userId);
}

export function purgeExpiredSessions(now: number = Date.now()): void {
  statements().sessionsDeleteExpired.run(now);
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

/**
 * The raw SQLite row stores `zones` as a JSON-encoded TEXT column. Every
 * camera row leaving the DB layer goes through this so callers see the
 * typed `string[]` they expect. Wheel-odometer columns are numeric and
 * have DB-layer defaults so they're always present; we still clamp them
 * defensively to avoid surprises from schema migrations on live DBs.
 */
function decodeCameraRow(raw: unknown): CameraRow {
  const r = raw as Omit<CameraRow, 'zones'> & { zones: string | null };
  let zones: string[] = [];
  if (typeof r.zones === 'string' && r.zones.length > 0) {
    try {
      const parsed = JSON.parse(r.zones) as unknown;
      if (Array.isArray(parsed)) {
        zones = parsed.filter((z): z is string => typeof z === 'string');
      }
    } catch {
      // Malformed payload — fall back to empty, log nothing (operator will
      // see "no zones" in the UI and can re-save).
    }
  }
  return {
    ...r,
    live_src: typeof r.live_src === 'string' && r.live_src.length > 0 ? r.live_src : null,
    zones,
    wheel_mark_enabled: r.wheel_mark_enabled === 1 ? 1 : 0,
    wheel_diameter_mm: typeof r.wheel_diameter_mm === 'number' ? r.wheel_diameter_mm : 152.0,
    wheel_band_x_pct: typeof r.wheel_band_x_pct === 'number' ? r.wheel_band_x_pct : 0,
    wheel_band_width_pct: typeof r.wheel_band_width_pct === 'number' ? r.wheel_band_width_pct : 100,
    wheel_band_y_pct: typeof r.wheel_band_y_pct === 'number' ? r.wheel_band_y_pct : 50.0,
    wheel_band_height_pct: typeof r.wheel_band_height_pct === 'number' ? r.wheel_band_height_pct : 10.0,
    wheel_threshold_pct: typeof r.wheel_threshold_pct === 'number' ? r.wheel_threshold_pct : 50.0,
  };
}

export function getCameraById(id: number): CameraRow | null {
  const raw = statements().cameraById.get(id);
  return raw ? decodeCameraRow(raw) : null;
}

export function listCameras(includeDisabled: boolean = true): CameraRow[] {
  const rows = includeDisabled
    ? statements().cameraList.all()
    : statements().cameraListEnabled.all();
  return rows.map((r) => decodeCameraRow(r));
}

export interface CreateCameraInput {
  name: string;
  emoji: string;
  stream_url: string;
  live_src?: string | null;
  enabled: boolean;
  zones?: string[];
  wheel_mark_enabled?: boolean;
  wheel_diameter_mm?: number;
  wheel_band_x_pct?: number;
  wheel_band_width_pct?: number;
  wheel_band_y_pct?: number;
  wheel_band_height_pct?: number;
  wheel_threshold_pct?: number;
}

export function createCamera(input: CreateCameraInput): CameraRow {
  const max = statements().cameraMaxPosition.get() as { p: number };
  const position = max.p + 1;
  const result = statements().cameraInsert.run({
    name: input.name,
    emoji: input.emoji,
    stream_url: input.stream_url,
    live_src: input.live_src ?? null,
    position,
    enabled: input.enabled ? 1 : 0,
    created_at: Date.now(),
    zones: JSON.stringify(input.zones ?? []),
    wheel_mark_enabled: input.wheel_mark_enabled ? 1 : 0,
    wheel_diameter_mm: input.wheel_diameter_mm ?? 152.0,
    wheel_band_x_pct: input.wheel_band_x_pct ?? 0,
    wheel_band_width_pct: input.wheel_band_width_pct ?? 100,
    wheel_band_y_pct: input.wheel_band_y_pct ?? 50.0,
    wheel_band_height_pct: input.wheel_band_height_pct ?? 10.0,
    wheel_threshold_pct: input.wheel_threshold_pct ?? 50.0,
  });
  const id = Number(result.lastInsertRowid);
  const row = getCameraById(id);
  if (!row) throw new Error(`createCamera: row ${id} not found immediately after insert`);
  return row;
}

export interface UpdateCameraInput {
  id: number;
  name: string;
  emoji: string;
  stream_url: string;
  live_src?: string | null;
  enabled: boolean;
  zones?: string[];
  wheel_mark_enabled?: boolean;
  wheel_diameter_mm?: number;
  wheel_band_x_pct?: number;
  wheel_band_width_pct?: number;
  wheel_band_y_pct?: number;
  wheel_band_height_pct?: number;
  wheel_threshold_pct?: number;
}

export function updateCamera(input: UpdateCameraInput): CameraRow | null {
  // For the five wheel columns, only update when the caller provides a value.
  // This requires reading the existing row so we don't lose settings that a
  // caller omitted from the partial update.
  const existing = getCameraById(input.id);
  // live_src: explicit undefined means "preserve existing"; null means "clear".
  const live_src = 'live_src' in input
    ? (input.live_src ?? null)
    : (existing?.live_src ?? null);
  statements().cameraUpdate.run({
    id: input.id,
    name: input.name,
    emoji: input.emoji,
    stream_url: input.stream_url,
    live_src,
    enabled: input.enabled ? 1 : 0,
    zones: JSON.stringify(input.zones ?? []),
    wheel_mark_enabled: input.wheel_mark_enabled !== undefined
      ? (input.wheel_mark_enabled ? 1 : 0)
      : (existing?.wheel_mark_enabled ?? 0),
    wheel_diameter_mm: input.wheel_diameter_mm ?? existing?.wheel_diameter_mm ?? 152.0,
    wheel_band_x_pct: input.wheel_band_x_pct ?? existing?.wheel_band_x_pct ?? 0,
    wheel_band_width_pct: input.wheel_band_width_pct ?? existing?.wheel_band_width_pct ?? 100,
    wheel_band_y_pct: input.wheel_band_y_pct ?? existing?.wheel_band_y_pct ?? 50.0,
    wheel_band_height_pct: input.wheel_band_height_pct ?? existing?.wheel_band_height_pct ?? 10.0,
    wheel_threshold_pct: input.wheel_threshold_pct ?? existing?.wheel_threshold_pct ?? 50.0,
  });
  return getCameraById(input.id);
}

/**
 * Toggle a camera's enabled state without touching any other column.
 * Returns the updated row, or null when no camera with the given id exists.
 */
export function setCameraEnabled(id: number, enabled: boolean): CameraRow | null {
  statements().cameraSetEnabled.run(enabled ? 1 : 0, id);
  return getCameraById(id);
}

/**
 * Returns the set of enabled cameras' live_src values that are non-null.
 * Used by the WS proxy's SSRF allowlist check so we never forward arbitrary
 * src params to go2rtc.
 */
export function listEnabledLiveSrcs(): Set<string> {
  const rows = statements().cameraListEnabled.all() as Array<{ live_src: string | null }>;
  const out = new Set<string>();
  for (const row of rows) {
    if (typeof row.live_src === 'string' && row.live_src.length > 0) {
      out.add(row.live_src);
    }
  }
  return out;
}

export function deleteCamera(id: number): void {
  statements().cameraDelete.run(id);
}

/** Reorder cameras to the provided id list. Missing ids retain their position. */
export function reorderCameras(orderedIds: number[]): void {
  const db = getDb();
  const stmt = statements().cameraSetPosition;
  const tx = db.transaction((ids: number[]) => {
    ids.forEach((id, idx) => stmt.run(idx, id));
  });
  tx(orderedIds);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export interface CreateSnapshotInput {
  camera_id: number;
  taken_at: number;
  path: string;
}

export function createSnapshot(input: CreateSnapshotInput): SnapshotRow {
  const result = statements().snapshotInsert.run(input);
  const id = Number(result.lastInsertRowid);
  const row = statements().snapshotById.get(id) as SnapshotRow | undefined;
  if (!row) throw new Error(`createSnapshot: row ${id} not found immediately after insert`);
  return row;
}

export function getSnapshotById(id: number): SnapshotRow | null {
  return (statements().snapshotById.get(id) as SnapshotRow | undefined) ?? null;
}

export function listSnapshotsByCamera(cameraId: number, limit: number = 100): SnapshotRow[] {
  return statements().snapshotListByCamera.all(cameraId, limit) as SnapshotRow[];
}

export function listSnapshotsBetween(fromMs: number, toMs: number): SnapshotRow[] {
  return statements().snapshotListByDay.all(fromMs, toMs) as SnapshotRow[];
}

export function listSnapshotsBetweenForCamera(
  cameraId: number,
  fromMs: number,
  toMs: number,
): SnapshotRow[] {
  return statements().snapshotListByCameraAndDay.all(cameraId, fromMs, toMs) as SnapshotRow[];
}

export function deleteSnapshotsOlderThan(cutoffMs: number): number {
  const info = statements().snapshotDeleteOlderThan.run(cutoffMs);
  return info.changes;
}

export function countSnapshotsSince(sinceMs: number): number {
  const row = statements().snapshotCountSince.get(sinceMs) as { n: number };
  return row.n;
}

export function deleteSnapshot(id: number): void {
  statements().snapshotDelete.run(id);
}

// ---------------------------------------------------------------------------
// Diary entries
// ---------------------------------------------------------------------------

export interface CreateDiaryEntryInput {
  occurred_at: number;
  kind: DiaryKind;
  activity: DiaryActivity | null;
  narrative: string;
  pet_name: string | null;
  camera_id: number | null;
  from_camera_id: number | null;
  to_camera_id: number | null;
  duration_ms: number | null;
  snapshot_id: number | null;
  media_path: string | null;
  details: string | null;
  ai_model?: string | null;
  /** User who triggered this entry. Omit or null for auto-generated entries. */
  created_by?: number | null;
}

export function createDiaryEntry(input: CreateDiaryEntryInput): DiaryEntryRow {
  const result = statements().diaryInsert.run({
    ...input,
    ai_model: input.ai_model ?? null,
    created_by: input.created_by ?? null,
  });
  const id = Number(result.lastInsertRowid);
  const row = statements().diaryById.get(id) as DiaryEntryRow | undefined;
  if (!row) throw new Error(`createDiaryEntry: row ${id} not found immediately after insert`);
  // Notify SSE subscribers so the diary UI can prepend the entry without
  // waiting for the next poll. Synchronous; listeners only push onto buffered
  // response streams.
  emitDiaryEvent({ kind: 'create', row });
  return row;
}

export function getDiaryEntryById(id: number): DiaryEntryRow | null {
  return (statements().diaryById.get(id) as DiaryEntryRow | undefined) ?? null;
}

/** Most recent diary entry across all kinds, or null when the diary is empty. */
export function getLatestDiaryEntry(): DiaryEntryRow | null {
  return (statements().diaryLatest.get() as DiaryEntryRow | undefined) ?? null;
}

/**
 * Extend an existing entry's span (used by the narrator to coalesce a
 * back-to-back same-activity visit into the prior entry). Only the end time
 * and duration change — the narrative sentence is preserved.
 */
export function extendDiaryEntry(
  id: number,
  occurredAt: number,
  durationMs: number | null,
): DiaryEntryRow {
  statements().diaryExtend.run({ id, occurred_at: occurredAt, duration_ms: durationMs });
  const row = statements().diaryById.get(id) as DiaryEntryRow | undefined;
  if (!row) throw new Error(`extendDiaryEntry: row ${id} not found`);
  // Same-activity coalescing produced a longer span on an existing row — push
  // the updated row so subscribers can replace their cached copy in place.
  emitDiaryEvent({ kind: 'update', row });
  return row;
}

export function deleteDiaryEntry(id: number): void {
  statements().diaryDelete.run(id);
}

export function listDiaryEntriesBetween(fromMs: number, toMs: number): DiaryEntryRow[] {
  return statements().diaryListBetween.all(fromMs, toMs) as DiaryEntryRow[];
}

export function listDiaryEntriesByKindBetween(
  kind: DiaryKind,
  fromMs: number,
  toMs: number,
): DiaryEntryRow[] {
  return statements().diaryListByKindBetween.all(kind, fromMs, toMs) as DiaryEntryRow[];
}

/** Idempotent replace: delete any timelapse rows in [from, to), insert a new one. */
export function replaceTimelapseEntry(
  dayStartMs: number,
  dayEndMs: number,
  entry: CreateDiaryEntryInput,
): DiaryEntryRow {
  const db = getDb();
  const tx = db.transaction(() => {
    statements().diaryUpsertTimelapseForDate.run(dayStartMs, dayEndMs);
    return createDiaryEntry(entry);
  });
  return tx();
}

/** Idempotent replace: delete any recap rows in [from, to), insert a new one. */
export function replaceRecapEntry(
  dayStartMs: number,
  dayEndMs: number,
  entry: CreateDiaryEntryInput,
): DiaryEntryRow {
  const db = getDb();
  const tx = db.transaction(() => {
    statements().diaryUpsertRecapForDate.run(dayStartMs, dayEndMs);
    return createDiaryEntry(entry);
  });
  return tx();
}

export function deleteOldSnapshotDiaryEntries(cutoffMs: number): number {
  const info = statements().diaryDeleteOlderThan.run(cutoffMs);
  return info.changes;
}

export function clearOldTimelapseMedia(cutoffMs: number): number {
  const info = statements().diaryClearMediaOlderThan.run(cutoffMs);
  return info.changes;
}

/**
 * Null out `thumbnail_path` for all diary entries older than `cutoffMs`.
 * Called by the retention job after it prunes the thumbnails directory so
 * the thumbnail-backfill job can regenerate those thumbnails once the entries
 * come back within the Frigate recording retention window.
 *
 * Does NOT touch `media_unavailable` — that flag may have been set by a
 * permanent Frigate clip failure on the same entry and must remain respected.
 */
export function clearOldThumbnailPaths(cutoffMs: number): number {
  const info = statements().diaryClearThumbnailOlderThan.run(cutoffMs);
  return info.changes;
}

/** Persist a generated thumbnail path onto an existing diary entry row. */
export function updateDiaryEntryThumbnailPath(id: number, relPath: string): void {
  statements().diaryUpdateThumbnailPath.run({ id, thumbnail_path: relPath });
}

/** Persist a cached clip path onto an existing diary entry row. */
export function updateDiaryEntryClipPath(id: number, relPath: string): void {
  statements().diaryUpdateClipPath.run({ id, clip_path: relPath });
}

/**
 * Overwrite the details JSON blob on an existing diary entry.
 * Used by the backfill tool to attach wheel_meters after-the-fact.
 */
export function updateDiaryEntryDetails(id: number, details: Record<string, unknown>): void {
  statements().diaryUpdateDetails.run({ id, details: JSON.stringify(details) });
}

/**
 * Increment the backfill attempt counter and record the last error text.
 * Called by the backfill job on each transient failure so progress is visible
 * to operators without requiring log scraping.
 */
export function updateDiaryEntryBackfillAttempt(
  id: number,
  attempts: number,
  lastError: string,
): void {
  statements().diaryUpdateBackfillAttempt.run({
    id,
    media_backfill_attempts: attempts,
    media_backfill_last_error: lastError,
  });
}

/**
 * Mark a diary entry as permanently media-unavailable so the backfill job
 * never visits it again. Records the reason in `media_backfill_last_error`
 * for operator visibility.
 */
export function markDiaryEntryMediaUnavailable(id: number, reason: string): void {
  statements().diaryMarkMediaUnavailable.run({
    id,
    media_backfill_last_error: reason,
  });
}

/**
 * Return diary entries that are missing a thumbnail and are candidates for
 * backfill: they have a resolvable camera, fall within the given retention
 * window (i.e. occurred_at >= retentionCutoffMs), and have NOT been marked
 * as permanently unavailable. Results are ordered newest-first so the most
 * recently-written race failures are healed first. `limit` caps the batch
 * size per job run to avoid hammering Frigate.
 */
export function listDiaryEntriesMissingThumbnail(
  retentionCutoffMs: number,
  limit: number,
): DiaryEntryRow[] {
  return statements().diaryMissingThumbnail.all(
    retentionCutoffMs,
    limit,
  ) as DiaryEntryRow[];
}

/** Shared helper: sum wheel_meters from a set of detail rows. */
function extractWheelMetersSum(rows: Array<{ details: string }>): number {
  let total = 0;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.details) as unknown;
      if (typeof parsed === 'object' && parsed !== null && 'wheel_meters' in parsed) {
        const m = (parsed as Record<string, unknown>)['wheel_meters'];
        if (typeof m === 'number' && Number.isFinite(m)) {
          total += m;
        }
      }
    } catch {
      // Malformed details — skip.
    }
  }
  return total;
}

/**
 * Sum all wheel_meters values stored in diary_entries.details across all time.
 * Used by the odometer badge rules. Details is a JSON object; we parse each
 * row and extract the numeric `wheel_meters` field.
 */
export function sumAllWheelMeters(): number {
  const rows = statements().diaryWheelEntriesAll.all() as Array<{ details: string }>;
  return extractWheelMetersSum(rows);
}

/**
 * Sum wheel_meters for diary wheel entries within a time range [fromMs, toMs).
 */
export function sumWheelMetersBetween(fromMs: number, toMs: number): number {
  const rows = statements().diaryWheelEntriesBetween.all(fromMs, toMs) as Array<{ details: string }>;
  return extractWheelMetersSum(rows);
}

export interface WheelDaySeries {
  /** YYYY-MM-DD in UTC. */
  date: string;
  meters: number;
}

/**
 * Returns one entry per UTC calendar day for the last `days` days (default 14),
 * summing wheel_meters. Days with no wheel activity are omitted (sparse series).
 */
export function listWheelMetersByDay(sinceMs: number): WheelDaySeries[] {
  const rows = statements().diaryWheelEntriesGroupedByDay.all(sinceMs) as Array<{
    day: string;
    details_arr: string;
  }>;
  const result: WheelDaySeries[] = [];
  for (const row of rows) {
    let detailsList: unknown[];
    try {
      const parsed = JSON.parse(row.details_arr) as unknown;
      detailsList = Array.isArray(parsed) ? parsed : [];
    } catch {
      detailsList = [];
    }
    let dayMeters = 0;
    for (const rawDetail of detailsList) {
      let detail: unknown;
      try {
        detail = typeof rawDetail === 'string' ? (JSON.parse(rawDetail) as unknown) : rawDetail;
      } catch {
        continue;
      }
      if (typeof detail === 'object' && detail !== null && 'wheel_meters' in detail) {
        const m = (detail as Record<string, unknown>)['wheel_meters'];
        if (typeof m === 'number' && Number.isFinite(m)) dayMeters += m;
      }
    }
    result.push({ date: row.day, meters: dayMeters });
  }
  return result;
}

/**
 * Returns the highest `wheel_meters` value from any single wheel diary entry.
 * Uses SQLite's JSON_EXTRACT for efficiency — no full table scan in JS.
 */
export function bestWheelSessionMeters(): number {
  const row = statements().diaryWheelBestSession.get() as { best: number | null };
  return typeof row.best === 'number' && Number.isFinite(row.best) ? row.best : 0;
}

/**
 * Sum all wheel diary entry `duration_ms` values across all time.
 * Returns milliseconds; treat null duration_ms rows as 0 (skipped via COALESCE).
 */
export function sumAllWheelDurationMs(): number {
  const row = statements().diaryWheelDurationAll.get() as { total_ms: number };
  return typeof row.total_ms === 'number' && Number.isFinite(row.total_ms) ? row.total_ms : 0;
}

/**
 * Sum wheel diary entry `duration_ms` within a time range [fromMs, toMs).
 * Returns milliseconds.
 */
export function sumWheelDurationMsBetween(fromMs: number, toMs: number): number {
  const row = statements().diaryWheelDurationBetween.get(fromMs, toMs) as { total_ms: number };
  return typeof row.total_ms === 'number' && Number.isFinite(row.total_ms) ? row.total_ms : 0;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/**
 * Compute the local-time calendar date string (YYYY-MM-DD) for a given
 * epoch-millisecond timestamp. Matches the SQLite `date(...,'localtime')`
 * expression used in the migration so existing rows are consistent.
 */
function epochMsToLocalDay(when: number): string {
  const d = new Date(when);
  const yyyy = d.getFullYear().toString().padStart(4, '0');
  const mm = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd = d.getDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Attempt to earn a badge.
 *
 * - repeat === 'daily': INSERT OR IGNORE on UNIQUE(badge_id, earned_day);
 *   returns true only when a row was actually inserted (i.e. not yet earned today).
 * - repeat === 'once': inserts only when no row for this badge_id exists at all;
 *   returns true on the very first earn, false on every subsequent call.
 *
 * Both paths are idempotent and prepared-statement based.
 */
export function earnBadge(
  badgeId: string,
  when: number = Date.now(),
  repeat: 'daily' | 'once' = 'once',
): boolean {
  const earnedDay = epochMsToLocalDay(when);
  if (repeat === 'daily') {
    const info = statements().badgeInsertDaily.run(badgeId, when, earnedDay);
    return info.changes > 0;
  }
  // once: guard via WHERE NOT EXISTS so it stays a single atomic statement.
  const info = statements().badgeInsertOnce.run(badgeId, when, earnedDay, badgeId);
  return info.changes > 0;
}

export function listBadges(): BadgeRow[] {
  return statements().badgeList.all() as BadgeRow[];
}

export function hasBadge(badgeId: string): boolean {
  return statements().badgeHasAny.get(badgeId) !== undefined;
}

/**
 * Aggregate view of all earned badges: one row per badge_id with the
 * cumulative count and first/last earn timestamps. Backs the tRPC
 * `badges.earned` query.
 */
export function summarizeBadges(): BadgeSummaryRow[] {
  return statements().badgeSummarize.all() as BadgeSummaryRow[];
}

/**
 * Count all diary entries of a given activity across all time. Used by
 * once-ever badge rules that track cumulative activity milestones
 * (e.g. snack_attack, wheel_veteran).
 */
export function countDiaryActivityAllTime(activity: DiaryActivity): number {
  const row = statements().diaryCountActivityAllTime.get(activity) as { n: number };
  return row.n;
}

/**
 * Count the number of distinct local calendar days on which any diary entry
 * exists. Used by the regular / loyal_friend once-ever badges.
 * The local day is computed identically to the migration-generated earned_day:
 *   date(occurred_at / 1000, 'unixepoch', 'localtime')
 */
export function countDistinctActiveDaysAllTime(): number {
  const row = statements().diaryCountDistinctActiveDaysAllTime.get() as { n: number };
  return row.n;
}

/**
 * Count all diary entries of a given kind across all time.
 *
 * Use this (not the raw `snapshots` table) when evaluating snapshot-based
 * badge rules. Diary entries with kind='snapshot' are written exclusively by
 * `saveManualSnapshot` — so this count reflects only genuine operator-triggered
 * snapshots. The `snapshots` table also holds auto-captured nightly frames
 * (written by the snapshot-capture job) which must NOT count toward badges.
 */
export function countDiaryKindAllTime(kind: DiaryKind): number {
  const row = statements().diaryCountKindAllTime.get(kind) as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface InsertAuditInput {
  actor_user_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: unknown;
}

export function insertAudit(input: InsertAuditInput): void {
  statements().auditInsert.run({
    actor_user_id: input.actor_user_id,
    action: input.action,
    target_type: input.target_type,
    target_id: input.target_id,
    details: input.details === undefined || input.details === null
      ? null
      : JSON.stringify(input.details),
    at: Date.now(),
  });
}

export interface AuditListQuery {
  cursor?: number | null;
  limit?: number;
  actor_user_id?: number | null;
  action_prefix?: string | null;
  since?: number | null;
  until?: number | null;
}

export function listAudit(q: AuditListQuery = {}): AuditLogRow[] {
  return statements().auditList.all({
    cursor: q.cursor ?? null,
    limit: q.limit ?? 50,
    actor_user_id: q.actor_user_id ?? null,
    action_prefix: q.action_prefix ? `${q.action_prefix}%` : null,
    since: q.since ?? null,
    until: q.until ?? null,
  }) as AuditLogRow[];
}

export function deleteAuditOlderThan(cutoffMs: number): number {
  const info = statements().auditDeleteOlderThan.run(cutoffMs);
  return info.changes;
}

// ---------------------------------------------------------------------------
// Share recipients
// ---------------------------------------------------------------------------

export interface CreateShareRecipientInput {
  display_name: string;
  email: string;
  added_by: number | null;
}

export function createShareRecipient(input: CreateShareRecipientInput): ShareRecipientRow {
  const result = statements().recipientInsert.run({
    display_name: input.display_name,
    email: input.email,
    added_by: input.added_by,
    created_at: Date.now(),
  });
  const id = Number(result.lastInsertRowid);
  const row = getShareRecipientById(id);
  if (!row) {
    throw new Error(`createShareRecipient: row ${id} not found immediately after insert`);
  }
  return row;
}

export function getShareRecipientById(id: number): ShareRecipientRow | null {
  return (statements().recipientById.get(id) as ShareRecipientRow | undefined) ?? null;
}

export function listShareRecipients(): ShareRecipientRow[] {
  return statements().recipientList.all() as ShareRecipientRow[];
}

export interface UpdateShareRecipientInput {
  id: number;
  display_name: string;
  email: string;
}

export function updateShareRecipient(input: UpdateShareRecipientInput): ShareRecipientRow | null {
  statements().recipientUpdate.run(input);
  return getShareRecipientById(input.id);
}

export function deleteShareRecipient(id: number): void {
  statements().recipientDelete.run(id);
}

// ---------------------------------------------------------------------------
// Share log
// ---------------------------------------------------------------------------

export interface CreateShareLogInput {
  user_id: number;
  recipient_id: number;
  diary_entry_id: number;
  status: ShareStatus;
}

export function createShareLog(input: CreateShareLogInput): ShareLogRow {
  const now = Date.now();
  const result = statements().shareInsert.run({
    user_id: input.user_id,
    recipient_id: input.recipient_id,
    diary_entry_id: input.diary_entry_id,
    status: input.status,
    sent_at: null,
    error: null,
    created_at: now,
  });
  const id = Number(result.lastInsertRowid);
  const row = getShareLogById(id);
  if (!row) throw new Error(`createShareLog: row ${id} not found immediately after insert`);
  return row;
}

export function getShareLogById(id: number): ShareLogRow | null {
  return (statements().shareById.get(id) as ShareLogRow | undefined) ?? null;
}

export interface UpdateShareLogStatusInput {
  id: number;
  status: ShareStatus;
  sent_at: number | null;
  error: string | null;
}

export function updateShareLogStatus(input: UpdateShareLogStatusInput): ShareLogRow | null {
  statements().shareUpdateStatus.run(input);
  return getShareLogById(input.id);
}

export function countShareLogSinceForUser(userId: number, sinceMs: number): number {
  const row = statements().shareCountSinceForUser.get(userId, sinceMs) as { n: number };
  return row.n;
}

export function listShareLogForUser(userId: number, limit: number = 50): ShareLogRow[] {
  return statements().shareListForUser.all(userId, limit) as ShareLogRow[];
}

// ---------------------------------------------------------------------------
// Push subscriptions
// ---------------------------------------------------------------------------

export interface UpsertPushSubscriptionInput {
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
}

export function upsertPushSubscription(input: UpsertPushSubscriptionInput): PushSubscriptionRow {
  const now = Date.now();
  statements().pushSubUpsert.run({ ...input, created_at: now });
  const row = statements().pushSubListForUser.all(input.user_id).find(
    (r) => (r as PushSubscriptionRow).endpoint === input.endpoint,
  ) as PushSubscriptionRow | undefined;
  if (!row) throw new Error('upsertPushSubscription: row not found after upsert');
  return row;
}

export function deletePushSubscription(endpoint: string, userId: number): number {
  const info = statements().pushSubDeleteByEndpointForUser.run(endpoint, userId);
  return info.changes;
}

export function deletePushSubscriptionByEndpoint(endpoint: string): number {
  const info = statements().pushSubDeleteByEndpoint.run(endpoint);
  return info.changes;
}

export function listPushSubscriptionsForUser(userId: number): PushSubscriptionRow[] {
  return statements().pushSubListForUser.all(userId) as PushSubscriptionRow[];
}

// ---------------------------------------------------------------------------
// Notification preferences
// ---------------------------------------------------------------------------

const DEFAULT_NOTIF_PREFS: Omit<NotificationPreferencesRow, 'user_id'> = {
  enabled: 1,
  activities: '["wheel","food","water","resting","hiding"]',
  quiet_start_minute: 1260,
  quiet_end_minute: 420,
  rare_only: 1,
};

export function getNotificationPreferences(userId: number): NotificationPreferencesRow {
  const row = statements().notifPrefsGet.get(userId) as NotificationPreferencesRow | undefined;
  if (row) return row;
  // Create with defaults on first access.
  upsertNotificationPreferences({ ...DEFAULT_NOTIF_PREFS, user_id: userId });
  const created = statements().notifPrefsGet.get(userId) as NotificationPreferencesRow | undefined;
  if (!created) throw new Error(`getNotificationPreferences: row for user ${userId} not found`);
  return created;
}

export interface UpsertNotificationPreferencesInput {
  user_id: number;
  enabled: 0 | 1;
  activities: string;
  quiet_start_minute: number;
  quiet_end_minute: number;
  rare_only: 0 | 1;
}

export function upsertNotificationPreferences(
  input: UpsertNotificationPreferencesInput,
): NotificationPreferencesRow {
  statements().notifPrefsUpsert.run(input);
  const row = statements().notifPrefsGet.get(input.user_id) as NotificationPreferencesRow | undefined;
  if (!row) throw new Error(`upsertNotificationPreferences: row for user ${input.user_id} not found`);
  return row;
}
