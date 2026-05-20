// e2e/fixtures/msw-zyphr.ts
//
// A real HTTP server that emulates the slice of api.zyphr.dev/v1 the backend
// hits via `@zyphr-dev/node-sdk`. We point the backend at this server by
// setting `ZYPHR_BASE_URL=http://127.0.0.1:<port>/v1`, so even when the
// backend runs in a child process (clean module state per spec), every Zyphr
// call resolves here. The class is named `msw-zyphr` for historical reasons
// but the implementation is plain Node `http` — it's faster, has no msw
// version-skew risk, and supports inspection from outside the worker.
//
// Wire shapes follow the vendored OpenAPI generator: each successful
// response wraps the payload in `{ data: <Result>, meta: {...} }`; error
// bodies use `{ error: { code, message }, meta: {...} }` per the SDK's
// `parseErrorResponse` mapping (401/403 → ZyphrAuthenticationError, 429 →
// ZyphrRateLimitError, etc.).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RecordedZyphrCall {
  method: string;
  /** Path relative to the /v1 base (e.g. `/auth/users/login`). */
  path: string;
  body: unknown;
  headers: Record<string, string>;
  ts: number;
}

export interface ZyphrUserSeed {
  email: string;
  password: string;
  /** Zyphr-issued id; matches the local mirror's zyphr_user_id when seeded. */
  zyphr_user_id?: string;
  name?: string;
  mfa_required?: boolean;
  /** When set, this is the OTP code that satisfies `/auth/mfa/verify`. */
  mfa_code?: string;
}

export interface ZyphrForcedError {
  status: number;
  code?: string;
  message?: string;
  retry_after?: number;
}

export interface ZyphrMock {
  /** http://127.0.0.1:<port>/v1 — pass to the backend via ZYPHR_BASE_URL. */
  baseUrl: string;
  /** Append-only call log. */
  calls: RecordedZyphrCall[];
  callsTo: (pathSuffix: string) => RecordedZyphrCall[];
  /** Wipe the call log between assertions. */
  resetCalls: () => void;
  /** Seed or overwrite a Zyphr user record. */
  registerUser: (input: ZyphrUserSeed) => void;
  /** Force the NEXT call to one of the endpoints to return a specific error. */
  forceError: (pathSuffix: string, error: ZyphrForcedError) => void;
  /** Clear any forced errors. */
  resetForcedErrors: () => void;
  /** Stop the HTTP listener. */
  close: () => Promise<void>;
}

