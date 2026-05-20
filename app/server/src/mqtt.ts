// app/server/src/mqtt.ts
// MQTT subscriber that pipes Frigate's `frigate/events` + per-camera status
// into the narrator. Reconnection with capped exponential backoff.
//
// Notes:
//   - If MQTT_URL is unset we log a one-line warning and return a no-op
//     subscriber so the rest of the process keeps running (tRPC + cron are
//     usable without a live broker — handy in laptop dev).
//   - We never block server boot on the broker being reachable; the client
//     reconnects in the background.

import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';

import { getConfig } from './config.js';
import { childLogger } from './logger.js';
import { handleFrigateEvent, type FrigateEvent } from './narrator.js';

const logger = childLogger('mqtt');

const EVENTS_TOPIC = 'frigate/events';
const CAMERA_STATUS_TOPIC = 'frigate/+/status';

/** Heartbeat updates (camera name → ms since epoch). Read by frigate.ts / cameras.list. */
const cameraHeartbeats = new Map<string, number>();

export function getCameraHeartbeat(cameraName: string): number | null {
  return cameraHeartbeats.get(cameraName) ?? null;
}

export function resetMqttStateForTests(): void {
  cameraHeartbeats.clear();
}

export interface MqttSubscriber {
  /** Resolves once an initial connection is established (or immediately if disabled). */
  ready(): Promise<void>;
  /** Cleanly disconnect. Called from index.ts shutdown hook. */
  close(): Promise<void>;
}

interface StartOptions {
  /** Inject a connection factory for tests (defaults to `mqtt.connect`). */
  connect?: typeof mqtt.connect;
  /** Drop the event into the narrator. Override in tests. */
  onEvent?: (event: FrigateEvent) => Promise<unknown> | unknown;
}

/** Start the MQTT subscriber. Always returns a usable handle. */
export function startMqttSubscriber(options: StartOptions = {}): MqttSubscriber {
  const cfg = getConfig();
  if (!cfg.MQTT_URL) {
    logger.warn('MQTT_URL not set — narrator will not receive events');
    return {
      async ready() {
        // no-op
      },
      async close() {
        // no-op
      },
    };
  }

  const connectImpl = options.connect ?? mqtt.connect;
  const onEvent = options.onEvent ?? (async (e: FrigateEvent) => {
    try {
      await handleFrigateEvent(e);
    } catch (err) {
      logger.error({ err }, 'narrator failed to process event');
    }
  });

  let readyResolved = false;
  let readyResolver: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolver = resolve;
  });

  const clientOpts: IClientOptions = {
    reconnectPeriod: 10_000, // 10s; we cap exponentially below
    connectTimeout: 10_000,
    clean: true,
    keepalive: 30,
  };
  if (cfg.MQTT_USERNAME) clientOpts.username = cfg.MQTT_USERNAME;
  if (cfg.MQTT_PASSWORD) clientOpts.password = cfg.MQTT_PASSWORD;
  const client: MqttClient = connectImpl(cfg.MQTT_URL, clientOpts);

  let backoffMs = 10_000;
  const maxBackoffMs = 60_000;

  client.on('connect', () => {
    logger.info({ url: cfg.MQTT_URL }, 'mqtt connected');
    backoffMs = 10_000;
    client.subscribe([EVENTS_TOPIC, CAMERA_STATUS_TOPIC], { qos: 0 }, (err) => {
      if (err) {
        logger.error({ err }, 'mqtt subscribe failed');
        return;
      }
      logger.debug('subscribed to frigate topics');
      if (!readyResolved && readyResolver) {
        readyResolved = true;
        readyResolver();
      }
    });
  });

  client.on('reconnect', () => {
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    (client as unknown as { options: { reconnectPeriod: number } }).options.reconnectPeriod = backoffMs;
    logger.warn({ backoffMs }, 'mqtt reconnecting');
  });

  client.on('error', (err) => {
    logger.warn({ err: err.message }, 'mqtt client error');
  });

  client.on('message', (topic, payload) => {
    if (topic === EVENTS_TOPIC) {
      const parsed = safeParseEvent(payload);
      if (!parsed) {
        logger.warn({ topic, size: payload.length }, 'dropping malformed frigate event');
        return;
      }
      void onEvent(parsed);
      // Heartbeat: an event proves the camera is alive too.
      const cam = parsed.after.camera || parsed.before.camera;
      if (cam) cameraHeartbeats.set(cam, Date.now());
      return;
    }
    // frigate/<cam>/status — payload is 'online' / 'offline'.
    const match = /^frigate\/([^/]+)\/status$/.exec(topic);
    if (match) {
      const cam = match[1];
      const text = payload.toString().trim();
      if (cam && text === 'online') {
        cameraHeartbeats.set(cam, Date.now());
      } else if (cam && text === 'offline') {
        cameraHeartbeats.delete(cam);
      }
    }
  });

  return {
    ready: () => readyPromise,
    close: async () => {
      await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    },
  };
}

function safeParseEvent(payload: Buffer): FrigateEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString());
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const type = r['type'];
  if (type !== 'new' && type !== 'update' && type !== 'end') return null;
  const before = r['before'];
  const after = r['after'];
  if (typeof before !== 'object' || before === null) return null;
  if (typeof after !== 'object' || after === null) return null;
  // Trust the SDK types; further field validation happens in the narrator.
  return { type, before: before as FrigateEvent['before'], after: after as FrigateEvent['after'] };
}
