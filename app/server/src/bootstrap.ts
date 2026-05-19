// app/server/src/bootstrap.ts
// `pnpm hamster bootstrap-admin --email --display-name --password` CLI.
// Refuses if `users` table is non-empty. Registers at Zyphr, inserts the
// local admin row. PLAN §7.6.6.

export interface BootstrapInput {
  email: string;
  display_name: string;
  password: string;
}

/** Returns the new admin's local user id; throws on conflict or upstream error. */
export async function bootstrapAdmin(_input: BootstrapInput): Promise<number> {
  throw new Error('Stage 2a will implement bootstrap.bootstrapAdmin');
}

// Argv parser + main entrypoint shell. Stage 2a wires it to the implementation
// above; the CLI surface itself (the flag names) is part of the v1 contract.
import { fileURLToPath } from 'node:url';

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  // Defer to the implementation once Stage 2a fills it in. Surfacing a clear
  // marker now means an early call before that wire-up doesn't silently no-op.
  // eslint-disable-next-line no-console
  console.error('Stage 2a will implement bootstrap CLI argv parsing + entrypoint');
  process.exit(2);
}
