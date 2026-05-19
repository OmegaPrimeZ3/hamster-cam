// app/server/src/session.ts
// Fastify preHandlers that gate every protected route on a valid session
// cookie. Real implementation against db.ts — no stubs here, this is Stage 1
// final code.
//
// PLAN §7.6.3.

import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import {
  getUserById,
  getValidSession,
  touchLastSeen,
  toPublicUser,
  type PublicUser,
  type UserRow,
} from './db.js';

/**
 * Augment Fastify's request type so handlers downstream of `requireAuth` see a
 * fully-populated `user` and `session` without `as` casts. Module augmentation
 * keeps the rest of the codebase type-clean.
 */
declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
    sessionId?: string;
  }
}

export const SESSION_COOKIE = '__Host-session';

/** Look up the session cookie + user. Returns the resolved user or null. */
export function resolveSession(req: FastifyRequest): UserRow | null {
  const sid = req.cookies[SESSION_COOKIE];
  if (!sid) return null;
  const session = getValidSession(sid);
  if (!session) return null;
  const user = getUserById(session.user_id);
  if (!user) return null;
  req.sessionId = sid;
  req.user = user;
  touchLastSeen(user.id);
  return user;
}

export const requireAuth: preHandlerAsyncHookHandler = async (req, reply) => {
  const user = resolveSession(req);
  if (!user) {
    await reply.code(401).send({ error: 'unauthenticated' });
  }
};

export const requireAdmin: preHandlerAsyncHookHandler = async (req, reply) => {
  const user = resolveSession(req);
  if (!user) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  if (user.role !== 'admin') {
    await reply.code(403).send({ error: 'forbidden' });
  }
};

/** Convenience for /auth/me-style handlers that want the public projection. */
export function publicUserOrNull(req: FastifyRequest): PublicUser | null {
  return req.user ? toPublicUser(req.user) : null;
}

// Re-export the FastifyReply type so other modules can import it from the same
// barrel without pulling fastify directly. Cheap ergonomic win.
export type { FastifyReply, FastifyRequest };
