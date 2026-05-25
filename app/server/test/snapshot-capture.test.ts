// Tests for jobs/snapshot-capture.ts
//
// Scenarios:
//   1. N enabled cameras + successful fetch → N snapshots rows inserted.
//   2. A camera whose fetch fails → no row inserted, no throw.
//   3. FRIGATE_URL unset → nothing inserted.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal JPEG-shaped buffer (non-zero size) to satisfy `captured: true`.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]);

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-snap-capture-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  process.env['FRIGATE_URL'] = 'http://frigate.local:5000';
  delete process.env['MQTT_URL'];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const { resetDbForTests } = await import('../src/db.js');
  const { resetConfigForTests } = await import('../src/config.js');
  resetDbForTests();
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFetchOk(body: Buffer): typeof globalThis.fetch {
  return async () => {
    return {
      ok: true,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as unknown as Response;
  };
}

function makeFetchFail(): typeof globalThis.fetch {
  return async () => {
    throw new Error('network error');
  };
}

async function seedEnabledCameras(count: number): Promise<void> {
  const db = await import('../src/db.js');
  for (let i = 0; i < count; i += 1) {
    db.createCamera({
      name: `cam${i}`,
      emoji: '📷',
      stream_url: `rtsp://host/cam${i}`,
      live_src: `cam${i}`,
      enabled: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSnapshotCaptureJob', () => {
  it('inserts a snapshots row for each enabled camera when fetch succeeds', async () => {
    await seedEnabledCameras(2);
    vi.stubGlobal('fetch', makeFetchOk(FAKE_JPEG));

    const { runSnapshotCaptureJob } = await import('../src/jobs/snapshot-capture.js');
    const result = await runSnapshotCaptureJob();

    expect(result.attempted).toBe(2);
    expect(result.captured).toBe(2);
    expect(result.skipped).toBe(0);

    const db = await import('../src/db.js');
    const cam0 = db.listCameras(false)[0];
    const cam1 = db.listCameras(false)[1];
    expect(cam0).toBeDefined();
    expect(cam1).toBeDefined();
    const snaps0 = db.listSnapshotsByCamera(cam0!.id);
    const snaps1 = db.listSnapshotsByCamera(cam1!.id);
    expect(snaps0).toHaveLength(1);
    expect(snaps1).toHaveLength(1);
  });

  it('inserts no row and does not throw when a camera fetch fails', async () => {
    await seedEnabledCameras(1);
    vi.stubGlobal('fetch', makeFetchFail());

    const { runSnapshotCaptureJob } = await import('../src/jobs/snapshot-capture.js');
    const result = await runSnapshotCaptureJob();

    expect(result.attempted).toBe(1);
    expect(result.captured).toBe(0);
    expect(result.skipped).toBe(1);

    const db = await import('../src/db.js');
    const cam = db.listCameras(false)[0];
    expect(cam).toBeDefined();
    expect(db.listSnapshotsByCamera(cam!.id)).toHaveLength(0);
  });

  it('inserts no row and does not throw when fetch returns a non-ok response', async () => {
    await seedEnabledCameras(1);
    vi.stubGlobal('fetch', async () => {
      return { ok: false, status: 503 } as unknown as Response;
    });

    const { runSnapshotCaptureJob } = await import('../src/jobs/snapshot-capture.js');
    const result = await runSnapshotCaptureJob();

    expect(result.attempted).toBe(1);
    expect(result.captured).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('inserts nothing when FRIGATE_URL is unset', async () => {
    delete process.env['FRIGATE_URL'];
    await seedEnabledCameras(2);

    // fetch should never be called, but stub it to a sentinel so we'd catch it.
    let fetchCalled = false;
    vi.stubGlobal('fetch', async () => {
      fetchCalled = true;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    });

    const { runSnapshotCaptureJob } = await import('../src/jobs/snapshot-capture.js');
    const result = await runSnapshotCaptureJob();

    expect(result.attempted).toBe(0);
    expect(result.captured).toBe(0);
    expect(result.skipped).toBe(0);
    expect(fetchCalled).toBe(false);
  });

  it('isolates per-camera failures: first camera fails, second succeeds', async () => {
    await seedEnabledCameras(2);

    let callCount = 0;
    vi.stubGlobal('fetch', async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('first camera down');
      }
      return {
        ok: true,
        arrayBuffer: async () => {
          const buf = FAKE_JPEG;
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
      } as unknown as Response;
    });

    const { runSnapshotCaptureJob } = await import('../src/jobs/snapshot-capture.js');
    const result = await runSnapshotCaptureJob();

    expect(result.attempted).toBe(2);
    expect(result.captured).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
