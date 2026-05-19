// app/web/src/components/MfaChallenge.tsx
//
// 6-digit TOTP entry. Renders when /auth/login returned `mfa_required`.
// Strips non-digits as the parent types so the OCR-friendly keyboard fills
// it correctly on iPad.

import { FormEvent, useState } from 'react';
import { AuthHttpError } from '../lib/auth-api';

export interface MfaChallengeProps {
  challengeToken: string;
  onSubmit: (code: string) => Promise<unknown>;
  isPending: boolean;
  error: AuthHttpError | null;
  onCancel: () => void;
}

export function MfaChallenge({ challengeToken, onSubmit, isPending, error, onCancel }: MfaChallengeProps): JSX.Element {
  const [code, setCode] = useState('');

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const digits = code.replace(/\D/g, '').slice(0, 6);
    if (digits.length !== 6) return;
    void onSubmit(digits);
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Two-factor challenge" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <input type="hidden" name="challenge_token" value={challengeToken} />
      <label className="hc-label" htmlFor="mfa-code">Two-factor code</label>
      <input
        id="mfa-code"
        className="hc-input"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        autoFocus
        aria-describedby="mfa-help"
      />
      <small id="mfa-help" style={{ color: 'var(--text-muted)' }}>
        Open your authenticator app and enter the 6-digit code.
      </small>
      {error && (
        <div role="alert" style={{ color: 'var(--danger)' }}>
          {error.status === 401 ? 'That code did not match. Try again.' : 'Could not verify code.'}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          className="hc-btn hc-btn-primary"
          disabled={isPending || code.length !== 6}
        >
          {isPending ? 'Verifying…' : 'Verify'}
        </button>
        <button type="button" className="hc-btn hc-btn-ghost" onClick={onCancel}>
          Back
        </button>
      </div>
    </form>
  );
}
