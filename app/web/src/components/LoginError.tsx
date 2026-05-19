// app/web/src/components/LoginError.tsx
//
// Inline error banner shown above the login form. Maps an AuthHttpError into
// a child-friendly message — never echoes raw server text that might leak
// info.

import { AuthHttpError } from '../lib/auth-api';

export interface LoginErrorProps {
  error: AuthHttpError | null;
}

export function LoginError({ error }: LoginErrorProps): JSX.Element | null {
  if (!error) return null;
  const message = friendlyFor(error);
  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        background: 'color-mix(in srgb, var(--danger) 14%, transparent)',
        border: '1.5px solid var(--danger)',
        color: 'var(--text)',
        padding: '12px 14px',
        borderRadius: 12,
        fontSize: 15,
        fontWeight: 500,
      }}
    >
      {message}
    </div>
  );
}

function friendlyFor(err: AuthHttpError): string {
  if (err.status === 401) return "Hmm, that didn't match. Try again!";
  if (err.status === 429) return 'Too many tries — wait a minute and try again.';
  if (err.status === 403 && err.code === 'not_provisioned') {
    return "This email isn't set up for our app yet. Ask whoever set up the camera to add you.";
  }
  if (err.status === 403) return 'Your account is not set up to use this app.';
  if (err.status >= 500) return 'Something went wrong. Try again in a moment.';
  return err.message || 'Sign-in failed.';
}
