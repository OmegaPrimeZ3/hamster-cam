// Unit tests for:
//   1. SSRF guard in cameras.testStream (Security-Review F2).
//   2. Background stats poller + getCachedCameraStats sync read.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getCachedCameraStats,
  isInternalHost,
  pollFrigateStats,
  stopFrigateStatsPoller,
  testStream,
} from '../src/frigate.js';
import { resetMqttStateForTests, setMqttHeartbeatForTests } from '../src/mqtt.js';

function makeFetchStub(impl: (url: string) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request): Promise<Response> => {
    let u: string;
    if (typeof input === 'string') u = input;
    else if (input instanceof URL) u = input.toString();
    else u = input.url;
    return Promise.resolve(impl(u));
  }) as typeof fetch;
}

describe('isInternalHost', () => {
  it('flags loopback literals', () => {
    expect(isInternalHost('localhost')).toBe(true);
    expect(isInternalHost('127.0.0.1')).toBe(true);
    expect(isInternalHost('127.55.55.55')).toBe(true);
    expect(isInternalHost('0.0.0.0')).toBe(true);
  });
  it('flags RFC1918 ranges', () => {
    expect(isInternalHost('10.0.0.1')).toBe(true);
    expect(isInternalHost('10.255.255.255')).toBe(true);
    expect(isInternalHost('172.16.0.1')).toBe(true);
    expect(isInternalHost('172.31.255.255')).toBe(true);
    expect(isInternalHost('172.32.0.1')).toBe(false); // outside /12
    expect(isInternalHost('172.15.0.1')).toBe(false); // outside /12
    expect(isInternalHost('192.168.1.1')).toBe(true);
  });
  it('flags link-local + metadata endpoint', () => {
    expect(isInternalHost('169.254.169.254')).toBe(true);
    expect(isInternalHost('169.254.0.0')).toBe(true);
  });
  it('flags CGNAT 100.64/10', () => {
    expect(isInternalHost('100.64.0.1')).toBe(true);
    expect(isInternalHost('100.127.255.255')).toBe(true);
    expect(isInternalHost('100.128.0.1')).toBe(false);
    expect(isInternalHost('100.63.255.255')).toBe(false);
  });
  it('flags IPv6 loopback + ULA + link-local', () => {
    expect(isInternalHost('::1')).toBe(true);
    expect(isInternalHost('::')).toBe(true);
    expect(isInternalHost('fc00::1')).toBe(true);
    expect(isInternalHost('fdab:1::1')).toBe(true);
    expect(isInternalHost('fe80::1')).toBe(true);
    expect(isInternalHost('fe80::1%en0')).toBe(true);
    expect(isInternalHost('febf::1')).toBe(true);
    // outside the /10 link-local boundary
    expect(isInternalHost('fec0::1')).toBe(false);
  });
  it('flags IPv4-mapped IPv6 internal addresses', () => {
    expect(isInternalHost('::ffff:127.0.0.1')).toBe(true);
    expect(isInternalHost('::ffff:10.1.2.3')).toBe(true);
    expect(isInternalHost('::ffff:8.8.8.8')).toBe(false);
  });
  it('passes ordinary public hosts/IPs through', () => {
    expect(isInternalHost('example.com')).toBe(false);
    expect(isInternalHost('cam.remy-hamster.com')).toBe(false);
    expect(isInternalHost('8.8.8.8')).toBe(false);
    expect(isInternalHost('1.1.1.1')).toBe(false);
    expect(isInternalHost('2606:4700:4700::1111')).toBe(false);
  });
});

