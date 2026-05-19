// app/web/src/components/AddUserForm.tsx
//
// Admin-only "Add account" form. Calls users.create which atomically
// registers the Zyphr account and writes the local mirror row.

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { trpc } from '../trpc';
import type { Role } from '../lib/auth-api';

export interface AddUserFormProps {
  onDone: () => void;
}

export function AddUserForm({ onDone }: AddUserFormProps): JSX.Element {
  const utils = trpc.useUtils();
  const create = trpc.users.create.useMutation({
    onSuccess: async () => {
      await utils.users.list.invalidate();
      onDone();
    },
  });

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<Role>('child');

  const strength = passwordStrength(password);
  const formOk = email.includes('@') && displayName.trim().length > 0 && password.length >= 6;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!formOk) return;
        create.mutate({
          email: email.trim(),
          display_name: displayName.trim(),
          password,
          role,
        });
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div>
        <label className="hc-label" htmlFor="add-email">Email</label>
        <input
          id="add-email"
          className="hc-input"
          type="email"
          inputMode="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <small style={{ color: 'var(--text-muted)' }}>
          For a child without their own inbox, use a <code>you+kidname@yourmail.com</code> alias.
        </small>
      </div>

      <div>
        <label className="hc-label" htmlFor="add-display">Display name</label>
        <input
          id="add-display"
          className="hc-input"
          value={displayName}
          maxLength={40}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
      </div>

      <div>
        <label className="hc-label" htmlFor="add-password">Password</label>
        <div style={{ position: 'relative' }}>
          <input
            id="add-password"
            className="hc-input"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            style={{ paddingRight: 52 }}
          />
          <button
            type="button"
            className="hc-btn hc-btn-ghost"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            onClick={() => setShowPassword((v) => !v)}
            style={{ position: 'absolute', right: 6, top: 4, height: 48, minHeight: 48, padding: '0 12px' }}
          >
            {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
          </button>
        </div>
        <small style={{ color: strength.color }}>{strength.label}</small>
      </div>

      <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className="hc-label">Role</legend>
        <div role="radiogroup" style={{ display: 'flex', gap: 8 }}>
          {(['admin', 'child'] as Role[]).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={role === r}
              onClick={() => setRole(r)}
              className="hc-btn"
              style={{
                background: role === r ? 'var(--accent)' : 'var(--surface)',
                color: role === r ? 'var(--accent-text)' : 'var(--text)',
              }}
            >
              {r === 'admin' ? 'Admin (full access)' : 'Child (cameras + diary)'}
            </button>
          ))}
        </div>
      </fieldset>

      {create.error && <p role="alert" style={{ color: 'var(--danger)' }}>{create.error.message}</p>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          className="hc-btn hc-btn-primary"
          disabled={!formOk || create.isLoading}
        >
          {create.isLoading ? 'Creating…' : 'Create account'}
        </button>
        <button type="button" className="hc-btn" onClick={onDone} disabled={create.isLoading}>Cancel</button>
      </div>
    </form>
  );
}

function passwordStrength(pw: string): { label: string; color: string } {
  if (pw.length === 0) return { label: ' ', color: 'var(--text-muted)' };
  if (pw.length < 6) return { label: 'Too short', color: 'var(--danger)' };
  if (pw.length < 12) return { label: 'Fine for a child', color: 'var(--text-muted)' };
  return { label: 'Stronger', color: 'var(--success)' };
}
