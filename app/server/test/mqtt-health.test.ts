// Tests for the MQTT rolling-window error counter (mqtt.ts) and its
// tRPC surface (admin.mqttHealth). Four coverage areas:
//   1. Counter increments on each recordMqttErrorForTests call.
//   2. Rolling-window expiry: ticks outside the window are excluded.
//   3. Threshold logger fires once per throttle period, not on every error.
//   4. tRPC admin.mqttHealth returns the expected shape.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared env bootstrap — config.ts requires DATABASE_PATH + STORAGE_PATH even
// when we never touch the DB. We set dummy paths; no file I/O actually occurs.
const TEST_ENV = {
  ZYPHR_API_KEY: 'zy_test_key',
  ZYPHR_APP_SECRET: 'zy_test_secret',
  DATABASE_PATH: '/tmp/test-mqtt-health.db',
  STORAGE_PATH: '/tmp/test-mqtt-health-storage',
};

// ── 1: counter increments ─────────────────────────────────────────────────────

describe('getMqttErrorStats — counter increments', () => {
  let getMqttErrorStats: (nowMs?: number) => import('../src/mqtt.js').MqttErrorStats;
  let resetMqttStateForTests: () => void;
  let recordMqttErrorForTests: (message: string, nowMs?: number) => void;
  const baseEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    Object.assign(process.env, baseEnv, TEST_ENV);
    delete process.env['MQTT_URL'];
    const mod = await import('../src/mqtt.js');
    getMqttErrorStats = mod.getMqttErrorStats;
    resetMqttStateForTests = mod.resetMqttStateForTests;
    recordMqttErrorForTests = mod.recordMqttErrorForTests;
  });

  afterEach(async () => {
    resetMqttStateForTests();
    const { resetConfigForTests } = await import('../src/config.js');
    resetConfigForTests();
    process.env = { ...baseEnv };
  });

  it('returns all-zero state with nulls when no errors have occurred', () => {
    const stats = getMqttErrorStats(Date.now());
    expect(stats.total_errors_lifetime).toBe(0);
    expect(stats.errors_last_5m).toBe(0);
    expect(stats.errors_last_1h).toBe(0);
    expect(stats.last_error_at).toBeNull();
    expect(stats.last_error_message).toBeNull();
  });

  it('increments total_errors_lifetime and windowed counts on each error', () => {
    const now = Date.now();
    recordMqttErrorForTests('error one', now);
    recordMqttErrorForTests('error two', now + 100);
    recordMqttErrorForTests('error three', now + 200);

    const stats = getMqttErrorStats(now + 300);
    expect(stats.total_errors_lifetime).toBe(3);
    expect(stats.errors_last_5m).toBe(3);
    expect(stats.errors_last_1h).toBe(3);
    expect(stats.last_error_message).toBe('error three');
    expect(stats.last_error_at).toBe(now + 200);
  });

  it('truncates last_error_message to 200 characters', () => {
    const longMessage = 'x'.repeat(300);
    recordMqttErrorForTests(longMessage);
    const stats = getMqttErrorStats();
    expect(stats.last_error_message).toHaveLength(200);
  });
});

// ── 2: rolling-window expiry ──────────────────────────────────────────────────

describe('getMqttErrorStats — rolling-window expiry', () => {
  let getMqttErrorStats: (nowMs?: number) => import('../src/mqtt.js').MqttErrorStats;
  let resetMqttStateForTests: () => void;
  let recordMqttErrorForTests: (message: string, nowMs?: number) => void;
  const baseEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    Object.assign(process.env, baseEnv, TEST_ENV);
    delete process.env['MQTT_URL'];
    const mod = await import('../src/mqtt.js');
    getMqttErrorStats = mod.getMqttErrorStats;
    resetMqttStateForTests = mod.resetMqttStateForTests;
    recordMqttErrorForTests = mod.recordMqttErrorForTests;
  });

  afterEach(async () => {
    resetMqttStateForTests();
    const { resetConfigForTests } = await import('../src/config.js');
    resetConfigForTests();
    process.env = { ...baseEnv };
  });

  it('excludes ticks older than 5 minutes from errors_last_5m', () => {
    const errorTime = Date.now();
    recordMqttErrorForTests('old error', errorTime);

    // Query 6 minutes later — tick is outside the 5m window.
    const sixMinLater = errorTime + 6 * 60 * 1000;
    const stats = getMqttErrorStats(sixMinLater);

    // lifetime count never decrements
    expect(stats.total_errors_lifetime).toBe(1);
    // 5m window sees nothing (tick is 6m old relative to nowMs)
    expect(stats.errors_last_5m).toBe(0);
    // 1h window still includes it (6m < 60m)
    expect(stats.errors_last_1h).toBe(1);
  });

  it('excludes ticks older than 1 hour from errors_last_1h (and prunes from last_error_at)', () => {
    const errorTime = Date.now();
    recordMqttErrorForTests('ancient error', errorTime);

    // 2 hours later — outside both windows; tick is pruned from the array.
    const twoHoursLater = errorTime + 2 * 60 * 60 * 1000;
    const stats = getMqttErrorStats(twoHoursLater);

    expect(stats.total_errors_lifetime).toBe(1);
    expect(stats.errors_last_5m).toBe(0);
    expect(stats.errors_last_1h).toBe(0);
    // Pruning removes the tick, so last_error_at is null.
    expect(stats.last_error_at).toBeNull();
  });
});