describe('testStream', () => {
  const publicLookup = async () => ({ address: '93.184.216.34', family: 4 as const });

  it('passes a public host through and returns the status', async () => {
    const fetchFn = makeFetchStub(() => new Response(null, { status: 200 }));
    const out = await testStream('https://example.com/stream.mjpg', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: true, status: 200 });
  });

  it('rejects a 127.0.0.1 URL without dialing fetch', async () => {
    let called = false;
    const fetchFn = makeFetchStub(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const out = await testStream('http://127.0.0.1:5000/api', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: false, status: null });
    expect(called).toBe(false);
  });

  it('rejects RFC1918 literals without dialing fetch', async () => {
    let called = false;
    const fetchFn = makeFetchStub(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const out = await testStream('http://10.0.0.5/x', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: false, status: null });
    expect(called).toBe(false);
  });

  it('rejects link-local 169.254/16 (metadata endpoint)', async () => {
    const fetchFn = makeFetchStub(() => new Response(null, { status: 200 }));
    const out = await testStream('http://169.254.169.254/latest/meta-data/', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: false, status: null });
  });

  it('rejects DNS rebinding: public hostname resolves to loopback', async () => {
    // The hostname `evil.example` isn't literally internal, so we go to dns.
    // The injected lookup returns 127.0.0.1 → must reject.
    const lookup = async () => ({ address: '127.0.0.1', family: 4 as const });
    let called = false;
    const fetchFn = makeFetchStub(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const out = await testStream('http://evil.example/x', { lookup, fetchFn });
    expect(out).toEqual({ ok: false, status: null });
    expect(called).toBe(false);
  });

  it('rejects DNS rebinding into IPv6 ULA', async () => {
    const lookup = async () => ({ address: 'fc00::1', family: 6 as const });
    let called = false;
    const fetchFn = makeFetchStub(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const out = await testStream('http://rebind.example/x', { lookup, fetchFn });
    expect(out).toEqual({ ok: false, status: null });
    expect(called).toBe(false);
  });

  it('does not follow a 302 to an internal target — surfaces it as-is', async () => {
    // With redirect:'manual' undici returns the 3xx response and our function
    // surfaces status 302; it does NOT silently chase the Location header. The
    // attacker therefore gets the same "redirect happened, not following"
    // result whether or not the destination is internal.
    const fetchFn = makeFetchStub(() =>
      new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/' },
      }),
    );
    const out = await testStream('https://example.com/redir', {
      lookup: publicLookup,
      fetchFn,
    });
    // ok is false because 302 isn't 2xx, and we return the literal status so
    // the admin sees the redirect happened — but crucially we did not chase it.
    expect(out.ok).toBe(false);
    expect(out.status).toBe(302);
  });

  it('rtsp:// short-circuits as ok without fetch', async () => {
    let called = false;
    const fetchFn = makeFetchStub(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const out = await testStream('rtsp://cam.local:8554/main', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: true, status: null });
    expect(called).toBe(false);
  });

  it('non-http/https/rtsp schemes are rejected', async () => {
    const fetchFn = makeFetchStub(() => new Response(null, { status: 200 }));
    const out = await testStream('file:///etc/passwd', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: false, status: null });
  });

  it('returns false on unresolvable hostnames', async () => {
    const lookup = async () => {
      throw new Error('ENOTFOUND');
    };
    const fetchFn = makeFetchStub(() => new Response(null, { status: 200 }));
    const out = await testStream('http://nonexistent.invalid/', { lookup, fetchFn });
    expect(out).toEqual({ ok: false, status: null });
  });

  it('malformed URLs are rejected', async () => {
    const out = await testStream('not-a-url');
    expect(out).toEqual({ ok: false, status: null });
  });
});

// ---------------------------------------------------------------------------
// Background stats poller + getCachedCameraStats
//
// These tests use the optional `deps` injection on `pollFrigateStats` so they
// never touch global.fetch, process.env, or getConfig(). Fully isolated.
// ---------------------------------------------------------------------------

const FAKE_FRIGATE_URL = 'http://frigate.local:5000';

function makeStatsFetch(
  cameras: Record<string, { camera_fps?: number; last_frame_time?: number }>,
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ cameras }), { status: 200 })) as typeof fetch;
}

