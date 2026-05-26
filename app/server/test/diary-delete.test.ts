// Tests for activity.delete tRPC mutation.
//
// Authorization matrix:
//   1. Admin can delete any diary entry kind (narrative, timelapse, snapshot).
//   2. Non-admin (child) can delete a snapshot they own (created_by === self).
//   3. Non-admin cannot delete a snapshot they do NOT own → FORBIDDEN.
//   4. Non-admin cannot delete a non-snapshot entry → FORBIDDEN.
//   5. Missing entry → NOT_FOUND.
//   6. Deleting a snapshot entry unlinks the media file and removes the
//      snapshots table row.

import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'hamster-diary-del-'));
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

async function makeCtx(role: 'admin' | 'child') {
  const db = await import('../src/db.js');
  const user = db.createUser({
    zyphr_user_id: `zy_${role}_user`,
    email: `${role}@example.com`,
    display_name: role === 'admin' ? 'Admin User' : 'Child User',
    role,
    created_by: null,
  });
  return {
    user,
    sessionId: 'fake-session',
    req: {} as never,
    res: {} as never,
    audit: {} as Record<string, unknown>,
  };
}

async function insertSnapshotDiaryEntry(opts: {
  createdBy: number | null;
  mediaPath: string;
}): Promise<{ diaryId: number; snapshotId: number }> {
  const db = await import('../src/db.js');
  // Create a camera first (diary entries reference cameras).
  const cam = db.createCamera({
    name: 'test-cam',
    emoji: '📷',
    stream_url: 'rtsp://test/cam',
    enabled: true,
  });
  const snap = db.createSnapshot({
    camera_id: cam.id,
    taken_at: Date.now(),
    path: opts.mediaPath,
  });
  const entry = db.createDiaryEntry({
    occurred_at: Date.now(),
    kind: 'snapshot',
    activity: 'snapshot',
    narrative: 'test snap',
    pet_name: null,
    camera_id: cam.id,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: null,
    snapshot_id: snap.id,
    media_path: opts.mediaPath,
    details: null,
    created_by: opts.createdBy,
  });
  return { diaryId: entry.id, snapshotId: snap.id };
}

