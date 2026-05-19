// app/server/src/auth.ts
// Fastify REST handlers for the `/auth/*` surface. PLAN §7.6.
//
// Single source of truth for cookie issuance + Zyphr-error → HTTP-status
// mapping. Anything that needs the SDK directly goes through src/zyphr.ts so
// the SDK client stays a singleton and tests can override it in one place.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  ZyphrAuthenticationError,
  ZyphrError,
  ZyphrRateLimitError,
} from '@zyphr-dev/node-sdk';
import { z } from 'zod';

import { getConfig } from './config.js';
import * as db from './db.js';
import {
  login as zyphrLogin,
  resetPassword as zyphrResetPassword,
  revokeRefreshToken,
  triggerForgotPassword,
  verifyMfa,
} from './zyphr.js';
import { SESSION_COOKIE } from './session.js';

// ---------------------------------------------------------------------------
// Input schemas — validate every body before it touches business logic.
// ---------------------------------------------------------------------------

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const mfaBodySchema = z.object({
  challenge_token: z.string().min(1),
  code: z.string().min(1),
});

const forgotBodySchema = z.object({
  email: z.string().email(),
});

const resetBodySchema = z.object({
  token: z.string().min(1),
  new_password: z.string().min(6),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: 'bad_request', message });
}

function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  const ttlDays = getConfig().SESSION_TTL_DAYS;
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ttlDays * 24 * 60 * 60,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Map a thrown Zyphr SDK error → an HTTP response. Returns true if handled. */
function handleZyphrError(
  req: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): boolean {
  if (err instanceof ZyphrAuthenticationError) {
    reply.code(401).send({ error: 'invalid_credentials' });
    return true;
  }
  if (err instanceof ZyphrRateLimitError) {
    const retry = err.retryAfter ?? 60;
    reply
      .code(429)
      .header('Retry-After', String(retry))
      .send({ error: 'rate_limited', retry_after: retry });
    return true;
  }
  if (err instanceof ZyphrError) {
    req.log.warn({ status: err.status, code: err.code }, 'zyphr upstream error');
    reply.code(502).send({ error: 'upstream' });
    return true;
  }
  return false;
}

interface IssueSessionInput {
  email: string;
  refreshToken: string | null;
  userAgent: string | undefined;
  reply: FastifyReply;
}

/**
 * After a successful Zyphr auth, look up the local mirror, create a session,
 * set the cookie. Returns the public user on success, null when the local
 * mirror is missing (caller replies 403 not_provisioned).
 */
function issueLocalSession(input: IssueSessionInput): db.PublicUser | null {
  const local = db.getUserByEmail(input.email);
  if (!local) return null;
  const sessionId = randomBytes(32).toString('hex');
  db.createSession({
    id: sessionId,
    user_id: local.id,
    zyphr_refresh_token: input.refreshToken,
    user_agent: input.userAgent ?? null,
    ttl_ms: getConfig().SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
  db.touchLastSeen(local.id);
  setSessionCookie(input.reply, sessionId);
  return db.toPublicUser(local);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** POST /auth/login — body `{ email, password }`. */
export async function login(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = loginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    return;
  }
  const { email, password } = parsed.data;

  let result;
  try {
    result = await zyphrLogin({ email, password });
  } catch (err) {
    if (handleZyphrError(req, reply, err)) return;
    throw err;
  }

  const data = result.data;
  if (data?.mfaRequired) {
    reply.send({
      mfa_required: true,
      mfa_challenge: { token: data.mfaChallenge?.token ?? '' },
    });
    return;
  }

  const issued = issueLocalSession({
    email,
    refreshToken: data?.tokens?.refreshToken ?? null,
    userAgent: req.headers['user-agent'],
    reply,
  });
  if (!issued) {
    reply.code(403).send({ error: 'not_provisioned' });
    return;
  }
  reply.send({ user: issued });
}

/** POST /auth/mfa/verify — body `{ challenge_token, code }`. */
export async function mfaVerify(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = mfaBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    return;
  }
  const { challenge_token, code } = parsed.data;

  let result;
  try {
    result = await verifyMfa({ challengeToken: challenge_token, totpCode: code });
  } catch (err) {
    if (handleZyphrError(req, reply, err)) return;
    throw err;
  }

  const userEmail = result.data?.user?.email;
  if (!userEmail) {
    reply.code(502).send({ error: 'upstream' });
    return;
  }
  const issued = issueLocalSession({
    email: userEmail,
    refreshToken: result.data?.tokens?.refreshToken ?? null,
    userAgent: req.headers['user-agent'],
    reply,
  });
  if (!issued) {
    reply.code(403).send({ error: 'not_provisioned' });
    return;
  }
  reply.send({ user: issued });
}

/** POST /auth/logout — clears session row + cookie; best-effort Zyphr revoke. */
export async function logout(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sid = req.cookies[SESSION_COOKIE];
  if (sid) {
    const session = db.getValidSession(sid);
    if (session?.zyphr_refresh_token) {
      await revokeRefreshToken(session.zyphr_refresh_token);
    }
    if (session) db.deleteSession(session.id);
  }
  clearSessionCookie(reply);
  reply.code(204).send();
}

/** GET /auth/me — returns `{ user }` from the local mirror or 401. */
export async function me(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const sid = req.cookies[SESSION_COOKIE];
  const session = sid ? db.getValidSession(sid) : null;
  if (!session) {
    reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  const user = db.getUserById(session.user_id);
  if (!user) {
    // Race: session row exists but the user row was wiped (admin deleted them
    // mid-flight). Treat as logged out.
    db.deleteSession(session.id);
    clearSessionCookie(reply);
    reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  db.touchLastSeen(user.id);
  reply.send({ user: db.toPublicUser(user) });
}

/**
 * POST /auth/password/forgot — body `{ email }`. Always returns 204 so we
 * never leak whether the email is in our system.
 */
export async function forgotPassword(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = forgotBodySchema.safeParse(req.body);
  if (!parsed.success) {
    // Even on validation failure, respond 204 — invalid emails get the same
    // treatment as valid-but-unknown ones, to maintain non-enumeration.
    reply.code(204).send();
    return;
  }
  const { email } = parsed.data;
  // Only call Zyphr if there's a matching local row — saves Zyphr quota and
  // keeps the surface dead-simple for callers.
  if (db.getUserByEmail(email)) {
    await triggerForgotPassword(email);
  }
  reply.code(204).send();
}

/** POST /auth/password/reset — body `{ token, new_password }`. */
export async function resetPassword(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const parsed = resetBodySchema.safeParse(req.body);
  if (!parsed.success) {
    badRequest(reply, parsed.error.issues[0]?.message ?? 'invalid body');
    return;
  }
  try {
    await zyphrResetPassword(parsed.data.token, parsed.data.new_password);
  } catch (err) {
    if (handleZyphrError(req, reply, err)) return;
    throw err;
  }
  reply.code(204).send();
}
