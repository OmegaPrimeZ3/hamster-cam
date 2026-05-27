// Badge engine — rule-by-rule, plus idempotent re-run.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-badges-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
});

afterEach(async () => {
  const db = await import('../src/db.js');
  const { resetConfigForTests } = await import('../src/config.js');
  db.resetDbForTests();
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

interface SeedActivity {
  activity: import('../src/db.js').DiaryActivity;
  occurred_at: number;
  duration_ms?: number;
  camera_id?: number | null;
  details?: string | null;
}

async function seed(entries: SeedActivity[]): Promise<void> {
  const db = await import('../src/db.js');
  for (const e of entries) {
    db.createDiaryEntry({
      occurred_at: e.occurred_at,
      kind: 'narrative',
      activity: e.activity,
      narrative: `${e.activity} sentence`,
      pet_name: 'Peanut',
      camera_id: e.camera_id ?? null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: e.duration_ms ?? 0,
      snapshot_id: null,
      media_path: null,
      details: e.details ?? null,
    });
  }
}

function startOfLocalDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

describe('badges', () => {
  it('marathon — earns when wheel time ≥ 10 min', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed([
      { activity: 'wheel', occurred_at: start + 1, duration_ms: 6 * 60_000 },
      { activity: 'wheel', occurred_at: start + 2, duration_ms: 5 * 60_000 },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('marathon');
  });

  it('marathon — does NOT earn when wheel time < 10 min (9 min)', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed([
      { activity: 'wheel', occurred_at: start + 1, duration_ms: 9 * 60_000 },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('marathon');
  });

  it('foodie — earns when food visits ≥ 10', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 10 }, (_, i): SeedActivity => ({
        activity: 'food',
        occurred_at: start + i,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('foodie');
  });

  it('night_owl — earns on a 22:30 activity', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const at = new Date();
    at.setHours(22, 30, 0, 0);
    const now = at.getTime();
    await seed([{ activity: 'wheel', occurred_at: now, duration_ms: 60_000 }]);
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('night_owl');
  });

  it('early_bird — earns on a 05:00 activity', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const at = new Date();
    at.setHours(5, 0, 0, 0);
    const now = at.getTime();
    await seed([{ activity: 'exploring', occurred_at: now, duration_ms: 60_000 }]);
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('early_bird');
  });

  it('first_day — earns when onboarding_complete is true', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    db.setSetting('onboarding_complete', 'true');
    const earned = await evaluateBadges();
    expect(earned).toContain('first_day');
  });

  it('memory_keeper — earns at 5+ manual snapshot diary entries', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const cam = db.createCamera({ name: 'cam', emoji: '📷', stream_url: 'rtsp://x', enabled: true });
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      db.createDiaryEntry({
        occurred_at: now - i,
        kind: 'snapshot',
        activity: 'snapshot',
        narrative: 'snapshot',
        pet_name: null,
        camera_id: cam.id,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: null,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }
    const earned = await evaluateBadges();
    expect(earned).toContain('memory_keeper');
  });

  it('memory_keeper — auto-captured snapshots (snapshots table only) do NOT award the badge', async () => {
    // Bug fix regression test: the nightly snapshot-capture job inserts into
    // the `snapshots` table but does NOT create diary entries. Those rows must
    // not count toward Memory Keeper — only operator-triggered snapshots
    // (which create a diary entry with kind='snapshot') should.
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const cam = db.createCamera({ name: 'auto-cam', emoji: '📷', stream_url: 'rtsp://x', enabled: true });
    for (let i = 0; i < 100; i += 1) {
      db.createSnapshot({ camera_id: cam.id, taken_at: Date.now() - i, path: `auto${i}.jpg` });
    }
    // No diary entries with kind='snapshot' created.
    const earned = await evaluateBadges();
    expect(earned).not.toContain('memory_keeper');
  });

  it('hat_trick — earns at 3 distinct activities within 1h', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    const base = start + 10 * 60_000;
    await seed([
      { activity: 'wheel',     occurred_at: base + 0 },
      { activity: 'food',      occurred_at: base + 5 * 60_000 },
      { activity: 'exploring', occurred_at: base + 50 * 60_000 },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('hat_trick');
  });

  it('is idempotent on re-run (returns empty the second time)', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const db = await import('../src/db.js');
    db.setSetting('onboarding_complete', 'true');
    const first = await evaluateBadges();
    expect(first).toContain('first_day');
    const second = await evaluateBadges();
    expect(second).not.toContain('first_day');
  });

  // ---------------------------------------------------------------------------
  // Repeat policy
  // ---------------------------------------------------------------------------

  it('daily badge (marathon) earns on two different days → count=2', async () => {
    const db = await import('../src/db.js');

    // Simulate earning on day 1 (2026-01-01 noon UTC → some local time).
    const day1Ms = new Date('2026-01-01T12:00:00').getTime();
    // Simulate earning on day 2 (2026-01-02 noon).
    const day2Ms = new Date('2026-01-02T12:00:00').getTime();

    const r1 = db.earnBadge('marathon', day1Ms, 'daily');
    expect(r1).toBe(true);
    const r2 = db.earnBadge('marathon', day2Ms, 'daily');
    expect(r2).toBe(true);

    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'marathon');
    expect(row).toBeDefined();
    expect(row?.count).toBe(2);
    expect(row?.first_earned_at).toBe(day1Ms);
    expect(row?.last_earned_at).toBe(day2Ms);
  });

  it('daily badge same day → earns only once (count stays 1)', async () => {
    const db = await import('../src/db.js');

    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const noonMs = noon.getTime();
    const afternoonMs = noon.getTime() + 2 * 60 * 60 * 1000; // +2h, same day

    const r1 = db.earnBadge('foodie', noonMs, 'daily');
    expect(r1).toBe(true);
    const r2 = db.earnBadge('foodie', afternoonMs, 'daily');
    expect(r2).toBe(false); // same local day — no-op

    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'foodie');
    expect(row?.count).toBe(1);
  });

  it('once badge stays count=1 after multiple calls', async () => {
    const db = await import('../src/db.js');

    const t1 = Date.now();
    const t2 = t1 + 24 * 60 * 60 * 1000; // next day — would earn daily

    const r1 = db.earnBadge('first_day', t1, 'once');
    expect(r1).toBe(true);
    const r2 = db.earnBadge('first_day', t2, 'once');
    expect(r2).toBe(false); // once-ever — no second earn regardless of day

    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'first_day');
    expect(row?.count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Wheel odometer distance badges
  // ---------------------------------------------------------------------------

  it('mile_high — earns when cumulative wheel_meters >= 1609.34', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    // Write a wheel diary entry with wheel_meters = 1700 in details.
    db.createDiaryEntry({
      occurred_at: start + 1,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'wheel sentence',
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 60_000,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({ wheel_meters: 1700 }),
    });
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('mile_high');
    expect(earned).not.toContain('marathon_club');
    expect(earned).not.toContain('ultra');
  });

  it('marathon_club — earns when cumulative wheel_meters >= 42195', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    db.createDiaryEntry({
      occurred_at: start + 1,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'wheel sentence',
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 3_600_000,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({ wheel_meters: 42200 }),
    });
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('mile_high');
    expect(earned).toContain('marathon_club');
    expect(earned).not.toContain('ultra');
  });

  it('ultra — earns when cumulative wheel_meters >= 160934', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    db.createDiaryEntry({
      occurred_at: start + 1,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'wheel sentence',
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 7_200_000,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({ wheel_meters: 161000 }),
    });
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('mile_high');
    expect(earned).toContain('marathon_club');
    expect(earned).toContain('ultra');
  });

  it('distance badges are cumulative across multiple diary entries', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    // Two entries summing to 1700 metres — should earn mile_high.
    db.createDiaryEntry({
      occurred_at: start + 1,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'wheel sentence',
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 60_000,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({ wheel_meters: 900 }),
    });
    db.createDiaryEntry({
      occurred_at: start + 2,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'wheel sentence',
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 60_000,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({ wheel_meters: 800 }),
    });
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('mile_high');
  });

  it('distance badges not earned below threshold', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    db.createDiaryEntry({
      occurred_at: start + 1,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'wheel sentence',
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 30_000,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({ wheel_meters: 500 }),
    });
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('mile_high');
    expect(earned).not.toContain('marathon_club');
    expect(earned).not.toContain('ultra');
  });

  // ---------------------------------------------------------------------------
  // New daily badges
  // ---------------------------------------------------------------------------

  it('busy_bee — earns when 20+ real activities in one day', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    const activities: import('../src/db.js').DiaryActivity[] = [
      'wheel', 'food', 'water', 'resting', 'exploring',
      'tunnel', 'hiding', 'bathroom', 'wheel', 'food',
      'water', 'resting', 'exploring', 'tunnel', 'hiding',
      'wheel', 'food', 'water', 'resting', 'exploring',
    ];
    await seed(activities.map((activity, i) => ({ activity, occurred_at: start + i + 1 })));
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('busy_bee');
  });

  it('busy_bee — does NOT earn below 20 activities', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 19 }, (_, i): SeedActivity => ({
        activity: 'wheel',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('busy_bee');
  });

  it('hydration_hero — earns when 5+ water visits in one day', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 5 }, (_, i): SeedActivity => ({
        activity: 'water',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('hydration_hero');
  });

  it('hydration_hero — does NOT earn below 5 water visits', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 4 }, (_, i): SeedActivity => ({
        activity: 'water',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('hydration_hero');
  });

  it('sleepy_head — earns when 2+ hours resting in one day', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed([
      { activity: 'resting', occurred_at: start + 1, duration_ms: 70 * 60_000 },
      { activity: 'resting', occurred_at: start + 2, duration_ms: 55 * 60_000 },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('sleepy_head');
  });

  it('sleepy_head — does NOT earn below 2 hours resting', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed([
      { activity: 'resting', occurred_at: start + 1, duration_ms: 119 * 60_000 },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('sleepy_head');
  });

  it('globetrotter — earns when spotted on 2+ cameras in one day', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const db = await import('../src/db.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    const cam1 = db.createCamera({ name: 'Cam A', emoji: '📷', stream_url: 'rtsp://a', enabled: true });
    const cam2 = db.createCamera({ name: 'Cam B', emoji: '📷', stream_url: 'rtsp://b', enabled: true });
    await seed([
      { activity: 'wheel',     occurred_at: start + 1, camera_id: cam1.id },
      { activity: 'exploring', occurred_at: start + 2, camera_id: cam2.id },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('globetrotter');
  });

  it('globetrotter — does NOT earn when only one camera', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const db = await import('../src/db.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    const cam1 = db.createCamera({ name: 'Solo', emoji: '📷', stream_url: 'rtsp://s', enabled: true });
    await seed([
      { activity: 'wheel',     occurred_at: start + 1, camera_id: cam1.id },
      { activity: 'exploring', occurred_at: start + 2, camera_id: cam1.id },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('globetrotter');
  });

  // ---------------------------------------------------------------------------
  // New once-ever badges
  // ---------------------------------------------------------------------------

  it('snack_attack — earns at 100+ all-time food visits', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 100 }, (_, i): SeedActivity => ({
        activity: 'food',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('snack_attack');
  });

  it('snack_attack — does NOT earn below 100 food visits', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 99 }, (_, i): SeedActivity => ({
        activity: 'food',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('snack_attack');
  });

  it('snack_attack — stays count=1 after multiple evaluations', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 100 }, (_, i): SeedActivity => ({
        activity: 'food',
        occurred_at: start + i + 1,
      })),
    );
    await evaluateBadges({ now });
    await evaluateBadges({ now: now + 24 * 60 * 60_000 });
    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'snack_attack');
    expect(row?.count).toBe(1);
  });

  it('wheel_veteran — earns at 100+ all-time wheel runs', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 100 }, (_, i): SeedActivity => ({
        activity: 'wheel',
        occurred_at: start + i + 1,
        duration_ms: 60_000,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('wheel_veteran');
  });

  it('wheel_veteran — does NOT earn below 100 wheel runs', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 99 }, (_, i): SeedActivity => ({
        activity: 'wheel',
        occurred_at: start + i + 1,
        duration_ms: 60_000,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('wheel_veteran');
  });

  it('wheel_veteran — stays count=1 after multiple evaluations', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 100 }, (_, i): SeedActivity => ({
        activity: 'wheel',
        occurred_at: start + i + 1,
        duration_ms: 60_000,
      })),
    );
    await evaluateBadges({ now });
    await evaluateBadges({ now: now + 24 * 60 * 60_000 });
    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'wheel_veteran');
    expect(row?.count).toBe(1);
  });

  it('paparazzi — earns at 50+ all-time manual snapshot diary entries', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const cam = db.createCamera({ name: 'Snap', emoji: '📸', stream_url: 'rtsp://snap', enabled: true });
    const now = Date.now();
    for (let i = 0; i < 50; i += 1) {
      db.createDiaryEntry({
        occurred_at: now - i,
        kind: 'snapshot',
        activity: 'snapshot',
        narrative: 'snapshot',
        pet_name: null,
        camera_id: cam.id,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: null,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }
    const earned = await evaluateBadges();
    expect(earned).toContain('paparazzi');
  });

  it('paparazzi — does NOT earn below 50 manual snapshot diary entries', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const cam = db.createCamera({ name: 'Snap', emoji: '📸', stream_url: 'rtsp://snap', enabled: true });
    const now = Date.now();
    for (let i = 0; i < 49; i += 1) {
      db.createDiaryEntry({
        occurred_at: now - i,
        kind: 'snapshot',
        activity: 'snapshot',
        narrative: 'snapshot',
        pet_name: null,
        camera_id: cam.id,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: null,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }
    const earned = await evaluateBadges();
    expect(earned).not.toContain('paparazzi');
  });

  it('paparazzi — stays count=1 after multiple evaluations', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const cam = db.createCamera({ name: 'Snap', emoji: '📸', stream_url: 'rtsp://snap', enabled: true });
    const now = Date.now();
    for (let i = 0; i < 50; i += 1) {
      db.createDiaryEntry({
        occurred_at: now - i,
        kind: 'snapshot',
        activity: 'snapshot',
        narrative: 'snapshot',
        pet_name: null,
        camera_id: cam.id,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: null,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }
    await evaluateBadges();
    await evaluateBadges();
    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'paparazzi');
    expect(row?.count).toBe(1);
  });

  it('paparazzi — auto-captured snapshots (snapshots table only) do NOT award the badge', async () => {
    // Same regression guard as memory_keeper: nightly auto-captures must not
    // count toward paparazzi either.
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const cam = db.createCamera({ name: 'Auto', emoji: '📷', stream_url: 'rtsp://auto', enabled: true });
    for (let i = 0; i < 100; i += 1) {
      db.createSnapshot({ camera_id: cam.id, taken_at: Date.now() - i, path: `auto${i}.jpg` });
    }
    const earned = await evaluateBadges();
    expect(earned).not.toContain('paparazzi');
  });

  it('globe_runner — earns when cumulative wheel_meters >= 1,000,000 (1,000 km)', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    db.createDiaryEntry({
      occurred_at: start + 1,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'wheel sentence',
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 3_600_000,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({ wheel_meters: 1_000_001 }),
    });
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('globe_runner');
  });

  it('globe_runner — does NOT earn below 1,000 km', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    db.createDiaryEntry({
      occurred_at: start + 1,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'wheel sentence',
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 3_600_000,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({ wheel_meters: 999_999 }),
    });
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('globe_runner');
  });

  it('globe_runner — stays count=1 after multiple evaluations', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    db.createDiaryEntry({
      occurred_at: start + 1,
      kind: 'narrative',
      activity: 'wheel',
      narrative: 'wheel sentence',
      pet_name: 'Peanut',
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 3_600_000,
      snapshot_id: null,
      media_path: null,
      details: JSON.stringify({ wheel_meters: 1_000_001 }),
    });
    await evaluateBadges({ now });
    await evaluateBadges({ now: now + 24 * 60 * 60_000 });
    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'globe_runner');
    expect(row?.count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Second batch — daily badges
  // ---------------------------------------------------------------------------

  it('wheelie — earns when 5+ wheel runs in one day', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 5 }, (_, i): SeedActivity => ({
        activity: 'wheel',
        occurred_at: start + i + 1,
        duration_ms: 60_000,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('wheelie');
  });

  it('wheelie — does NOT earn below 5 wheel runs', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 4 }, (_, i): SeedActivity => ({
        activity: 'wheel',
        occurred_at: start + i + 1,
        duration_ms: 60_000,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('wheelie');
  });

  it('wanderer — earns when 5+ exploring trips in one day', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 5 }, (_, i): SeedActivity => ({
        activity: 'exploring',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('wanderer');
  });

  it('wanderer — does NOT earn below 5 exploring trips', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 4 }, (_, i): SeedActivity => ({
        activity: 'exploring',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('wanderer');
  });

  it('hide_and_seek — earns when 3+ hiding entries in one day', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 3 }, (_, i): SeedActivity => ({
        activity: 'hiding',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('hide_and_seek');
  });

  it('hide_and_seek — does NOT earn below 3 hiding entries', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 2 }, (_, i): SeedActivity => ({
        activity: 'hiding',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('hide_and_seek');
  });

  it('variety_pack — earns when 5+ distinct real activities in one day', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    // 5 distinct real activities
    await seed([
      { activity: 'wheel',     occurred_at: start + 1 },
      { activity: 'food',      occurred_at: start + 2 },
      { activity: 'water',     occurred_at: start + 3 },
      { activity: 'exploring', occurred_at: start + 4 },
      { activity: 'hiding',    occurred_at: start + 5 },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('variety_pack');
  });

  it('variety_pack — does NOT earn with only 4 distinct real activities', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed([
      { activity: 'wheel',     occurred_at: start + 1 },
      { activity: 'food',      occurred_at: start + 2 },
      { activity: 'water',     occurred_at: start + 3 },
      { activity: 'exploring', occurred_at: start + 4 },
      // Duplicate of wheel — does not add a new distinct type
      { activity: 'wheel',     occurred_at: start + 5 },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('variety_pack');
  });

  it('variety_pack — pseudo-activities (snapshot/timelapse/recap) are excluded from the distinct count', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    // Only 4 real activities + 1 pseudo — should NOT earn variety_pack
    await seed([
      { activity: 'wheel',     occurred_at: start + 1 },
      { activity: 'food',      occurred_at: start + 2 },
      { activity: 'water',     occurred_at: start + 3 },
      { activity: 'exploring', occurred_at: start + 4 },
      { activity: 'snapshot',  occurred_at: start + 5 },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('variety_pack');
  });

  // ---------------------------------------------------------------------------
  // Second batch — once-ever badges
  // ---------------------------------------------------------------------------

  it('aqua_lord — earns at 500+ all-time water visits', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 500 }, (_, i): SeedActivity => ({
        activity: 'water',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('aqua_lord');
  });

  it('aqua_lord — does NOT earn below 500 water visits', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 499 }, (_, i): SeedActivity => ({
        activity: 'water',
        occurred_at: start + i + 1,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('aqua_lord');
  });

  it('aqua_lord — stays count=1 after multiple evaluations', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 500 }, (_, i): SeedActivity => ({
        activity: 'water',
        occurred_at: start + i + 1,
      })),
    );
    await evaluateBadges({ now });
    await evaluateBadges({ now: now + 24 * 60 * 60_000 });
    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'aqua_lord');
    expect(row?.count).toBe(1);
  });

  it('wheel_legend — earns at 1,000+ all-time wheel runs', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 1_000 }, (_, i): SeedActivity => ({
        activity: 'wheel',
        occurred_at: start + i + 1,
        duration_ms: 60_000,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('wheel_legend');
  });

  it('wheel_legend — does NOT earn below 1,000 wheel runs', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 999 }, (_, i): SeedActivity => ({
        activity: 'wheel',
        occurred_at: start + i + 1,
        duration_ms: 60_000,
      })),
    );
    const earned = await evaluateBadges({ now });
    expect(earned).not.toContain('wheel_legend');
  });

  it('wheel_legend — stays count=1 after multiple evaluations', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed(
      Array.from({ length: 1_000 }, (_, i): SeedActivity => ({
        activity: 'wheel',
        occurred_at: start + i + 1,
        duration_ms: 60_000,
      })),
    );
    await evaluateBadges({ now });
    await evaluateBadges({ now: now + 24 * 60 * 60_000 });
    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'wheel_legend');
    expect(row?.count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // regular / loyal_friend — distinct active day counting
  // ---------------------------------------------------------------------------

  it('regular — earns when active on 7 different local days', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    // Insert one entry per distinct day across 7 different days.
    const dayOneMs = new Date('2026-01-01T10:00:00').getTime();
    for (let d = 0; d < 7; d += 1) {
      db.createDiaryEntry({
        occurred_at: dayOneMs + d * 24 * 60 * 60_000,
        kind: 'narrative',
        activity: 'wheel',
        narrative: 'wheel sentence',
        pet_name: 'Peanut',
        camera_id: null,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: 60_000,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }
    const earned = await evaluateBadges({ now: dayOneMs + 6 * 24 * 60 * 60_000 + 1 });
    expect(earned).toContain('regular');
  });

  it('regular — does NOT earn when 7 entries are all on the same day', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const dayOneMs = new Date('2026-01-01T10:00:00').getTime();
    // 7 entries, all within the same local day (spaced by 1 minute)
    for (let i = 0; i < 7; i += 1) {
      db.createDiaryEntry({
        occurred_at: dayOneMs + i * 60_000,
        kind: 'narrative',
        activity: 'wheel',
        narrative: 'wheel sentence',
        pet_name: 'Peanut',
        camera_id: null,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: 60_000,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }
    const earned = await evaluateBadges({ now: dayOneMs + 6 * 60_000 + 1 });
    expect(earned).not.toContain('regular');
  });

  it('regular — stays count=1 after multiple evaluations', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const dayOneMs = new Date('2026-01-01T10:00:00').getTime();
    for (let d = 0; d < 7; d += 1) {
      db.createDiaryEntry({
        occurred_at: dayOneMs + d * 24 * 60 * 60_000,
        kind: 'narrative',
        activity: 'wheel',
        narrative: 'wheel sentence',
        pet_name: 'Peanut',
        camera_id: null,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: 60_000,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }
    const nowMs = dayOneMs + 6 * 24 * 60 * 60_000 + 1;
    await evaluateBadges({ now: nowMs });
    await evaluateBadges({ now: nowMs + 24 * 60 * 60_000 });
    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'regular');
    expect(row?.count).toBe(1);
  });

  it('loyal_friend — earns when active on 30 different local days', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const dayOneMs = new Date('2026-01-01T10:00:00').getTime();
    for (let d = 0; d < 30; d += 1) {
      db.createDiaryEntry({
        occurred_at: dayOneMs + d * 24 * 60 * 60_000,
        kind: 'narrative',
        activity: 'wheel',
        narrative: 'wheel sentence',
        pet_name: 'Peanut',
        camera_id: null,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: 60_000,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }
    const earned = await evaluateBadges({ now: dayOneMs + 29 * 24 * 60 * 60_000 + 1 });
    expect(earned).toContain('regular');
    expect(earned).toContain('loyal_friend');
  });

  it('loyal_friend — does NOT earn when only 29 different days', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const dayOneMs = new Date('2026-01-01T10:00:00').getTime();
    for (let d = 0; d < 29; d += 1) {
      db.createDiaryEntry({
        occurred_at: dayOneMs + d * 24 * 60 * 60_000,
        kind: 'narrative',
        activity: 'wheel',
        narrative: 'wheel sentence',
        pet_name: 'Peanut',
        camera_id: null,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: 60_000,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }
    const earned = await evaluateBadges({ now: dayOneMs + 28 * 24 * 60 * 60_000 + 1 });
    expect(earned).not.toContain('loyal_friend');
  });

  it('loyal_friend — stays count=1 after multiple evaluations', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const dayOneMs = new Date('2026-01-01T10:00:00').getTime();
    for (let d = 0; d < 30; d += 1) {
      db.createDiaryEntry({
        occurred_at: dayOneMs + d * 24 * 60 * 60_000,
        kind: 'narrative',
        activity: 'wheel',
        narrative: 'wheel sentence',
        pet_name: 'Peanut',
        camera_id: null,
        from_camera_id: null,
        to_camera_id: null,
        duration_ms: 60_000,
        snapshot_id: null,
        media_path: null,
        details: null,
      });
    }
    const nowMs = dayOneMs + 29 * 24 * 60 * 60_000 + 1;
    await evaluateBadges({ now: nowMs });
    await evaluateBadges({ now: nowMs + 24 * 60 * 60_000 });
    const summary = db.summarizeBadges();
    const row = summary.find((s) => s.badge_id === 'loyal_friend');
    expect(row?.count).toBe(1);
  });
});