async function insertNarrativeDiaryEntry(): Promise<number> {
  const db = await import('../src/db.js');
  const cam = db.createCamera({
    name: 'narr-cam',
    emoji: '🎡',
    stream_url: 'rtsp://test/narr',
    enabled: true,
  });
  const entry = db.createDiaryEntry({
    occurred_at: Date.now(),
    kind: 'narrative',
    activity: 'wheel',
    narrative: 'Remy went for a run',
    pet_name: 'Remy',
    camera_id: cam.id,
    from_camera_id: null,
    to_camera_id: null,
    duration_ms: 30000,
    snapshot_id: null,
    media_path: null,
    details: null,
    created_by: null,
  });
  return entry.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('activity.delete', () => {
  it('returns NOT_FOUND for a non-existent diary entry id', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const ctx = await makeCtx('admin');
    const caller = appRouter.createCaller(ctx);
    await expect(caller.activity.delete({ id: 999999 })).rejects.toThrow(
      /NOT_FOUND|diary entry not found/i,
    );
  });

  it('admin can delete a narrative (auto-generated) entry', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const ctx = await makeCtx('admin');
    const diaryId = await insertNarrativeDiaryEntry();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.activity.delete({ id: diaryId });
    expect(result.ok).toBe(true);
    expect(db.getDiaryEntryById(diaryId)).toBeNull();
  });

  it('admin can delete a snapshot entry owned by someone else', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const adminCtx = await makeCtx('admin');
    // Create a separate child user and assign ownership.
    const child = db.createUser({
      zyphr_user_id: 'zy_other_child',
      email: 'other@example.com',
      display_name: 'Other',
      role: 'child',
      created_by: adminCtx.user.id,
    });
    const mediaPath = 'snapshots/test-snap.jpg';
    const { diaryId } = await insertSnapshotDiaryEntry({
      createdBy: child.id,
      mediaPath,
    });

    const caller = appRouter.createCaller(adminCtx);
    const result = await caller.activity.delete({ id: diaryId });
    expect(result.ok).toBe(true);
    expect(db.getDiaryEntryById(diaryId)).toBeNull();
  });

  it('non-admin can delete their own snapshot entry', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const childCtx = await makeCtx('child');
    const mediaPath = 'snapshots/mine.jpg';
    const { diaryId, snapshotId } = await insertSnapshotDiaryEntry({
      createdBy: childCtx.user.id,
      mediaPath,
    });

    const caller = appRouter.createCaller(childCtx);
    const result = await caller.activity.delete({ id: diaryId });
    expect(result.ok).toBe(true);
    expect(db.getDiaryEntryById(diaryId)).toBeNull();
    // Snapshots row should also be gone.
    expect(db.getSnapshotById(snapshotId)).toBeNull();
  });

  it('non-admin is FORBIDDEN from deleting another user\'s snapshot', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const adminCtx = await makeCtx('admin');
    const childCtx = {
      user: db.createUser({
        zyphr_user_id: 'zy_intruder',
        email: 'intruder@example.com',
        display_name: 'Intruder',
        role: 'child',
        created_by: adminCtx.user.id,
      }),
      sessionId: 'fake',
      req: {} as never,
      res: {} as never,
      audit: {} as Record<string, unknown>,
    };
    // Snapshot owned by a DIFFERENT user (null = system).
    const { diaryId } = await insertSnapshotDiaryEntry({
      createdBy: adminCtx.user.id,
      mediaPath: 'snapshots/not-mine.jpg',
    });

    const caller = appRouter.createCaller(childCtx);
    await expect(caller.activity.delete({ id: diaryId })).rejects.toThrow(
      /FORBIDDEN|only delete your own snapshots/i,
    );
  });

  it('non-admin is FORBIDDEN from deleting a narrative entry', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const childCtx = await makeCtx('child');
    const diaryId = await insertNarrativeDiaryEntry();

    const caller = appRouter.createCaller(childCtx);
    await expect(caller.activity.delete({ id: diaryId })).rejects.toThrow(
      /FORBIDDEN|only delete your own snapshots/i,
    );
  });

  it('deleting a snapshot entry unlinks the media file from disk', async () => {
    const { appRouter } = await import('../src/trpc.js');
    // Create the actual file so unlink has something to remove.
    const snapsDir = join(workdir, 'snapshots');
    mkdirSync(snapsDir, { recursive: true });
    const fileName = 'snapshots/disk-file.jpg';
    const absPath = join(workdir, fileName);
    writeFileSync(absPath, 'fake jpeg data');
    expect(existsSync(absPath)).toBe(true);

    const childCtx = await makeCtx('child');
    const { diaryId } = await insertSnapshotDiaryEntry({
      createdBy: childCtx.user.id,
      mediaPath: fileName,
    });

    const caller = appRouter.createCaller(childCtx);
    await caller.activity.delete({ id: diaryId });

    expect(existsSync(absPath)).toBe(false);
  });

  it('unlink of already-missing file does not throw (ENOENT is swallowed)', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const childCtx = await makeCtx('child');
    // Media path does NOT exist on disk — we just don't create the file.
    const { diaryId } = await insertSnapshotDiaryEntry({
      createdBy: childCtx.user.id,
      mediaPath: 'snapshots/ghost.jpg',
    });

    const caller = appRouter.createCaller(childCtx);
    // Should resolve cleanly without throwing.
    await expect(caller.activity.delete({ id: diaryId })).resolves.toEqual({ ok: true });
  });

  it('writes an audit log row for non-admin deletion', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const childCtx = await makeCtx('child');
    const { diaryId } = await insertSnapshotDiaryEntry({
      createdBy: childCtx.user.id,
      mediaPath: 'snapshots/audit-test.jpg',
    });

    const caller = appRouter.createCaller(childCtx);
    await caller.activity.delete({ id: diaryId });

    const auditRows = db.listAudit({ action_prefix: 'diary.delete' });
    expect(auditRows.length).toBe(1);
    const row = auditRows[0];
    expect(row).toBeDefined();
    expect(row?.actor_user_id).toBe(childCtx.user.id);
    expect(row?.action).toBe('diary.delete');
    expect(row?.target_id).toBe(String(diaryId));
    const details = JSON.parse(row?.details ?? '{}') as Record<string, unknown>;
    expect(details['was_admin']).toBe(false);
    expect(details['kind']).toBe('snapshot');
  });

  it('writes an audit log row for admin deletion', async () => {
    const { appRouter } = await import('../src/trpc.js');
    const db = await import('../src/db.js');
    const adminCtx = await makeCtx('admin');
    const diaryId = await insertNarrativeDiaryEntry();

    const caller = appRouter.createCaller(adminCtx);
    await caller.activity.delete({ id: diaryId });

    const auditRows = db.listAudit({ action_prefix: 'diary.delete' });
    expect(auditRows.length).toBe(1);
    const row = auditRows[0];
    expect(row?.actor_user_id).toBe(adminCtx.user.id);
    const details = JSON.parse(row?.details ?? '{}') as Record<string, unknown>;
    expect(details['was_admin']).toBe(true);
    expect(details['kind']).toBe('narrative');
  });
});
