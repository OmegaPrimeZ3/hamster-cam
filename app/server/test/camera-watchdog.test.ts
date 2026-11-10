// Camera watchdog — reboot a Pi after 5 min of zero Frigate fps.

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CameraStats } from '../src/frigate.js';

let workdir: string;
const baseEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  workdir = mkdtempSync(join(tmpdir(), 'hamster-cam-watchdog-'));
  Object.assign(process.env, baseEnv);
  process.env['DATABASE_PATH'] = join(workdir, 'hamster.db');
  process.env['STORAGE_PATH'] = workdir;
  process.env['ZYPHR_API_KEY'] = 'zy_test_dummy';
  process.env['ZYPHR_APP_SECRET'] = 'zy_test_dummy_secret';
  delete process.env['FRIGATE_URL'];
  delete process.env['MQTT_URL'];
  delete process.env['CAMERA_WATCHDOG_HOSTS'];
});

afterEach(async () => {
  const db = await import('../src/db.js');
  const { resetConfigForTests } = await import('../src/config.js');
  db.resetDbForTests();
  resetConfigForTests();
  rmSync(workdir, { recursive: true, force: true });
});

const MIN = 60_000;
const live = (fps: number): CameraStats => ({ fps, lastFrameAt: fps > 0 ? Date.now() : null });

async function harness(hostsRaw = 'cam1=hamster@10.0.0.1,cam2=hamster@10.0.0.2') {
  const { getDb } = await import('../src/db.js');
  getDb(process.env['DATABASE_PATH']!);
  const mod = await import('../src/camera-watchdog.js');
  let t = 1_000_000;
  let stats = new Map<string, CameraStats>([['cam1', live(30)], ['cam2', live(30)]]);
  const reboot = vi.fn<(target: string) => Promise<void>>().mockResolvedValue();
  const wd = new mod.CameraWatchdog({
    hosts: mod.parseHostMap(hostsRaw),
    now: () => t,
    pollStats: async () => stats,
    reboot,
  });
  return {
    mod,
    wd,
    reboot,
    advance: async (ms: number) => { t += ms; await wd.tick(); },
    setStats: (m: Map<string, CameraStats>) => { stats = m; },
  };
}

describe('parseHostMap', () => {
  it('parses pairs and drops malformed ones', async () => {
    const { parseHostMap } = await import('../src/camera-watchdog.js');
    const m = parseHostMap(' cam1=hamster@10.0.0.1 , bogus, cam2=10.0.0.2 ,cam3=pi@h ');
    expect([...m]).toEqual([['cam1', 'hamster@10.0.0.1'], ['cam3', 'pi@h']]);
  });
});

describe('CameraWatchdog', () => {
  it('reboots only the silent camera after 5 minutes, and audits it', async () => {
    const h = await harness();
    h.setStats(new Map([['cam1', live(30)], ['cam2', live(0)]]));
    await h.advance(4 * MIN);
    expect(h.reboot).not.toHaveBeenCalled();
    await h.advance(1 * MIN);
    expect(h.reboot).toHaveBeenCalledTimes(1);
    expect(h.reboot).toHaveBeenCalledWith('hamster@10.0.0.2');

    const { listAudit } = await import('../src/db.js');
    const rows = listAudit({ action_prefix: 'camera.%' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe('cam2');
  });

  it('treats Frigate\'s retry-loop trickle (0.4 fps) as dead', async () => {
    const h = await harness();
    h.setStats(new Map([['cam1', live(30)], ['cam2', live(0.4)]]));
    await h.advance(5 * MIN);
    expect(h.reboot).toHaveBeenCalledWith('hamster@10.0.0.2');
  });

  it('does not reboot while Frigate is unreachable, and restarts the clock after', async () => {
    const h = await harness();
    h.setStats(new Map());
    for (let i = 0; i < 20; i++) await h.advance(1 * MIN);
    expect(h.reboot).not.toHaveBeenCalled();

    // Frigate back, camera still dead — needs a fresh full 5 minutes.
    h.setStats(new Map([['cam1', live(30)], ['cam2', live(0)]]));
    await h.advance(4 * MIN);
    expect(h.reboot).not.toHaveBeenCalled();
    await h.advance(1 * MIN);
    expect(h.reboot).toHaveBeenCalledTimes(1);
  });

  it('skips cameras Frigate does not report (typo guard)', async () => {
    const h = await harness('cam1=hamster@10.0.0.1,typo=hamster@10.0.0.9');
    h.setStats(new Map([['cam1', live(30)]]));
    await h.advance(30 * MIN);
    expect(h.reboot).not.toHaveBeenCalled();
  });

  it('backs off 15m → 30m → 60m between reboots of a still-dead camera', async () => {
    const h = await harness();
    h.setStats(new Map([['cam1', live(30)], ['cam2', live(0)]]));
    await h.advance(5 * MIN);
    expect(h.reboot).toHaveBeenCalledTimes(1);
    await h.advance(14 * MIN);
    expect(h.reboot).toHaveBeenCalledTimes(1);
    await h.advance(1 * MIN);
    expect(h.reboot).toHaveBeenCalledTimes(2);
    await h.advance(29 * MIN);
    expect(h.reboot).toHaveBeenCalledTimes(2);
    await h.advance(1 * MIN);
    expect(h.reboot).toHaveBeenCalledTimes(3);
  });

  it('resets backoff once the camera recovers', async () => {
    const h = await harness();
    h.setStats(new Map([['cam1', live(30)], ['cam2', live(0)]]));
    await h.advance(5 * MIN);
    expect(h.reboot).toHaveBeenCalledTimes(1);

    h.setStats(new Map([['cam1', live(30)], ['cam2', live(30)]]));
    await h.advance(2 * MIN);

    h.setStats(new Map([['cam1', live(30)], ['cam2', live(0)]]));
    await h.advance(5 * MIN);
    expect(h.reboot).toHaveBeenCalledTimes(2);
  });

  it('survives a failed reboot and still backs off', async () => {
    const h = await harness();
    h.reboot.mockRejectedValue(new Error('Connection timed out'));
    h.setStats(new Map([['cam1', live(30)], ['cam2', live(0)]]));
    await h.advance(5 * MIN);
    await h.advance(1 * MIN);
    expect(h.reboot).toHaveBeenCalledTimes(1);

    const { listAudit } = await import('../src/db.js');
    const details = JSON.parse(listAudit({ action_prefix: 'camera.%' })[0]!.details!);
    expect(details).toMatchObject({ ok: false, error: 'Connection timed out' });
  });
});

describe('startCameraWatchdog gate', () => {
  it('is a silent no-op when CAMERA_WATCHDOG_HOSTS is unset', async () => {
    const { startCameraWatchdog, stopCameraWatchdog } = await import('../src/camera-watchdog.js');
    await expect(startCameraWatchdog()).resolves.toBeUndefined();
    stopCameraWatchdog();
  });

  it('stays off when the ssh key files are missing', async () => {
    process.env['CAMERA_WATCHDOG_HOSTS'] = 'cam1=hamster@10.0.0.1';
    process.env['FRIGATE_URL'] = 'http://127.0.0.1:9';
    process.env['CAMERA_WATCHDOG_SSH_KEY'] = join(workdir, 'nope');
    process.env['CAMERA_WATCHDOG_KNOWN_HOSTS'] = join(workdir, 'nope2');
    const { startCameraWatchdog, stopCameraWatchdog } = await import('../src/camera-watchdog.js');
    await expect(startCameraWatchdog()).resolves.toBeUndefined();
    stopCameraWatchdog();
  });
});
