// app/server/src/zyphr.ts
// Provisioning helpers around the official @zyphr-dev/node-sdk. Stage 1 ships
// the real TypeScript surface (return types + the ZyphrEmailTaken class) that
// callers compile against; Stage 2a wires the SDK calls.
//
// PLAN §7.6.4.

/** Raised by `registerAccount` when Zyphr returns 409 (email already taken). */
export class ZyphrEmailTaken extends Error {
  constructor(message: string = 'email already registered at Zyphr') {
    super(message);
    this.name = 'ZyphrEmailTaken';
  }
}

/** Shape of `auth.registration.registerEndUser`'s success payload that we care about. */
export interface RegisterAccountResult {
  /** Zyphr's canonical user id — stored locally as `users.zyphr_user_id`. */
  zyphr_user_id: string;
  email: string;
  display_name: string;
}

/**
 * Provision a new account at Zyphr via `POST /v1/auth/register`. Throws
 * `ZyphrEmailTaken` on a 409 response; other upstream errors bubble.
 */
export async function registerAccount(
  _email: string,
  _password: string,
  _displayName: string,
): Promise<RegisterAccountResult> {
  throw new Error('Stage 2a will implement zyphr.registerAccount');
}

/**
 * Trigger Zyphr's password-reset email. Best-effort — never throws (callers
 * always respond 204 to avoid enumeration).
 */
export async function triggerForgotPassword(_email: string): Promise<void> {
  throw new Error('Stage 2a will implement zyphr.triggerForgotPassword');
}
