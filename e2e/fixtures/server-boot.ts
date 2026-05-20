// e2e/fixtures/server-boot.ts
//
// Tiny entrypoint the stack fixture spawns as a child process. Boots
// `buildServer()` from the backend workspace via tsx so each spec gets a
// clean module state. Writes `READY <port>\n` to stdout once Fastify is
// listening so the parent can resolve.

import { buildServer } from '../../app/server/src/index.js';

async function main(): Promise<void> {
  const app = await buildServer();
  const port = Number(process.env['PORT'] ?? '0');
  await app.listen({ port, host: '127.0.0.1' });
  const addr = app.server.address();
  const resolved = addr && typeof addr === 'object' && 'port' in addr ? addr.port : port;
  // Bracket so the parent's regex (`^READY \d+`) doesn't pick up stray text.
  process.stdout.write(`READY ${resolved}\n`);
  // Keep the process alive — Fastify's listen() does NOT block.
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`boot-fatal: ${msg}\n`);
  process.exit(1);
});
