// app/server/src/camera-watchdog.ts
// Server-side camera watchdog: when Frigate's fps for a camera has been below
// MIN_ALIVE_FPS (effectively no frames) for STALE_MS, reboot the Pi Zero that feeds it.
//
// Why server-side: the Pi's own go2rtc-watchdog only probes go2rtc's HTTP API
// and RTSP port. When the USB camera wedges, go2rtc keeps listening happily
// with no producer, so the Pi-local probe passes while Frigate sees 0 fps
// forever. Frigate's `camera_fps` is the ground truth for "the server is
// getting video", so that's the signal this watchdog trusts.
//
// Reboot transport: `ssh` with a dedicated key whose authorized_keys entry on
// the Pi is a forced command (`sudo -n systemctl reboot`). The key can do
// nothing else. See docs/SETUP_PI_ZERO.md "Step 7b".
//
// Safety rails:
//   - Optional feature: unset CAMERA_WATCHDOG_HOSTS → log + skip.
//   - Frigate unreachable (empty stats) is "unknown", never "dead" — a Frigate
//     restart must not reboot every Pi.
//   - A camera name Frigate doesn't report is skipped (typo guard).
//   - Per-camera exponential backoff between reboots (15m → 2h cap) so a
//     permanently dead camera doesn't reboot-loop its Pi every 5 minutes.
//   - Before rebooting, actively probe go2rtc for one fresh frame. Low Frigate
//     fps does NOT always mean a dead Pi: verified live 2026-11-10, Frigate's
//     own capture process for a camera died while the Pi streamed fine, and
//     Frigate kept reporting a stale 0.4 fps. A frame from go2rtc's
//     /api/frame.jpeg pulls a keyframe across Pi camera → Pi go2rtc → Mini
//     restream regardless of other consumers, so it proves the Pi is healthy.
//     Then the fault is Frigate's — warn + audit, never reboot the Pi.

import { execFile as execFileCb } from 'node:child_process';
import { access, constants as fsConstants } from 'node:fs/promises';
import { promisify } from 'node:util';

import { getConfig } from './config.js';
import { insertAudit } from './db.js';
import { pollFrigateStats, type CameraStats } from './frigate.js';
import { logger } from './logger.js';

const execFile = promisify(execFileCb);
const log = logger.child({ name: 'camera-watchdog' });

export const STALE_MS = 5 * 60_000;
// Below this, a camera counts as silent. NOT `> 0`: verified live 2026-11-09,
// a camera whose Pi was unreachable (go2rtc bytes_recv = null) still reported
// camera_fps 0.4 — Frigate's ffmpeg retry loop leaves a trickle. Healthy
// cameras run at the detect rate (~10 fps).
export const MIN_ALIVE_FPS = 1;
export const CHECK_INTERVAL_MS = 30_000;
export const INITIAL_BACKOFF_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 2 * 60 * 60_000;
export const STALL_RECHECK_MS = 5 * 60_000;
const SSH_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 20_000;
// Frigate's embedded go2rtc API port — reachable on the compose network but
// not published to the host.
const GO2RTC_PORT = '1984';

/** Frigate camera name → ssh target (`user@host`). */
export type HostMap = ReadonlyMap<string, string>;

/**
 * Parse `hamster_cam_1=hamster@192.168.1.201,hamster_cam_2=hamster@192.168.1.202`.
 * Malformed pairs are dropped with a warning rather than failing boot.
 */
export function parseHostMap(raw: string): HostMap {
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [camera, target] = trimmed.split('=').map((s) => s.trim());
    if (!camera || !target || !target.includes('@')) {
      log.warn({ pair: trimmed }, 'ignoring malformed CAMERA_WATCHDOG_HOSTS entry (want camera=user@host)');
      continue;
    }
    map.set(camera, target);
  }
  return map;
}

export interface CameraWatchdogDeps {
  hosts: HostMap;
  now: () => number;
  /** Returns per-camera stats; an EMPTY map means "Frigate unreachable". */
  pollStats: () => Promise<Map<string, CameraStats>>;
  /** Reboot the Pi at `target`. Rejects on failure. */
  reboot: (target: string) => Promise<void>;
  /** True when go2rtc can serve a fresh frame for `camera` (Pi is streaming). */
  probeFrame: (camera: string) => Promise<boolean>;
}

interface CameraState {
  lastAliveAt: number;
  nextRebootAllowedAt: number;
  backoffMs: number;
  rebootsSinceAlive: number;
  frigateStallReported: boolean;
}

export class CameraWatchdog {
  private readonly state = new Map<string, CameraState>();

  constructor(private readonly deps: CameraWatchdogDeps) {
    const start = deps.now();
    for (const camera of deps.hosts.keys()) {
      this.state.set(camera, {
        lastAliveAt: start, // boot grace: a fresh server gets a full window
        nextRebootAllowedAt: 0,
        backoffMs: INITIAL_BACKOFF_MS,
        rebootsSinceAlive: 0,
        frigateStallReported: false,
      });
    }
  }

