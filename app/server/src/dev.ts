// app/server/src/dev.ts
//
// Local-only launcher. Boots the backend with:
//   - an in-process Zyphr stub (so login works without a real tenant)
//   - a sandbox SQLite + storage path under <repo>/.dev/
//   - an auto-bootstrapped admin (dev@hamster.local / hunterhunter)
//   - seed cameras + a day of diary entries so the UI isn't empty
//
// Then start the web app with `pnpm -F web dev` (Vite proxies /trpc, /auth,
// /snapshots, /stream to the backend) and sign in.
//
// Port convention: backend listens on HC_BACKEND_PORT (default 5180) so
// multiple Node projects can run in parallel without colliding on the
// usual 3000. The Vite dev server in app/web/vite.config.ts reads the
// same env var. Override both halves together if 5180 is also taken:
//
//     HC_BACKEND_PORT=5274 pnpm -F server dev
//     HC_BACKEND_PORT=5274 pnpm -F web dev
//
// DO NOT run in production — the Zyphr stub accepts any password for the
// seeded admin and there is no MFA.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from './logger.js';
import { startDevZyphrMock } from './dev/zyphr-mock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolve <repo>/.dev/ relative to this file (works under tsx and under
// dist/dev.js if it ever gets built).
const repoRoot = path.resolve(here, '../../..');
const sandbox = process.env['HC_DEV_SANDBOX'] ?? path.join(repoRoot, '.dev');

const DEV_EMAIL = process.env['HC_DEV_EMAIL'] ?? 'dev@hamster.local';
const DEV_PASSWORD = process.env['HC_DEV_PASSWORD'] ?? 'hunterhunter';
const DEV_DISPLAY_NAME = process.env['HC_DEV_DISPLAY_NAME'] ?? 'Dev Admin';
const DEV_PET_NAME = process.env['HC_DEV_PET_NAME'] ?? 'Remy';

async function main(): Promise<void> {
  mkdirSync(path.join(sandbox, 'db'), { recursive: true });
  mkdirSync(path.join(sandbox, 'storage'), { recursive: true });

  const zyphr = await startDevZyphrMock();

  // Set env BEFORE importing anything that reads config.
  process.env['ZYPHR_BASE_URL'] = zyphr.baseUrl;
  process.env['ZYPHR_API_KEY'] = process.env['ZYPHR_API_KEY'] ?? 'dev-api-key';
  process.env['DATABASE_PATH'] = process.env['DATABASE_PATH'] ?? path.join(sandbox, 'db', 'hamster.db');
  process.env['STORAGE_PATH'] = process.env['STORAGE_PATH'] ?? path.join(sandbox, 'storage');
  // Keep PORT off the crowded 3000 default so the launcher can run alongside
  // other Node projects. Vite's proxy reads HC_BACKEND_PORT from the same env.
  process.env['PORT'] = process.env['PORT'] ?? process.env['HC_BACKEND_PORT'] ?? '5180';
  process.env['NODE_ENV'] = 'development';

  const db = await import('./db.js');
  const { bootstrapAdmin, BootstrapAlreadyInitialized } = await import('./bootstrap.js');
  const { startRuntime } = await import('./index.js');

  if (db.countUsers() === 0) {
    await bootstrapAdmin({
      email: DEV_EMAIL,
      display_name: DEV_DISPLAY_NAME,
      password: DEV_PASSWORD,
    }).catch((err: unknown) => {
      if (err instanceof BootstrapAlreadyInitialized) return;
      throw err;
    });
    logger.info({ email: DEV_EMAIL, password: DEV_PASSWORD }, '[dev] bootstrapped admin');
  }

  // The Zyphr stub is in-memory and forgets its users on every launcher
  // restart, but the local SQLite users table persists at <repo>/.dev/db/.
  // Re-seed the stub with every local user under DEV_PASSWORD so login keeps
  // working after a restart without having to wipe .dev/.
  for (const u of db.listUsers()) {
    zyphr.seedUser({
      email: u.email,
      password: DEV_PASSWORD,
      zyphr_user_id: u.zyphr_user_id,
      name: u.display_name,
    });
  }
  logger.info({ count: db.countUsers(), password: DEV_PASSWORD }, '[dev] re-seeded Zyphr stub from local users');

  if (!db.getSetting('pet_name')) {
    db.setSetting('pet_name', DEV_PET_NAME);
  }

  seedCamerasAndDiary(db);

  await startRuntime();
  logger.info(
    {
      sandbox,
      backend: `http://localhost:${process.env['PORT']}`,
      web: `http://localhost:${process.env['HC_WEB_PORT'] ?? '5181'}`,
      email: DEV_EMAIL,
      password: DEV_PASSWORD,
    },
    '[dev] backend up — open the web URL and sign in (run `pnpm dev` from the repo root to start both halves at once)',
  );
}

