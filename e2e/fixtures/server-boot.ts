// e2e/fixtures/server-boot.ts
//
// Tiny entrypoint the stack fixture spawns as a child process. Boots
// `startRuntime()` (Fastify + MQTT + cron) via tsx so each spec gets clean
// module state AND the narrator path is exercised exactly like production.
// Writes `READY <port>\n` to stdout once Fastify is listening so the parent
// can resolve.

import { startRuntime } from '../../app/server/src/index.js';

async function main(): Promise<void> {
  const handles = await startRuntime();
  const addr = handles.app.server.address();
  const resolved = addr && typeof addr === 'object' && 'port' in addr ? addr.port : 0;
  // Bracket so the parent's regex (`^READY \d+`) doesn't pick up stray text.
  process.stdout.write(`READY ${resolved}\n`);
  // Keep the process alive — startRuntime returns once listen() resolved.
  // No additional keep-alive needed: the Fastify server itself holds the
  // event loop open, as do MQTT + cron timers.
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`boot-fatal: ${msg}\n`);
  process.exit(1);
});