// ── 3: storm alarm fires once per throttle period ────────────────────────────

describe('getMqttErrorStats — storm alarm throttle', () => {
  let getMqttErrorStats: (nowMs?: number) => import('../src/mqtt.js').MqttErrorStats;
  let resetMqttStateForTests: () => void;
  let recordMqttErrorForTests: (message: string, nowMs?: number) => void;
  let getLastStormLogAtForTests: () => number;
  const baseEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    Object.assign(process.env, baseEnv, TEST_ENV);
    delete process.env['MQTT_URL'];
    const mod = await import('../src/mqtt.js');
    getMqttErrorStats = mod.getMqttErrorStats;
    resetMqttStateForTests = mod.resetMqttStateForTests;
    recordMqttErrorForTests = mod.recordMqttErrorForTests;
    getLastStormLogAtForTests = mod.getLastStormLogAtForTests;
  });

  afterEach(async () => {
    resetMqttStateForTests();
    const { resetConfigForTests } = await import('../src/config.js');
    resetConfigForTests();
    process.env = { ...baseEnv };
  });

  it('sets lastStormLogAt on the 10th error and does not update it on subsequent errors within the throttle window', () => {
    const now = 1_700_000_000_000;

    // Drive 9 errors — threshold not yet crossed.
    for (let i = 0; i < 9; i++) {
      recordMqttErrorForTests(`error #${i + 1}`, now + i * 100);
    }
    expect(getLastStormLogAtForTests()).toBe(0);

    // 10th error crosses the threshold — alarm fires.
    recordMqttErrorForTests('error #10', now + 900);
    expect(getLastStormLogAtForTests()).toBe(now + 900);

    // 11th–15th errors within the throttle window — lastStormLogAt does NOT update.
    for (let i = 10; i < 15; i++) {
      recordMqttErrorForTests(`error #${i + 1}`, now + i * 100);
    }
    // Still pinned at the time of the 10th error.
    expect(getLastStormLogAtForTests()).toBe(now + 900);

    const stats = getMqttErrorStats(now + 1500);
    expect(stats.total_errors_lifetime).toBe(15);
    expect(stats.errors_last_5m).toBe(15);
  });

  it('re-arms the storm alarm after the 60-second throttle window elapses', () => {
    const baseNow = 1_700_000_000_000;

    // First wave: 10 errors → alarm fires at baseNow + 900.
    for (let i = 0; i < 10; i++) {
      recordMqttErrorForTests(`wave1 #${i + 1}`, baseNow + i * 100);
    }
    const firstAlarmAt = getLastStormLogAtForTests();
    expect(firstAlarmAt).toBe(baseNow + 900);

    // 61 seconds later — throttle window has expired. Next error at or above
    // the threshold will update lastStormLogAt again.
    const wave2Start = baseNow + 61 * 1000;
    // The combined count (wave1 still in window) is already ≥ 10 on the very
    // first wave-2 error. Alarm should re-fire.
    recordMqttErrorForTests('wave2 #1', wave2Start);
    expect(getLastStormLogAtForTests()).toBe(wave2Start);

    // Stats should reflect both waves.
    const stats = getMqttErrorStats(wave2Start + 100);
    expect(stats.total_errors_lifetime).toBe(11);
    expect(stats.errors_last_5m).toBe(11);
  });
});

// ── 4: tRPC admin.mqttHealth shape ───────────────────────────────────────────

describe('admin.mqttHealth tRPC procedure', () => {
  let getMqttErrorStats: (nowMs?: number) => import('../src/mqtt.js').MqttErrorStats;
  let resetMqttStateForTests: () => void;
  let recordMqttErrorForTests: (message: string, nowMs?: number) => void;
  const baseEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    Object.assign(process.env, baseEnv, TEST_ENV);
    delete process.env['MQTT_URL'];
    const mod = await import('../src/mqtt.js');
    getMqttErrorStats = mod.getMqttErrorStats;
    resetMqttStateForTests = mod.resetMqttStateForTests;
    recordMqttErrorForTests = mod.recordMqttErrorForTests;
  });

  afterEach(async () => {
    resetMqttStateForTests();
    const { resetConfigForTests } = await import('../src/config.js');
    resetConfigForTests();
    process.env = { ...baseEnv };
    vi.restoreAllMocks();
  });

  it('returns all-zero shape with nulls when no errors occurred', () => {
    const stats = getMqttErrorStats();
    expect(stats).toMatchObject({
      total_errors_lifetime: 0,
      errors_last_5m: 0,
      errors_last_1h: 0,
      last_error_at: null,
      last_error_message: null,
    });
  });

  it('returns populated shape matching the tRPC output contract after errors', () => {
    const now = Date.now();
    recordMqttErrorForTests('payload parse failure: unexpected token', now);
    recordMqttErrorForTests('narrator exploded', now + 500);

    const stats = getMqttErrorStats(now + 1000);

    // Every field the Zod output schema declares.
    expect(typeof stats.total_errors_lifetime).toBe('number');
    expect(stats.total_errors_lifetime).toBe(2);
    expect(typeof stats.errors_last_5m).toBe('number');
    expect(stats.errors_last_5m).toBe(2);
    expect(typeof stats.errors_last_1h).toBe('number');
    expect(stats.errors_last_1h).toBe(2);
    expect(typeof stats.last_error_at).toBe('number');
    expect(stats.last_error_at).toBe(now + 500);
    expect(stats.last_error_message).toBe('narrator exploded');
  });
});
