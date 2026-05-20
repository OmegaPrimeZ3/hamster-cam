// e2e/fixtures/mqtt-broker.ts
//
// In-process MQTT broker (aedes) + a publisher client. Stage 6 specs that
// need to exercise the narrator end-to-end (transition coalescing, etc.)
// stand the broker up via stack.ts (`mqtt: true`), then publish Frigate
// events via `stack.publishFrigateEvent(...)`.

import aedes from 'aedes';
import { createServer, type Server as NetServer } from 'node:net';
import mqtt, { type MqttClient } from 'mqtt';

export interface MqttBroker {
  url: string;
  publish: (topic: string, payload: string | Buffer) => Promise<void>;
  /** Resolves once a client has SUBSCRIBE'd to the given topic filter. */
  waitForSubscribe: (topicFilter: string, timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
}

export async function startMqttBroker(): Promise<MqttBroker> {
  const broker = aedes();
  const subscribedTopics = new Set<string>();
  // Capture every successful SUBSCRIBE so specs can synchronise on the
  // backend's mqtt subscriber landing before they publish events.
  broker.on('subscribe', (subs) => {
    for (const s of subs) {
      subscribedTopics.add(s.topic);
    }
  });
  const server: NetServer = createServer(broker.handle as never);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  const url = `mqtt://127.0.0.1:${port}`;

  // A publisher client that the spec uses to inject events. Connecting it
  // here lets specs `publish()` synchronously without re-handshaking.
  const publisher: MqttClient = mqtt.connect(url, { reconnectPeriod: 0, connectTimeout: 5_000 });
  await new Promise<void>((resolve, reject) => {
    publisher.once('connect', () => resolve());
    publisher.once('error', reject);
  });

  return {
    url,
    publish: (topic, payload) =>
      new Promise<void>((resolve, reject) => {
        publisher.publish(topic, payload, { qos: 1 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
    async waitForSubscribe(topicFilter, timeoutMs = 10_000) {
      const start = Date.now();
      while (!subscribedTopics.has(topicFilter)) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `no subscriber for ${topicFilter} within ${timeoutMs}ms; saw: ${[...subscribedTopics].join(', ')}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: async () => {
      await new Promise<void>((resolve) => publisher.end(false, {}, () => resolve()));
      await new Promise<void>((resolve) => broker.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
