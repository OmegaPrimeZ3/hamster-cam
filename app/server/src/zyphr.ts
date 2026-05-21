// app/server/src/zyphr.ts
// Provisioning helpers + the shared @zyphr-dev/node-sdk client. PLAN §7.6.4.
//
// We instantiate ONE Zyphr client and let callers consume it via getZyphr().
// Lazy construction lets tests (and the bootstrap CLI) override env before
// the SDK reads it.

import {
  Zyphr,
  ZyphrError,
  type LoginRequest,
  type MfaVerifyRequest,
} from '@zyphr-dev/node-sdk';

import { getConfig } from './config.js';

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let cachedClient: Zyphr | null = null;

/** Get the shared Zyphr SDK client; constructs lazily on first call. */
export function getZyphr(): Zyphr {
  if (cachedClient) return cachedClient;
  const cfg = getConfig();
  // The SDK has two distinct auth credential fields for the Auth-as-a-Service
  // namespace. Passing only `apiKey` (a single string) causes the SDK to send
  // that same value for BOTH X-Application-Key and X-Application-Secret,
  // which Zyphr rejects with "invalid application credentials". The correct
  // fix is to use the purpose-built `applicationKey` + `applicationSecret`
  // fields which map 1-to-1 to the two Zyphr headers.
  cachedClient = new Zyphr({
    apiKey: cfg.ZYPHR_API_KEY,
    applicationKey: cfg.ZYPHR_API_KEY,
    applicationSecret: cfg.ZYPHR_APP_SECRET,
    ...(cfg.ZYPHR_BASE_URL ? { baseUrl: cfg.ZYPHR_BASE_URL } : {}),
  });
  return cachedClient;
}

/**
 * Test helper. Tests that point the SDK at an msw shim wipe the cached client
 * after rewriting process.env so the next call picks up the new base URL.
 */
export function resetZyphrForTests(): void {
  cachedClient = null;
}

// ---------------------------------------------------------------------------
// Provisioning helpers
// ---------------------------------------------------------------------------

/** Raised by `registerAccount` when Zyphr returns 409 (email already taken). */
export class ZyphrEmailTaken extends Error {
  constructor(message: string = 'email already registered at Zyphr') {
    super(message);
    this.name = 'ZyphrEmailTaken';
  }
}

/** Shape of `auth.registration.registerEndUser`'s payload that we care about. */
export interface RegisterAccountResult {
  /** Zyphr's canonical user id — stored locally as `users.zyphr_user_id`. */
  zyphr_user_id: string;
  email: string;
  display_name: string;
  /** Access token Zyphr returned for the newly-created user. */
  access_token: string | null;
  /** Refresh token Zyphr returned for the newly-created user. */
  refresh_token: string | null;
}

/**
 * Provision a new account at Zyphr via `POST /v1/auth/register`. Throws
 * `ZyphrEmailTaken` on a 409 response; other upstream errors bubble.
 */
export async function registerAccount(
  email: string,
  password: string,
  displayName: string,
): Promise<RegisterAccountResult> {
  try {
    const response = await getZyphr().auth.registration.registerEndUser({
      email,
      password,
      name: displayName,
    });
    const user = response.data?.user;
    const tokens = response.data?.tokens;
    if (!user?.id) {
      throw new Error('zyphr.registerEndUser response missing user.id');
    }
    return {
      zyphr_user_id: user.id,
      email: user.email ?? email,
      display_name: user.name ?? displayName,
      access_token: tokens?.accessToken ?? null,
      refresh_token: tokens?.refreshToken ?? null,
    };
  } catch (err) {
    if (err instanceof ZyphrError && err.status === 409) {
      throw new ZyphrEmailTaken();
    }
    throw err;
  }
}

/**
 * Trigger Zyphr's password-reset email. Best-effort — never throws (callers
 * always respond 204 to avoid email enumeration).
 */
export async function triggerForgotPassword(email: string): Promise<void> {
  try {
    await getZyphr().auth.passwordReset.forgotPassword({ email });
  } catch {
    // Intentionally swallow. The admin/UI surface is identical for "we sent
    // it" and "we couldn't" to avoid leaking which emails exist at Zyphr.
  }
}

// ---------------------------------------------------------------------------
// Thin proxy wrappers used by /auth/* REST handlers. Kept here so auth.ts
// stays close to plain HTTP plumbing.
// ---------------------------------------------------------------------------

/**
 * Submit a login attempt. Returns the raw SDK result so the caller can branch
 * on `mfa_required` vs. success. Errors propagate to the caller for type-
 * specific handling (`ZyphrAuthenticationError`, `ZyphrRateLimitError`, etc.).
 */
export async function login(req: LoginRequest) {
  return getZyphr().auth.login.loginEndUser(req);
}

export async function verifyMfa(req: MfaVerifyRequest) {
  return getZyphr().auth.mfa.verifyMfaChallenge(req);
}

export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<void> {
  await getZyphr().auth.passwordReset.resetEndUserPassword({
    token,
    newPassword,
  });
}

/**
 * Best-effort session revocation. Never throws — callers always finish their
 * logout flow regardless of what Zyphr returns.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    await getZyphr().auth.sessions.revokeEndUserSession({ refreshToken });
  } catch {
    // Swallow.
  }
}