function seedCamerasAndDiary(db: typeof import('./db.js')): void {
  if (db.listCameras().length === 0) {
    // Split the zone vocabulary across the two cameras so the union-based
    // scoreboard shows multiple distinct tiles on first boot.
    db.createCamera({
      name: 'hamster_cam_1',
      emoji: '🐹',
      stream_url: 'rtsp://hamster:dev@hamster-cam-1.local:8554/camera',
      enabled: true,
      zones: ['wheel', 'food', 'water'],
    });
    db.createCamera({
      name: 'hamster_cam_2',
      emoji: '🛏️',
      stream_url: 'rtsp://hamster:dev@hamster-cam-2.local:8554/camera',
      enabled: true,
      zones: ['bathroom', 'resting', 'tunnel'],
    });
    logger.info('[dev] seeded 2 cameras');
  }

  const dayStart = startOfLocalDay(Date.now());
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  if (db.listDiaryEntriesBetween(dayStart, dayEnd).length > 0) return;

  const pet = db.getSetting('pet_name') ?? DEV_PET_NAME;
  const cams = db.listCameras();
  const cam1Id = cams[0]?.id ?? null;
  const cam2Id = cams[1]?.id ?? cam1Id;

  // Walk back from "now" so the most recent entry sits at the top of the
  // Today feed. Offsets in minutes-ago.
  const now = Date.now();
  const minutesAgo = (m: number): number => now - m * 60 * 1000;

  const seeds: Array<Parameters<typeof db.createDiaryEntry>[0]> = [
    {
      occurred_at: minutesAgo(2),
      kind: 'narrative',
      activity: 'wheel',
      narrative: `🎡 ${pet} went for a run on the wheel — 12 min!`,
      pet_name: pet,
      camera_id: cam1Id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 12 * 60 * 1000,
      snapshot_id: null,
      media_path: null,
      details: null,
    },
    {
      occurred_at: minutesAgo(18),
      kind: 'narrative',
      activity: 'food',
      narrative: `🥕 ${pet} had a snack!`,
      pet_name: pet,
      camera_id: cam1Id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 45 * 1000,
      snapshot_id: null,
      media_path: null,
      details: null,
    },
    {
      occurred_at: minutesAgo(35),
      kind: 'narrative',
      activity: 'water',
      narrative: `💧 ${pet} took a sip of water.`,
      pet_name: pet,
      camera_id: cam1Id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 20 * 1000,
      snapshot_id: null,
      media_path: null,
      details: null,
    },
    {
      occurred_at: minutesAgo(50),
      kind: 'narrative',
      activity: 'bathroom',
      narrative: `🚽 ${pet} popped into the bathroom corner.`,
      pet_name: pet,
      camera_id: cam2Id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 30 * 1000,
      snapshot_id: null,
      media_path: null,
      details: null,
    },
    {
      occurred_at: minutesAgo(72),
      kind: 'narrative',
      activity: 'transition',
      narrative: `🚶 ${pet} wandered from the wheel to the resting.`,
      pet_name: pet,
      camera_id: null,
      from_camera_id: cam1Id,
      to_camera_id: cam2Id,
      duration_ms: null,
      snapshot_id: null,
      media_path: null,
      details: null,
    },
    {
      occurred_at: minutesAgo(120),
      kind: 'narrative',
      activity: 'resting',
      narrative: `💤 ${pet} is napping — shhh!`,
      pet_name: pet,
      camera_id: cam2Id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 38 * 60 * 1000,
      snapshot_id: null,
      media_path: null,
      details: null,
    },
    {
      occurred_at: minutesAgo(200),
      kind: 'narrative',
      activity: 'exploring',
      narrative: `🔍 ${pet} is exploring the cage!`,
      pet_name: pet,
      camera_id: cam1Id,
      from_camera_id: null,
      to_camera_id: null,
      duration_ms: 4 * 60 * 1000,
      snapshot_id: null,
      media_path: null,
      details: null,
    },
  ];

  for (const s of seeds) db.createDiaryEntry(s);
  logger.info({ count: seeds.length }, '[dev] seeded diary entries');
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

main().catch((err: unknown) => {
  logger.error({ err }, '[dev] fatal');
  process.exit(1);
});
