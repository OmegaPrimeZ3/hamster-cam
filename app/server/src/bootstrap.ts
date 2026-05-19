// app/server/src/bootstrap.ts
// `pnpm hamster bootstrap-admin --email --display-name --password` CLI.
// Refuses if `users` table is non-empty. Registers at Zyphr, inserts the
// local admin row. PLAN §7.6.6.

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import * as db from './db.js';
import { registerAccount, ZyphrEmailTaken } from './zyphr.js';

export interface BootstrapInput {
  email: string;
  display_name: string;
  password: string;
}

export class BootstrapAlreadyInitialized extends Error {
  constructor() {
    super('refusing to bootstrap: users table is non-empty');
    this.name = 'BootstrapAlreadyInitialized';
  }
}

/** Returns the new admin's local user id; throws on conflict or upstream error. */
export async function bootstrapAdmin(input: BootstrapInput): Promise<number> {
  // Force migrations + the singleton DB to come up before we touch anything.
  db.getDb();

  if (db.countUsers() > 0) {
    throw new BootstrapAlreadyInitialized();
  }
  const registered = await registerAccount(
    input.email,
    input.password,
    input.display_name,
  );
  const row = db.createUser({
    zyphr_user_id: registered.zyphr_user_id,
    email: input.email,
    display_name: input.display_name,
    role: 'admin',
    created_by: null,
  });
  db.insertAudit({
    actor_user_id: null,
    action: 'bootstrap.admin',
    target_type: 'user',
    target_id: String(row.id),
    details: { email: input.email, display_name: input.display_name },
  });
  return row.id;
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

interface CliArgs {
  email: string | undefined;
  displayName: string | undefined;
  password: string | undefined;
  help: boolean;
}

function parseCli(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      email: { type: 'string' },
      'display-name': { type: 'string' },
      password: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    email: values.email,
    displayName: values['display-name'],
    password: values.password,
    help: Boolean(values.help),
  };
}

function usage(): string {
  return [
    'Usage: pnpm hamster bootstrap-admin --email <email> --display-name <name> --password <password>',
    '',
    'Provisions the very first admin account. Refuses to run after the first user exists.',
    '',
    'Options:',
    '  --email          Email address (also the Zyphr identifier)',
    '  --display-name   Header greeting / Users-list label',
    '  --password       Initial password (Zyphr enforces its own complexity rules)',
    '  -h, --help       Show this help',
  ].join('\n');
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!args.email || !args.displayName || !args.password) {
    process.stderr.write(
      `error: --email, --display-name, and --password are all required\n\n${usage()}\n`,
    );
    return 2;
  }
  try {
    const id = await bootstrapAdmin({
      email: args.email,
      display_name: args.displayName,
      password: args.password,
    });
    process.stdout.write(`bootstrapped admin user id=${id} email=${args.email}\n`);
    return 0;
  } catch (err) {
    if (err instanceof BootstrapAlreadyInitialized) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (err instanceof ZyphrEmailTaken) {
      process.stderr.write(
        'error: that email is already registered at Zyphr — pick a different one or have the existing owner reset it\n',
      );
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`fatal: ${msg}\n`);
      process.exit(1);
    },
  );
}
