// app/server/src/jobs/snapshot-capture.ts
// Every-2-minute job (22:00–06:00) that pulls Frigate's latest.jpg for each
// enabled camera and inserts a snapshots row, giving the nightly timelapse job
// real frames to work with.
//
// Safety contract (optional-feature rules):
//   - FRIGATE_URL unset → log once and return without inserting anything.
//   - Per-camera fetch failure → log warning, skip that camera, continue loop.
//   - Zero-byte / failed captures (captured: false) → no DB insert.
//   - Any unexpected throw is caught and logged so a bug here can't crash the
//     cron runner or the server process.

import * as db from '../db.js';
import { captureLatestSnapshot } from '../frigate.js';
import { getConfig } from '../config.js';
import { childLogger } from '../logger.js';

const logger = childLogger('snapshot-capture-job');

export interface SnapshotCaptureResult {
  /** Number of enabled cameras the job tried to capture from. */
  attempted: number;
  /** Number of cameras for which a real JPEG was fetched and inserted. */
  captured: number;
  /** Number of cameras skipped (no FRIGATE_URL, fetch failed, or zero-byte). */
  skipped: number;
}

export async function runSnapshotCaptureJob(): Promise<SnapshotCaptureResult> {
  const result: SnapshotCaptureResult = { attempted: 0, captured: 0, skipped: 0 };

  try {
    const cfg = getConfig();

    if (!cfg.FRIGATE_URL) {
      logger.warn('FRIGATE_URL is not set — snapshot capture skipped');
      return result;
    }

    const cameras = db.listCameras(false); // enabled-only
    const takenAtMs = Date.now();

    for (const camera of cameras) {
      result.attempted += 1;
      const frigateName = camera.live_src ?? camera.name;

      try {
        const snap = await captureLatestSnapshot(frigateName, takenAtMs);

        if (!snap.captured) {
          logger.warn({ camera: frigateName }, 'snapshot fetch returned no real frame — skipping insert');
          result.skipped += 1;
          continue;
        }

        db.createSnapshot({
          camera_id: camera.id,
          taken_at: takenAtMs,
          path: snap.path,
        });

        result.captured += 1;
        logger.debug({ camera: frigateName, path: snap.path }, 'snapshot captured');
      } catch (err) {
        logger.warn({ err, camera: frigateName }, 'per-camera snapshot capture failed — skipping');
        result.skipped += 1;
      }
    }
  } catch (err) {
    logger.error({ err }, 'snapshot capture job threw unexpectedly');
  }

  return result;
}
