// app/web/src/components/ShareSettings.tsx
//
// Admin-only "Sharing" tab. Manages the recipient allowlist used by the
// Send-a-Clip flow. Both roles can READ the list (for the share dialog);
// only admins can mutate.

import { useState } from 'react';
import { Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { trpc, RouterOutputs } from '../trpc';

type Recipient = RouterOutputs['recipients']['list'][number];

export function ShareSettings(): JSX.Element {
  const utils = trpc.useUtils();
  const list = trpc.recipients.list.useQuery();
  const create = trpc.recipients.create.useMutation({
    onSuccess: async () => {
      await utils.recipients.list.invalidate();
    },
  });
  const update = trpc.recipients.update.useMutation({
    onSuccess: async () => {
      await utils.recipients.list.invalidate();
    },
  });
  const remove = trpc.recipients.delete.useMutation({
    onSuccess: async () => {
      await utils.recipients.list.invalidate();
    },
  });

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [editing, setEditing] = useState<Recipient | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 className="display" style={{ margin: 0 }}>Recipients</h3>
        <button type="button" className="hc-btn" onClick={() => setAdding((v) => !v)}>
          <Plus aria-hidden size={16} /> {adding ? 'Cancel' : 'Add recipient'}
        </button>
      </div>

      <p style={{ color: 'var(--text-muted)', margin: 0 }}>
        Everyone signed in can tap-to-send a clip to anyone on this list, but only admins can add or remove.
      </p>

      {adding && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(
              { display_name: newName.trim(), email: newEmail.trim() },
              {
                onSuccess: () => {
                  setNewName('');
                  setNewEmail('');
                  setAdding(false);
                },
              },
            );
          }}
          className="hc-card-raised"
          style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <input
            className="hc-input"
            placeholder="Display name (e.g. Aunt Sarah)"
            value={newName}
            maxLength={40}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <input
            className="hc-input"
            placeholder="Email"
            type="email"
            inputMode="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            required
          />
          {create.error && <p style={{ color: 'var(--danger)' }}>{create.error.message}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="hc-btn hc-btn-primary" disabled={create.isLoading}>
              {create.isLoading ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="hc-btn" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}

      {list.isLoading && <p>Loading…</p>}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(list.data ?? []).map((r) => (
          <li key={r.id} className="hc-card" style={{ padding: 10 }}>
            {editing?.id === r.id ? (
              <EditRow
                row={editing}
                onCancel={() => setEditing(null)}
                onSave={(next) =>
                  update.mutate(
                    { id: r.id, display_name: next.display_name, email: next.email },
                    { onSuccess: () => setEditing(null) },
                  )
                }
                pending={update.isLoading}
                error={update.error?.message ?? null}
              />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{r.display_name}</div>
                  <small style={{ color: 'var(--text-muted)' }}>{r.email}</small>
                </div>
                <button
                  type="button"
                  className="hc-btn"
                  aria-label={`Edit ${r.display_name}`}
                  onClick={() => setEditing(r)}
                >
                  <Pencil aria-hidden size={16} />
                </button>
                <button
                  type="button"
                  className={confirmDelete === r.id ? 'hc-btn hc-btn-danger' : 'hc-btn'}
                  aria-label={`Delete ${r.display_name}`}
                  onClick={() => {
                    if (confirmDelete === r.id) {
                      remove.mutate({ id: r.id });
                      setConfirmDelete(null);
                    } else {
                      setConfirmDelete(r.id);
                      window.setTimeout(() => setConfirmDelete((c) => (c === r.id ? null : c)), 3500);
                    }
                  }}
                >
                  <Trash2 aria-hidden size={16} />
                  {confirmDelete === r.id ? ' Confirm' : ''}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!list.isLoading && (list.data?.length ?? 0) === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>No recipients yet.</p>
      )}
    </div>
  );
}

function EditRow({
  row,
  onCancel,
  onSave,
  pending,
  error,
}: {
  row: Recipient;
  onCancel: () => void;
  onSave: (next: { display_name: string; email: string }) => void;
  pending: boolean;
  error: string | null;
}): JSX.Element {
  const [name, setName] = useState(row.display_name);
  const [email, setEmail] = useState(row.email);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <input className="hc-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      <input className="hc-input" value={email} type="email" onChange={(e) => setEmail(e.target.value)} />
      <button
        type="button"
        className="hc-btn hc-btn-primary"
        disabled={pending || !name.trim() || !email.includes('@')}
        onClick={() => onSave({ display_name: name.trim(), email: email.trim() })}
        aria-label="Save"
      >
        <Check aria-hidden size={16} />
      </button>
      <button type="button" className="hc-btn" onClick={onCancel} aria-label="Cancel" disabled={pending}>
        <X aria-hidden size={16} />
      </button>
      {error && <small style={{ color: 'var(--danger)' }}>{error}</small>}
    </div>
  );
}
