// app/web/src/lib/auth-api.ts
//
// REST helpers for the /auth/* surface. These are plain Fastify endpoints
// (not tRPC) per PLAN §5.4 + §7.6 — `auth.ts` on the backend proxies them to
// Zyphr.dev and issues our `__Host-session` cookie on success.
//
// Schemas verify the response shape so the frontend never trusts a misshapen
// body (e.g. if the backend is half-deployed). Zod validation lives in
// `parseAuthResponse` instead of being inlined into the hook so the test
// suite can exercise it directly.

import { z } from 'zod';

export const RoleSchema = z.enum(['admin', 'child']);
export type Role = z.infer<typeof RoleSchema>;

export const AuthUserSchema = z.object({
  id: z.number().int(),
  email: z.string().email(),
  display_name: z.string(),
  role: RoleSchema,
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthSuccessSchema = z.object({
  user: AuthUserSchema,
});

export const AuthMfaChallengeSchema = z.object({
  mfa_required: z.literal(true),
  mfa_challenge: z.object({ token: z.string() }),
});

export const AuthLoginResponseSchema = z.union([AuthSuccessSchema, AuthMfaChallengeSchema]);
export type AuthLoginResponse = z.infer<typeof AuthLoginResponseSchema>;

export const AuthMeResponseSchema = AuthSuccessSchema;
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;

export class AuthHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'AuthHttpError';
    this.status = status;
    this.code = code;
  }
}

interface ErrorBody {
  error?: string;
  code?: string;
  message?: string;
}

async function readJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractError(body: unknown, fallback: string): { code: string | null; message: string } {
  if (body && typeof body === 'object') {
    const obj = body as ErrorBody;
    const code = typeof obj.code === 'string' ? obj.code : typeof obj.error === 'string' ? obj.error : null;
    const message = typeof obj.message === 'string' ? obj.message : fallback;
    return { code, message };
  }
  return { code: null, message: fallback };
}

async function authFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export interface LoginInput {
  email: string;
  password: string;
}

export async function login(input: LoginInput): Promise<AuthLoginResponse> {
  const res = await authFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const body = await readJsonSafe(res);
  if (!res.ok) {
    const { code, message } = extractError(body, defaultMessageFor(res.status));
    throw new AuthHttpError(res.status, message, code);
  }
  const parsed = AuthLoginResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new AuthHttpError(res.status, 'Unexpected response from server.', 'bad_response');
  }
  return parsed.data;
}

export interface MfaVerifyInput {
  challenge_token: string;
  code: string;
}

export async function mfaVerify(input: MfaVerifyInput): Promise<AuthMeResponse> {
  const res = await authFetch('/auth/mfa/verify', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const body = await readJsonSafe(res);
  if (!res.ok) {
    const { code, message } = extractError(body, defaultMessageFor(res.status));
    throw new AuthHttpError(res.status, message, code);
  }
  const parsed = AuthSuccessSchema.safeParse(body);
  if (!parsed.success) {
    throw new AuthHttpError(res.status, 'Unexpected response from server.', 'bad_response');
  }
  return parsed.data;
}

export async function logout(): Promise<void> {
  const res = await authFetch('/auth/logout', { method: 'POST' });
  if (!res.ok && res.status !== 204) {
    const body = await readJsonSafe(res);
    const { code, message } = extractError(body, 'Sign-out failed.');
    throw new AuthHttpError(res.status, message, code);
  }
}

export async function me(): Promise<AuthMeResponse | null> {
  const res = await authFetch('/auth/me', { method: 'GET' });
  if (res.status === 401) return null;
  const body = await readJsonSafe(res);
  if (!res.ok) {
    const { code, message } = extractError(body, defaultMessageFor(res.status));
    throw new AuthHttpError(res.status, message, code);
  }
  const parsed = AuthMeResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new AuthHttpError(res.status, 'Unexpected response from server.', 'bad_response');
  }
  return parsed.data;
}

export async function passwordResetRequest(token: string, newPassword: string): Promise<void> {
  const res = await authFetch('/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ token, new_password: newPassword }),
  });
  if (!res.ok) {
    const body = await readJsonSafe(res);
    const { code, message } = extractError(body, 'Password reset failed.');
    throw new AuthHttpError(res.status, message, code);
  }
}

function defaultMessageFor(status: number): string {
  if (status === 401) return "Hmm, that didn't match. Try again!";
  if (status === 403) return 'Your account is not set up to use this app. Ask an admin to add you.';
  if (status === 429) return 'Too many tries — wait a minute and try again.';
  if (status >= 500) return 'Something went wrong. Try again in a moment.';
  return 'Sign-in failed.';
}