  async tick(): Promise<void> {
    const stats = await this.deps.pollStats();
    const now = this.deps.now();

    if (stats.size === 0) {
      // Frigate is down or unreachable — we know nothing about the cameras.
      // Restart every clock so we need a full fresh window of CONFIRMED
      // silence before acting.
      for (const s of this.state.values()) s.lastAliveAt = now;
      return;
    }

    for (const [camera, target] of this.deps.hosts) {
      const s = this.state.get(camera)!;
      const cam = stats.get(camera);

      if (!cam) {
        log.warn({ camera }, 'camera not in Frigate stats — check CAMERA_WATCHDOG_HOSTS names; skipping');
        s.lastAliveAt = now;
        continue;
      }

      if ((cam.fps ?? 0) >= MIN_ALIVE_FPS) {
        if (s.rebootsSinceAlive > 0) {
          log.info({ camera, reboots: s.rebootsSinceAlive }, 'camera recovered');
        }
        s.lastAliveAt = now;
        s.backoffMs = INITIAL_BACKOFF_MS;
        s.nextRebootAllowedAt = 0;
        s.rebootsSinceAlive = 0;
        s.frigateStallReported = false;
        continue;
      }

      const silentMs = now - s.lastAliveAt;
      if (silentMs < STALE_MS || now < s.nextRebootAllowedAt) continue;

      if (await this.deps.probeFrame(camera)) {
        // The Pi is streaming; Frigate's capture is what stalled. Rebooting
        // the Pi would fix nothing. Re-probe later without escalating.
        s.nextRebootAllowedAt = now + STALL_RECHECK_MS;
        if (!s.frigateStallReported) {
          s.frigateStallReported = true;
          this.reportFrigateStall(camera, silentMs);
        }
        continue;
      }

      s.nextRebootAllowedAt = now + s.backoffMs;
      s.backoffMs = Math.min(s.backoffMs * 2, MAX_BACKOFF_MS);
      s.rebootsSinceAlive += 1;
      await this.rebootPi(camera, target, silentMs, s.rebootsSinceAlive);
    }
  }

  private reportFrigateStall(camera: string, silentMs: number): void {
    const silentSec = Math.round(silentMs / 1000);
    log.warn(
      { camera, silentSec },
      'Frigate shows no frames but the Pi is streaming (go2rtc served a fresh frame) — Frigate capture is stalled; NOT rebooting the Pi. Restart Frigate: docker restart hamster-frigate',
    );
    try {
      insertAudit({
        actor_user_id: null,
        action: 'camera.watchdog_frigate_stalled',
        target_type: 'camera',
        target_id: camera,
        details: { silentSec },
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'audit insert failed');
    }
  }

  private async rebootPi(camera: string, target: string, silentMs: number, attempt: number): Promise<void> {
    const silentSec = Math.round(silentMs / 1000);
    log.warn({ camera, target, silentSec, attempt }, 'no frames from camera — rebooting its Pi');
    let ok = true;
    let error: string | undefined;
    try {
      await this.deps.reboot(target);
    } catch (err) {
      ok = false;
      error = (err as Error).message;
      log.error({ camera, target, err: error }, 'Pi reboot failed (unreachable, host-key mismatch, or sudoers missing?)');
    }
    try {
      insertAudit({
        actor_user_id: null,
        action: 'camera.watchdog_reboot',
        target_type: 'camera',
        target_id: camera,
        details: { target, silentSec, attempt, ok, ...(error ? { error } : {}) },
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'audit insert failed');
    }
  }
}

/** Real transport: ssh with a forced-command key. */
export function sshReboot(keyPath: string, knownHostsPath: string) {
  return async (target: string): Promise<void> => {
    await execFile('ssh', [
      '-F', '/dev/null',
      '-T',
      '-i', keyPath,
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${knownHostsPath}`,
      target,
    ], { timeout: SSH_TIMEOUT_MS });
  };
}

/** Real probe: ask Frigate's embedded go2rtc for one JPEG frame. */
export function go2rtcFrameProbe(frigateUrl: string) {
  const base = new URL(frigateUrl);
  base.port = GO2RTC_PORT;
  return async (camera: string): Promise<boolean> => {
    const url = new URL('/api/frame.jpeg', base);
    url.searchParams.set('src', camera);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!res.ok || !res.headers.get('content-type')?.startsWith('image/')) return false;
      return (await res.arrayBuffer()).byteLength > 0;
    } catch {
      return false; // unreachable / timed out → can't prove the Pi is alive
    }
  };
}

let handle: ReturnType<typeof setInterval> | null = null;

/** Boot hook. Silent no-op unless CAMERA_WATCHDOG_HOSTS is configured. */
export async function startCameraWatchdog(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.CAMERA_WATCHDOG_HOSTS) {
    log.info({ skipped: 'no_hosts_configured' }, 'camera watchdog disabled');
    return;
  }
  if (!cfg.FRIGATE_URL) {
    log.info({ skipped: 'no_frigate_url' }, 'camera watchdog disabled');
    return;
  }
  const hosts = parseHostMap(cfg.CAMERA_WATCHDOG_HOSTS);
  if (hosts.size === 0) return;

  const key = cfg.CAMERA_WATCHDOG_SSH_KEY;
  const knownHosts = cfg.CAMERA_WATCHDOG_KNOWN_HOSTS;
  try {
    await access(key, fsConstants.R_OK);
    await access(knownHosts, fsConstants.R_OK);
  } catch {
    log.warn({ key, knownHosts, skipped: 'ssh_files_missing' }, 'camera watchdog disabled — ssh key or known_hosts not readable');
    return;
  }
  if (handle) return;

  const watchdog = new CameraWatchdog({
    hosts,
    now: Date.now,
    pollStats: () => pollFrigateStats(),
    reboot: sshReboot(key, knownHosts),
    probeFrame: go2rtcFrameProbe(cfg.FRIGATE_URL),
  });
  let running = false;
  handle = setInterval(() => {
    if (running) return; // an ssh call can outlast an interval
    running = true;
    watchdog.tick()
      .catch((err: unknown) => log.error({ err }, 'camera watchdog tick failed'))
      .finally(() => { running = false; });
  }, CHECK_INTERVAL_MS);
  handle.unref();
  log.info({ cameras: [...hosts.keys()], staleMinutes: STALE_MS / 60_000 }, 'camera watchdog started');
}

export function stopCameraWatchdog(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
