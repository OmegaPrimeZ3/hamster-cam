// app/web/src/components/ChangePasswordForm.tsx
//
// Triggers users.changeOwnPassword — backend sends a Zyphr reset email to the
// user's own address. UI just confirms the action and shows feedback; the
// actual password is set on the page the email links to.

import { useState } from 'react';
import { trpc } from '../trpc';
import { useAuth } from '../hooks/useAuth';

export interface ChangePasswordFormProps {
  onClose?: () => void;
}

export function ChangePasswordForm({ onClose }: ChangePasswordFormProps): JSX.Element {
  const { user } = useAuth();
  const mut = trpc.users.changeOwnPassword.useMutation();
  const [confirmed, setConfirmed] = useState(false);

  if (!user) return <p>Not signed in.</p>;

  if (mut.isSuccess || confirmed) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p>
          We sent a password-reset email to <strong>{user.email}</strong>. Open it to set a new password.
        </p>
        {onClose && (
          <button type="button" className="hc-btn" onClick={onClose}>Close</button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p>
        We'll send a password-reset email to <strong>{user.email}</strong>. Open the email and set a new password.
      </p>
      {mut.error && <p role="alert" style={{ color: 'var(--danger)' }}>{mut.error.message}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="hc-btn hc-btn-primary"
          disabled={mut.isLoading}
          onClick={() => {
            mut.mutate(undefined, {
              onSuccess: () => setConfirmed(true),
            });
          }}
        >
          {mut.isLoading ? 'Sending…' : 'Send reset email'}
        </button>
        {onClose && (
          <button type="button" className="hc-btn" onClick={onClose} disabled={mut.isLoading}>Cancel</button>
        )}
      </div>
    </div>
  );
}