export async function startZyphrMock(opts?: {
  users?: ZyphrUserSeed[];
}): Promise<ZyphrMock> {
  const calls: RecordedZyphrCall[] = [];
  const users = new Map<string, ZyphrUserSeed>();
  for (const u of opts?.users ?? []) {
    users.set(u.email.toLowerCase(), u);
  }
  const forced = new Map<string, ZyphrForcedError>();

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'mock_internal', message: msg } }));
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    if (!url.startsWith('/v1/')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const path = url.slice('/v1'.length); // → `/auth/users/login`
    const body = await readJson(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
    calls.push({
      method: req.method ?? 'GET',
      path,
      body,
      headers,
      ts: Date.now(),
    });

    const force = forced.get(path);
    if (force) {
      forced.delete(path);
      writeZyphrError(res, force);
      return;
    }

    if (req.method === 'POST' && path === '/auth/users/login') {
      const email = pickEmail(body);
      const password = pickPassword(body);
      const user = users.get(email);
      if (!user || user.password !== password) {
        writeZyphrError(res, { status: 401, code: 'invalid_credentials', message: 'Invalid credentials' });
        return;
      }
      if (user.mfa_required) {
        writeOk(res, {
          mfa_required: true,
          mfa_challenge: { token: `mfa-token-${email}` },
        });
        return;
      }
      writeOk(res, {
        user: {
          id: user.zyphr_user_id ?? `zyphr_${email}`,
          email: user.email,
          name: user.name ?? user.email,
        },
        tokens: {
          access_token: `at-${email}`,
          refresh_token: `rt-${email}`,
        },
      });
      return;
    }

    if (req.method === 'POST' && path === '/auth/mfa/verify') {
      const obj = (body ?? {}) as { challenge_token?: string; totp_code?: string };
      const token = obj.challenge_token ?? '';
      const code = obj.totp_code ?? '';
      const email = token.replace(/^mfa-token-/, '').toLowerCase();
      const user = users.get(email);
      if (!user) {
        writeZyphrError(res, { status: 401, code: 'invalid_credentials', message: 'Unknown challenge' });
        return;
      }
      if (user.mfa_code && user.mfa_code !== code) {
        writeZyphrError(res, { status: 401, code: 'invalid_credentials', message: 'Bad code' });
        return;
      }
      writeOk(res, {
        user: {
          id: user.zyphr_user_id ?? `zyphr_${user.email}`,
          email: user.email,
          name: user.name ?? user.email,
        },
        tokens: {
          access_token: `at-${user.email}`,
          refresh_token: `rt-${user.email}`,
        },
      });
      return;
    }

    if (req.method === 'POST' && path === '/auth/users/register') {
      const email = pickEmail(body).toLowerCase();
      const password = pickPassword(body);
      const obj = (body ?? {}) as { name?: string };
      if (!email || !password) {
        writeZyphrError(res, { status: 400, code: 'bad_request', message: 'email and password required' });
        return;
      }
      if (users.has(email)) {
        writeZyphrError(res, { status: 409, code: 'email_taken', message: 'Email already registered' });
        return;
      }
      const zyphrId = `zyphr_${email}`;
      users.set(email, { email, password, zyphr_user_id: zyphrId, name: obj.name });
      writeOk(res, {
        user: { id: zyphrId, email, name: obj.name ?? email },
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
    if (req.method === 'POST' && path === '/auth/reset-password') {
      writeOk(res, { success: true });
      return;
    }
    if (req.method === 'POST' && path === '/emails') {
      writeOk(res, { id: `email_${Date.now()}`, status: 'queued' });
      return;
    }
    if (req.method === 'POST' && path === '/auth/validate-reset-token') {
      writeOk(res, { valid: true });
      return;
    }

    writeZyphrError(res, { status: 404, code: 'not_found', message: `mock has no handler for ${req.method} ${path}` });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    callsTo(pathSuffix) {
      return calls.filter((c) => c.path.endsWith(pathSuffix));
    },
    resetCalls() {
      calls.length = 0;
    },
    registerUser(input) {
      users.set(input.email.toLowerCase(), input);
    },
    forceError(pathSuffix, e) {
      forced.set(pathSuffix, e);
    },
    resetForcedErrors() {
      forced.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function writeOk(res: ServerResponse, data: unknown): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data, meta: { request_id: 'mock' } }));
}

function writeZyphrError(res: ServerResponse, e: ZyphrForcedError): void {
  res.statusCode = e.status;
  res.setHeader('content-type', 'application/json');
  if (e.status === 429 && e.retry_after !== undefined) {
    res.setHeader('Retry-After', String(e.retry_after));
  }
  res.end(
    JSON.stringify({
      error: { code: e.code ?? defaultCodeFor(e.status), message: e.message ?? 'forced error' },
      meta: { request_id: 'mock' },
    }),
  );
}

function defaultCodeFor(status: number): string {
  if (status === 401 || status === 403) return 'invalid_credentials';
  if (status === 429) return 'rate_limited';
  if (status === 409) return 'email_taken';
  return 'upstream_error';
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

function pickEmail(body: unknown): string {
  if (body && typeof body === 'object' && 'email' in body) {
    const e = (body as { email: unknown }).email;
    if (typeof e === 'string') return e.toLowerCase();
  }
  return '';
}

function pickPassword(body: unknown): string {
  if (body && typeof body === 'object' && 'password' in body) {
    const p = (body as { password: unknown }).password;
    if (typeof p === 'string') return p;
  }
  return '';
}
