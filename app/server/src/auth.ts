// app/server/src/auth.ts
// Fastify REST handlers for the `/auth/*` surface. Each handler is fully
// typed; Stage 2a fills the body (Zyphr SDK calls, session cookie issuance,
// MFA branching). PLAN §7.6.3.

import type { FastifyReply, FastifyRequest } from 'fastify';

/** POST /auth/login — body `{ email, password }`. */
export async function login(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  throw new Error('Stage 2a will implement auth.login');
}

/** POST /auth/mfa/verify — body `{ challenge_token, code }`. */
export async function mfaVerify(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  throw new Error('Stage 2a will implement auth.mfaVerify');
}

/** POST /auth/logout — clears session row + cookie; best-effort Zyphr revoke. */
export async function logout(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  throw new Error('Stage 2a will implement auth.logout');
}

/** GET /auth/me — returns the signed-in user or 401. Does not hit Zyphr. */
export async function me(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  throw new Error('Stage 2a will implement auth.me');
}

/** POST /auth/password/forgot — body `{ email }`. Always 204. */
export async function forgotPassword(
  _req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  throw new Error('Stage 2a will implement auth.forgotPassword');
}

/** POST /auth/password/reset — body `{ token, new_password }`. */
export async function resetPassword(
  _req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  throw new Error('Stage 2a will implement auth.resetPassword');
}
