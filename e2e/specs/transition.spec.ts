// e2e/specs/transition.spec.ts
//
// Covers PLAN §5.4 acceptance bullet:
//   • Two MQTT events (wheel-end then food-new within 8s) produce ONE
//     coalesced "wandered from the wheel to the food bowl" diary entry,
//     not two separate ones.
//
// We stand the stack up with the in-process MQTT broker; publish a fixture
// `frigate/events` message that ends a track on the wheel camera, wait, then
// publish a 'new' on the food camera. The narrator must coalesce these into
// a single `transition`-kind diary row.

import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { startStack, type StackHandle, defaultAdmin } from '../fixtures';

let stack: StackHandle;

test.beforeEach(async () => {
  // Bump min_dwell_ms way down so the synthetic 100ms window between our
  // start_time and end_time still counts as a "real" visit (the default is
  // 2000ms which would discard our test event as a fly-through). We also
  // tighten the transition window to 2s so the spec runs fast even if the
  // narrator's setTimeout uses the full default.
  stack = await startStack({
    users: [defaultAdmin],
    settings: {
      pet_name: 'Remy',
      pet_emoji: '🐹',
      onboarding_complete: 'true',
      min_dwell_ms: '50',
      transition_window_ms: '4000',
    },
    cameras: [
      { name: 'wheel', stream_url: 'rtsp://x/wheel' },
      { name: 'food', stream_url: 'rtsp://x/food' },
    ],
    mqtt: true,
  });
  // Confirm the broker actually came up.
  expect(stack.mqtt, 'MQTT broker was not started').not.toBeNull();
});

test.afterEach(async () => {
  await stack?.close();
});

function frigateEvent(args: {
  type: 'new' | 'update' | 'end';
  camera: string;
  zones?: string[];
  startMs: number;
  endMs?: number | null;
}): string {
  const before = {
    camera: args.camera,
    label: 'remy',
    current_zones: args.zones ?? [args.camera],
    start_time: args.startMs / 1000,
    end_time: args.endMs == null ? null : args.endMs / 1000,
  };
  const after = { ...before };
  return JSON.stringify({ type: args.type, before, after });
}

function readDiaryEntries(dbPath: string): Array<{ id: number; kind: string; activity: string | null; narrative: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT id, kind, activity, narrative FROM diary_entries ORDER BY id')
      .all() as Array<{ id: number; kind: string; activity: string | null; narrative: string }>;
  } finally {
    db.close();
  }
}

test('two MQTT events (wheel-end + food-new) coalesce into one transition diary entry', async () => {
  const broker = stack.mqtt!;

  // Give the backend's MQTT subscriber a moment to land the SUBSCRIBE
  // packet before we start publishing — `startBackendChild` only waits for
  // /health to respond, not for the MQTT client's `connect` event.
  await broker.waitForSubscribe('frigate/events');

  const t0 = Date.now() - 1000;
  // 1. Publish wheel-end with a non-zero dwell so it's above min_dwell_ms.
  await broker.publish(
    'frigate/events',
    frigateEvent({ type: 'end', camera: 'wheel', startMs: t0, endMs: t0 + 100 }),
  );
  // Tiny wait for the narrator to buffer the pending-end; far less than
  // transition_window_ms so the next event arrives in time.
  await new Promise((r) => setTimeout(r, 300));
  // 2. Publish food-new on a different camera within the window.
  await broker.publish(
    'frigate/events',
    frigateEvent({ type: 'new', camera: 'food', startMs: t0 + 400 }),
  );

  // Poll the diary table for a single 'transition' row. The narrator does
  // its work on the next tick; allow up to 3s.
  const deadline = Date.now() + 3_000;
  let rows: ReturnType<typeof readDiaryEntries> = [];
  while (Date.now() < deadline) {
    rows = readDiaryEntries(stack.dbPath);
    if (rows.some((r) => r.activity === 'transition')) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const transitions = rows.filter((r) => r.activity === 'transition');
  expect(transitions.length, `diary rows=${JSON.stringify(rows)}`).toBe(1);
  // No standalone-flushed end row should accompany the transition; the
  // narrator's "transition arrived in time" branch cancels the pending-flush
  // timer before it fires.
  const standalone = rows.filter((r) => r.activity !== 'transition' && r.kind === 'narrative');
  expect(standalone.length, `standalone rows=${JSON.stringify(standalone)}`).toBe(0);

  // The narrative should mention both endpoints by their classified zones.
  const narrative = transitions[0]!.narrative;
  expect(narrative).toMatch(/wheel/i);
  expect(narrative).toMatch(/food/i);
});
