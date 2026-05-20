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
      camera_id: null,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: e.duration_ms ?? 0,
      snapshot_id: null,
      media_path: null,
      details: null,
    });
  }
}

function startOfLocalDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

describe('badges', () => {
  it('marathon — earns when wheel time ≥ 60 min', async () => {
    const { evaluateBadges } = await import('../src/badges.js');
    const now = Date.now();
    const start = startOfLocalDay(new Date(now));
    await seed([
      { activity: 'wheel', occurred_at: start + 1, duration_ms: 30 * 60_000 },
      { activity: 'wheel', occurred_at: start + 2, duration_ms: 35 * 60_000 },
    ]);
    const earned = await evaluateBadges({ now });
    expect(earned).toContain('marathon');
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

  it('memory_keeper — earns at 5+ snapshots', async () => {
    const db = await import('../src/db.js');
    const { evaluateBadges } = await import('../src/badges.js');
    const cam = db.createCamera({ name: 'wheel', emoji: '🎡', stream_url: 'rtsp://x', enabled: true });
    for (let i = 0; i < 5; i += 1) {
      db.createSnapshot({ camera_id: cam.id, taken_at: Date.now() - i, path: `s${i}.jpg` });
    }
    const earned = await evaluateBadges();
    expect(earned).toContain('memory_keeper');
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
});
