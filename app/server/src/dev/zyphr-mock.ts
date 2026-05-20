// app/server/src/dev/zyphr-mock.ts
//
// In-process HTTP stub of the slice of api.zyphr.dev/v1 the `pnpm dev`
// launcher needs to get past bootstrap + login. Intentionally minimal —
// the full-surface mock for the e2e suite lives at e2e/fixtures/msw-zyphr.ts
// and supports MFA, forced errors, call inspection, password reset, etc.
//
// Wire shape mirrors what `@zyphr-dev/node-sdk` expects: every success body
// is `{ data, meta }`; every error body is `{ error: { code, message }, meta }`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

interface DevUser {
  email: string;
  password: string;
  zyphr_user_id: string;
  name: string;
}

export interface DevZyphrMock {
  /** `http://127.0.0.1:<port>/v1` — pass to the backend via ZYPHR_BASE_URL. */
  baseUrl: string;
  /**
   * Idempotently put a user into the in-memory store. Used by the dev
   * launcher to re-populate the stub on every restart, because the local
   * SQLite users table persists across runs but this stub does not.
   */
  seedUser: (user: DevUser) => void;
  close: () => Promise<void>;
}

export async function startDevZyphrMock(): Promise<DevZyphrMock> {
  const users = new Map<string, DevUser>();

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      writeError(res, 500, 'mock_internal', msg);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    if (!url.startsWith('/v1/')) {
      writeError(res, 404, 'not_found', `unknown path ${url}`);
      return;
    }
    const path = url.slice('/v1'.length);
    const body = await readJson(req);

    if (req.method === 'POST' && path === '/auth/users/register') {
      const email = pickString(body, 'email').toLowerCase();
      const password = pickString(body, 'password');
      const name = pickString(body, 'name') || email;
      if (!email || !password) {
        writeError(res, 400, 'bad_request', 'email and password required');
        return;
      }
      if (users.has(email)) {
        writeError(res, 409, 'email_taken', 'Email already registered');
        return;
      }
      const zyphr_user_id = `zyphr_${email}`;
      users.set(email, { email, password, zyphr_user_id, name });
      writeOk(res, {
        user: { id: zyphr_user_id, email, name },
        tokens: { access_token: `at-${email}`, refresh_token: `rt-${email}` },
      });
      return;
    }

    if (req.method === 'POST' && path === '/auth/users/login') {
      const email = pickString(body, 'email').toLowerCase();
      const password = pickString(body, 'password');
      const user = users.get(email);
      if (!user || user.password !== password) {
        writeError(res, 401, 'invalid_credentials', 'Invalid credentials');
        return;
      }
      writeOk(res, {
        user: { id: user.zyphr_user_id, email: user.email, name: user.name },
        tokens: { access_token: `at-${email}`, refresh_token: `rt-${email}` },
      });
      return;
    }

    if (req.method === 'POST' && path === '/auth/sessions/revoke') {
      writeOk(res, { success: true });
      return;
    }
    if (req.method === 'POST' && path === '/auth/forgot-password') {
      writeOk(res, { success: true });
      return;
    }

    writeError(res, 404, 'not_found', `dev mock has no handler for ${req.method} ${path}`);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seedUser(user) {
      users.set(user.email.toLowerCase(), { ...user, email: user.email.toLowerCase() });
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function writeOk(res: ServerResponse, data: unknown): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data, meta: { request_id: 'dev-mock' } }));
}

function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: { code, message }, meta: { request_id: 'dev-mock' } }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickString(body: unknown, key: string): string {
  if (body && typeof body === 'object' && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return '';
}
