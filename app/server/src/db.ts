// app/server/src/db.ts
// better-sqlite3 connection + prepared-statement data-access layer.
// Every table read/write the rest of the backend will ever need is named and
// exported from here so business logic in higher layers stays SQL-free.
//
// Statements are prepared lazily once at first use of `getDb()` — re-running
// migrations against the same path inside a single process is supported by
// resetting the cached handle (used by tests).

import Database from 'better-sqlite3';

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
  position: number;
  enabled: 0 | 1;
  created_at: number;
}

export interface SnapshotRow {
  id: number;
  camera_id: number;
  taken_at: number;
  path: string;
}

export type DiaryKind = 'narrative' | 'snapshot' | 'timelapse';
export type DiaryActivity =
  | 'wheel'
  | 'food'
  | 'water'
  | 'bathroom'
  | 'resting'
  | 'exploring'
  | 'hiding'
  | 'transition'
  | 'snapshot'
  | 'timelapse';

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
}

export interface BadgeRow {
  badge_id: string;
  earned_at: number;
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

/** Test helper — closes & forgets the cached handle. */
export function resetDbForTests(): void {
  if (cached) {
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
  userInsert: Database.Statement;
  userUpdate: Database.Statement;
  userDelete: Database.Statement;
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
  cameraDelete: Database.Statement;
  cameraSetPosition: Database.Statement;
  cameraMaxPosition: Database.Statement;
  // snapshots
  snapshotInsert: Database.Statement;
  snapshotById: Database.Statement;
  snapshotListByCamera: Database.Statement;
  snapshotListByDay: Database.Statement;
  snapshotDeleteOlderThan: Database.Statement;
  snapshotCountSince: Database.Statement;
  // diary
  diaryInsert: Database.Statement;
  diaryById: Database.Statement;
  diaryListBetween: Database.Statement;
  diaryListByKindBetween: Database.Statement;
  diaryUpsertTimelapseForDate: Database.Statement;
  diaryDeleteOlderThan: Database.Statement;
  diaryClearMediaOlderThan: Database.Statement;
  // badges
  badgeInsert: Database.Statement;
  badgeList: Database.Statement;
  badgeHas: Database.Statement;
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
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
    userByZyphrId: db.prepare('SELECT * FROM users WHERE zyphr_user_id = ?'),
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
    userDelete: db.prepare('DELETE FROM users WHERE id = ?'),
    userList: db.prepare(
      'SELECT * FROM users ORDER BY role DESC, display_name COLLATE NOCASE ASC',
    ),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    userAdminCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
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
      INSERT INTO cameras (name, emoji, stream_url, position, enabled, created_at)
      VALUES (@name, @emoji, @stream_url, @position, @enabled, @created_at)
    `),
    cameraUpdate: db.prepare(`
      UPDATE cameras
         SET name       = @name,
             emoji      = @emoji,
             stream_url = @stream_url,
             enabled    = @enabled
       WHERE id = @id
    `),
    cameraDelete: db.prepare('DELETE FROM cameras WHERE id = ?'),
    cameraSetPosition: db.prepare('UPDATE cameras SET position = ? WHERE id = ?'),
    cameraMaxPosition: db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM cameras'),

    // snapshots --------------------------------------------------------
    snapshotInsert: db.prepare(`
      INSERT INTO snapshots (camera_id, taken_at, path)
      VALUES (@camera_id, @taken_at, @path)
    `),
    snapshotById: db.prepare('SELECT * FROM snapshots WHERE id = ?'),
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
    snapshotDeleteOlderThan: db.prepare('DELETE FROM snapshots WHERE taken_at < ?'),
    snapshotCountSince: db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE taken_at >= ?'),

    // diary ------------------------------------------------------------
    diaryInsert: db.prepare(`
      INSERT INTO diary_entries (
        occurred_at, kind, activity, narrative, pet_name,
        camera_id, from_camera_id, to_camera_id,
        duration_ms, snapshot_id, media_path, details
      ) VALUES (
        @occurred_at, @kind, @activity, @narrative, @pet_name,
        @camera_id, @from_camera_id, @to_camera_id,
        @duration_ms, @snapshot_id, @media_path, @details
      )
    `),
    diaryById: db.prepare('SELECT * FROM diary_entries WHERE id = ?'),
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
    diaryDeleteOlderThan: db.prepare(
      "DELETE FROM diary_entries WHERE kind = 'snapshot' AND occurred_at < ?",
    ),
    diaryClearMediaOlderThan: db.prepare(`
      UPDATE diary_entries
         SET media_path = NULL
       WHERE kind = 'timelapse' AND occurred_at < ?
    `),

    // badges -----------------------------------------------------------
    badgeInsert: db.prepare(
      'INSERT OR IGNORE INTO badges_earned (badge_id, earned_at) VALUES (?, ?)',
    ),
    badgeList: db.prepare('SELECT * FROM badges_earned ORDER BY earned_at DESC'),
    badgeHas: db.prepare('SELECT 1 AS hit FROM badges_earned WHERE badge_id = ?'),

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

export function deleteUser(id: number): void {
  statements().userDelete.run(id);
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

export function getCameraById(id: number): CameraRow | null {
  return (statements().cameraById.get(id) as CameraRow | undefined) ?? null;
}

export function listCameras(includeDisabled: boolean = true): CameraRow[] {
  return includeDisabled
    ? (statements().cameraList.all() as CameraRow[])
    : (statements().cameraListEnabled.all() as CameraRow[]);
}

export interface CreateCameraInput {
  name: string;
  emoji: string;
  stream_url: string;
  enabled: boolean;
}

export function createCamera(input: CreateCameraInput): CameraRow {
  const max = statements().cameraMaxPosition.get() as { p: number };
  const position = max.p + 1;
  const result = statements().cameraInsert.run({
    name: input.name,
    emoji: input.emoji,
    stream_url: input.stream_url,
    position,
    enabled: input.enabled ? 1 : 0,
    created_at: Date.now(),
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
  enabled: boolean;
}

export function updateCamera(input: UpdateCameraInput): CameraRow | null {
  statements().cameraUpdate.run({
    id: input.id,
    name: input.name,
    emoji: input.emoji,
    stream_url: input.stream_url,
    enabled: input.enabled ? 1 : 0,
  });
  return getCameraById(input.id);
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

export function deleteSnapshotsOlderThan(cutoffMs: number): number {
  const info = statements().snapshotDeleteOlderThan.run(cutoffMs);
  return info.changes;
}

export function countSnapshotsSince(sinceMs: number): number {
  const row = statements().snapshotCountSince.get(sinceMs) as { n: number };
  return row.n;
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
}

export function createDiaryEntry(input: CreateDiaryEntryInput): DiaryEntryRow {
  const result = statements().diaryInsert.run(input);
  const id = Number(result.lastInsertRowid);
  const row = statements().diaryById.get(id) as DiaryEntryRow | undefined;
  if (!row) throw new Error(`createDiaryEntry: row ${id} not found immediately after insert`);
  return row;
}

export function getDiaryEntryById(id: number): DiaryEntryRow | null {
  return (statements().diaryById.get(id) as DiaryEntryRow | undefined) ?? null;
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

export function deleteOldSnapshotDiaryEntries(cutoffMs: number): number {
  const info = statements().diaryDeleteOlderThan.run(cutoffMs);
  return info.changes;
}

export function clearOldTimelapseMedia(cutoffMs: number): number {
  const info = statements().diaryClearMediaOlderThan.run(cutoffMs);
  return info.changes;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export function earnBadge(badgeId: string, when: number = Date.now()): boolean {
  const info = statements().badgeInsert.run(badgeId, when);
  return info.changes > 0;
}

export function listBadges(): BadgeRow[] {
  return statements().badgeList.all() as BadgeRow[];
}

export function hasBadge(badgeId: string): boolean {
  return statements().badgeHas.get(badgeId) !== undefined;
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
