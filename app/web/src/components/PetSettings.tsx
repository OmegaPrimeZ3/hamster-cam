// app/web/src/components/PetSettings.tsx
//
// Pet tab of the Settings drawer.

import { useEffect, useState } from 'react';
import { trpc } from '../trpc';
import { PALETTES, PaletteName, ThemeModeSetting } from '../theme';
import { useAuth } from '../hooks/useAuth';
import { ChangePasswordForm } from './ChangePasswordForm';
import { writeCachedBrand } from './Login';

const PET_EMOJIS = ['🐹', '🐰', '🐶', '🐱', '🐦', '🦔', '🦎', '🐠', '🐢', '🐍', '🐾'];

export function PetSettings(): JSX.Element {
  const { signOut } = useAuth();
  const settings = trpc.settings.get.useQuery();
  const utils = trpc.useUtils();
  const update = trpc.settings.update.useMutation({
    onSuccess: async (next) => {
      await utils.settings.get.invalidate();
      writeCachedBrand({ petName: next.pet_name, petEmoji: next.pet_emoji });
    },
  });

  const [name, setName] = useState('');
  const [restartConfirm, setRestartConfirm] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);

  useEffect(() => {
    if (settings.data) setName(settings.data.pet_name);
  }, [settings.data]);

  if (!settings.data) return <p>Loading…</p>;
  const s = settings.data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Field label="Pet name">
        <input
          className="hc-input"
          value={name}
          maxLength={24}
          onChange={(e) => {
            const v = e.target.value;
            setName(v);
            // Live save with a tiny debounce — but keep it simple: save on blur.
          }}
          onBlur={() => {
            if (name !== s.pet_name) update.mutate({ pet_name: name });
          }}
        />
      </Field>

      <Field label="Pet emoji">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PET_EMOJIS.map((e) => (
            <button
              key={e}
              type="button"
              aria-label={`Pet emoji ${e}`}
              aria-pressed={s.pet_emoji === e}
              onClick={() => update.mutate({ pet_emoji: e })}
              style={{
                fontSize: 24,
                padding: 8,
                borderRadius: 10,
                background: s.pet_emoji === e ? 'var(--accent)' : 'var(--surface-raised)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                minHeight: 48,
                minWidth: 48,
              }}
            >
              <span aria-hidden>{e}</span>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Theme color">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          {PALETTES.map((p) => (
            <button
              key={p.name}
              type="button"
              aria-label={p.label}
              aria-pressed={s.theme === p.name}
              onClick={() => update.mutate({ theme: p.name })}
              style={{
                padding: 10,
                borderRadius: 12,
                border: s.theme === p.name ? '2px solid var(--text)' : '1.5px solid var(--border)',
                background: p.light.bg,
                color: p.light.text,
                cursor: 'pointer',
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                minHeight: 48,
              }}
            >
              <span
                aria-hidden
                style={{ width: 18, height: 18, borderRadius: '50%', background: p.swatchPreview }}
              />
              {p.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Theme mode">
        <div role="radiogroup" style={{ display: 'flex', gap: 8 }}>
          {(['light', 'dark', 'auto'] as ThemeModeSetting[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={s.theme_mode === m}
              onClick={() => update.mutate({ theme_mode: m })}
              className="hc-btn"
              style={{
                background: s.theme_mode === m ? 'var(--accent)' : 'var(--surface)',
                color: s.theme_mode === m ? 'var(--accent-text)' : 'var(--text)',
              }}
            >
              {m === 'auto' ? 'Match system' : m === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </Field>

      <Toggle
        label="Read aloud new diary entries"
        checked={s.read_aloud}
        onChange={(v) => update.mutate({ read_aloud: v })}
      />

      <Toggle
        label="Auto-rotate cameras every 10s"
        checked={s.auto_rotate}
        onChange={(v) => update.mutate({ auto_rotate: v })}
      />

      <Field label="Account">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="hc-btn" onClick={() => setShowChangePw((v) => !v)}>
            {showChangePw ? 'Hide' : 'Change my password'}
          </button>
          <button
            type="button"
            className="hc-btn"
            onClick={() => {
              if (!restartConfirm) {
                setRestartConfirm(true);
                window.setTimeout(() => setRestartConfirm(false), 4000);
                return;
              }
              update.mutate({ onboarding_complete: false });
              setRestartConfirm(false);
            }}
          >
            {restartConfirm ? 'Tap again to confirm restart' : 'Restart onboarding'}
          </button>
          <button type="button" className="hc-btn hc-btn-danger" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
        {showChangePw && (
          <div style={{ marginTop: 12 }}>
            <ChangePasswordForm onClose={() => setShowChangePw(false)} />
          </div>
        )}
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="hc-label">{label}</div>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 22, height: 22 }}
      />
      <span>{label}</span>
    </label>
  );
}
