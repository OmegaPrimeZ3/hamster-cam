// app/server/src/mqtt.ts
// MQTT subscriber that pipes Frigate's `frigate/events` (and per-camera
// status topics) into the narrator. Stage 2a builds the connection +
// re-subscribe-on-reconnect logic.

export interface MqttSubscriber {
  /** Resolves once an initial connection is established. */
  ready(): Promise<void>;
  /** Cleanly disconnect. Called from index.ts shutdown hook. */
  close(): Promise<void>;
}

/** Start the singleton MQTT subscriber. Throws if env vars are missing. */
export function startMqttSubscriber(): MqttSubscriber {
  throw new Error('Stage 2a will implement mqtt.startMqttSubscriber');
}