describe('frigate stats poller + getCachedCameraStats', () => {
  beforeEach(() => {
    // Ensure the poller is stopped and cache is clear before each test.
    stopFrigateStatsPoller();
    // Clear any MQTT heartbeats so fallback tests are deterministic.
    resetMqttStateForTests();
  });

  afterEach(() => {
    stopFrigateStatsPoller();
  });

  it('pollFrigateStats populates the cache and getCachedCameraStats returns the parsed value', async () => {
    const fetchFn = makeStatsFetch({
      'cam1': { last_frame_time: 1_700_000_000, camera_fps: 5 },
      'cam2': { camera_fps: 10 },
    });

    const result = await pollFrigateStats({ frigateUrl: FAKE_FRIGATE_URL, fetchFn });

    // pollFrigateStats returns the parsed map.
    expect(result.size).toBe(2);
    expect(result.get('cam1')).toMatchObject({
      lastFrameAt: Math.round(1_700_000_000 * 1000),
      fps: 5,
    });
    // cam2 has no last_frame_time but fps > 0 → lastFrameAt ≈ Date.now().
    const cam2 = result.get('cam2');
    expect(cam2).toBeDefined();
    expect(cam2?.lastFrameAt).not.toBeNull();
    expect(cam2?.fps).toBe(10);

    // getCachedCameraStats reads from the cache synchronously — no network.
    const cached = getCachedCameraStats('cam1');
    expect(cached.lastFrameAt).toBe(Math.round(1_700_000_000 * 1000));
    expect(cached.fps).toBe(5);
  });

  it('getCachedCameraStats falls back to null when no cache entry and no MQTT heartbeat', () => {
    // No poll has run — cache is empty. MQTT heartbeat is also absent.
    const result = getCachedCameraStats('cam-no-data');
    expect(result).toEqual({ lastFrameAt: null, fps: null });
  });

  it('pollFrigateStats returns empty map and does not throw when Frigate is unreachable', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const result = await pollFrigateStats({ frigateUrl: FAKE_FRIGATE_URL, fetchFn });
    // Network error is caught internally → empty map, no throw.
    expect(result.size).toBe(0);
  });

  it('pollFrigateStats returns empty map when frigateUrl is absent (no Frigate configured)', async () => {
    // Passing no frigateUrl and no getConfig() fallback — the function must
    // short-circuit cleanly with an empty result.
    // We supply a fetchFn that would throw if called to detect any accidental fetch.
    const fetchFn = (async () => {
      throw new Error('should not be called');
    }) as typeof fetch;

    // frigateUrl is deliberately omitted; production path calls getConfig()
    // but the module-level cache guard is what matters. We test via explicit
    // empty string equivalent by passing frigateUrl = '' (falsy).
    const result = await pollFrigateStats({ frigateUrl: '', fetchFn });
    expect(result.size).toBe(0);
  });

  it('regression: present-but-null cache entry must NOT mask a fresher MQTT heartbeat', async () => {
    // Frigate reports the camera but camera_fps=0 and no last_frame_time →
    // parseStatsCameraEntry yields { lastFrameAt: null, fps: 0 }.
    // The old getCameraStats would have fallen back to the MQTT heartbeat in
    // this case. The new getCachedCameraStats must do the same — a present cache
    // entry with null lastFrameAt is NOT sufficient to suppress the heartbeat.
    const staleEntry = { camera_fps: 0 };
    const fetchFn = makeStatsFetch({ 'stale-cam': staleEntry });
    await pollFrigateStats({ frigateUrl: FAKE_FRIGATE_URL, fetchFn });

    // Confirm the cache was populated with a null lastFrameAt.
    // (If this assertion breaks it means parseStatsCameraEntry changed — update accordingly.)
    // We don't export the raw cache, so we exercise it via getCachedCameraStats
    // before injecting a heartbeat.
    const beforeHeartbeat = getCachedCameraStats('stale-cam');
    expect(beforeHeartbeat.lastFrameAt).toBeNull();
    expect(beforeHeartbeat.fps).toBe(0);

    // Now a fresh MQTT heartbeat arrives for the same camera.
    const heartbeatTs = 1_700_005_000_000;
    setMqttHeartbeatForTests('stale-cam', heartbeatTs);

    // getCachedCameraStats must return the heartbeat timestamp, not null.
    const after = getCachedCameraStats('stale-cam');
    expect(after.lastFrameAt).toBe(heartbeatTs);
    // fps still comes from the REST cache (0 in this case, not null).
    expect(after.fps).toBe(0);
  });

  it('cache empty → falls back to MQTT heartbeat when present', () => {
    // No poll has run. Inject a heartbeat for the camera.
    const heartbeatTs = 1_700_010_000_000;
    setMqttHeartbeatForTests('cam-heartbeat-only', heartbeatTs);

    const result = getCachedCameraStats('cam-heartbeat-only');
    expect(result.lastFrameAt).toBe(heartbeatTs);
    expect(result.fps).toBeNull();
  });
});
