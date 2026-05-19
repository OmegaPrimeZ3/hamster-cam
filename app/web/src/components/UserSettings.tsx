// app/web/src/components/UserSettings.tsx
//
// Admin-only Users tab: list every account, add/delete/reset-password.

import { useState } from 'react';
import { Trash2, KeyRound, Plus } from 'lucide-react';
import { trpc, RouterOutputs } from '../trpc';
import { useAuth } from '../hooks/useAuth';
import { AddUserForm } from './AddUserForm';
import { relativeTime } from '../lib/time';

type UserRow = RouterOutputs['users']['list'][number];

export function UserSettings(): JSX.Element {
  const { user: me } = useAuth();
  const utils = trpc.useUtils();
  const users = trpc.users.list.useQuery();
  const deleteMut = trpc.users.delete.useMutation({
    onSuccess: async () => {
      await utils.users.list.invalidate();
    },
  });
  const resetMut = trpc.users.resetPassword.useMutation();
  const updateMut = trpc.users.update.useMutation({
    onSuccess: async () => {
      await utils.users.list.invalidate();
    },
  });
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 className="display" style={{ margin: 0 }}>Users</h3>
        <button type="button" className="hc-btn" onClick={() => setAdding((v) => !v)}>
          <Plus aria-hidden size={16} /> {adding ? 'Cancel' : 'Add account'}
        </button>
      </div>

      {adding && (
        <div className="hc-card-raised" style={{ padding: 12 }}>
          <AddUserForm onDone={() => setAdding(false)} />
        </div>
      )}

      {users.isLoading && <p>Loading…</p>}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(users.data ?? []).map((u) => {
          const isMe = me?.id === u.id;
          return (
            <li key={u.id} className="hc-card" style={{ padding: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {u.display_name}{' '}
                    {isMe && <span className="hc-chip-accent hc-chip">you</span>}
                  </div>
                  <small style={{ color: 'var(--text-muted)' }}>{u.email}</small>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Last seen {relativeTime(u.last_seen_at)}
                  </div>
                </div>
                <select
                  aria-label={`Role for ${u.display_name}`}
                  value={u.role}
                  onChange={(e) => {
                    const role = e.target.value as UserRow['role'];
                    if (role === u.role) return;
                    updateMut.mutate({ id: u.id, display_name: u.display_name, role });
                  }}
                  className="hc-input"
                  style={{ width: 'auto', minHeight: 40, padding: '4px 10px' }}
                >
                  <option value="admin">Admin</option>
                  <option value="child">Child</option>
                </select>
                <button
                  type="button"
                  className="hc-btn"
                  aria-label={`Reset password for ${u.display_name}`}
                  onClick={() => setResetTarget(u)}
                >
                  <KeyRound aria-hidden size={16} />
                </button>
                <button
                  type="button"
                  className={confirmDelete === u.id ? 'hc-btn hc-btn-danger' : 'hc-btn'}
                  aria-label={`Delete ${u.display_name}`}
                  disabled={isMe}
                  onClick={() => {
                    if (isMe) return;
                    if (confirmDelete === u.id) {
                      deleteMut.mutate({ id: u.id });
                      setConfirmDelete(null);
                    } else {
                      setConfirmDelete(u.id);
                      window.setTimeout(() => setConfirmDelete((c) => (c === u.id ? null : c)), 3500);
                    }
                  }}
                >
                  <Trash2 aria-hidden size={16} />
                  {confirmDelete === u.id ? ' Confirm' : ''}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {(deleteMut.error || updateMut.error) && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {(deleteMut.error ?? updateMut.error)?.message}
        </p>
      )}

      {resetTarget && (
        <div className="hc-card-raised" style={{ padding: 12 }}>
          <p style={{ marginTop: 0 }}>
            This will send a password-reset email to <strong>{resetTarget.email}</strong>. Open the email,
            set a new password, then tell {resetTarget.display_name}.
          </p>
          {resetMut.error && <p style={{ color: 'var(--danger)' }}>{resetMut.error.message}</p>}
          {resetMut.isSuccess && <p style={{ color: 'var(--success)' }}>Sent.</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="hc-btn hc-btn-primary"
              disabled={resetMut.isLoading}
              onClick={() => {
                resetMut.mutate({ id: resetTarget.id });
              }}
            >
              {resetMut.isLoading ? 'Sending…' : 'Send reset email'}
            </button>
            <button
              type="button"
              className="hc-btn"
              onClick={() => {
                setResetTarget(null);
                resetMut.reset();
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
