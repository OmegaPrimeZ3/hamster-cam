// app/web/src/components/OnboardingWizard.tsx
//
// First-run flow per PLAN §5.4. Admin-only (server gates the underlying
// settings.update mutation; we render this only when `isAdmin && !onboarded`).
// Three full-screen steps, each one decision, big buttons.

import { useState } from 'react';
import { trpc } from '../trpc';
import { PALETTES, PaletteName } from '../theme';
import { Mascot } from './Mascot';
import { writeCachedBrand } from './Login';

const PET_EMOJIS = ['🐹', '🐰', '🐶', '🐱', '🐦', '🦔', '🦎', '🐠', '🐢', '🐍', '🐾'];

type Step = 1 | 2 | 3;

interface Picks {
  name: string;
  emoji: string;
  theme: PaletteName;
}

export function OnboardingWizard(): JSX.Element {
  const utils = trpc.useUtils();
  const updateMut = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.get.invalidate();
    },
  });

  const [step, setStep] = useState<Step>(1);
  const [picks, setPicks] = useState<Picks>({ name: '', emoji: '🐹', theme: 'bubblegum' });

  async function finish(final: Picks): Promise<void> {
    await updateMut.mutateAsync({
      pet_name: final.name.trim(),
      pet_emoji: final.emoji,
      theme: final.theme,
      onboarding_complete: true,
    });
    writeCachedBrand({ petName: final.name.trim(), petEmoji: final.emoji });
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <section
        className="hc-card"
        style={{ width: '100%', maxWidth: 520, padding: 28, borderRadius: 22 }}
        aria-labelledby="onboarding-title"
      >
        {step === 1 && (
          <StepName
            value={picks.name}
            onChange={(name) => setPicks((p) => ({ ...p, name }))}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <StepEmoji
            value={picks.emoji}
            onPick={(emoji) => {
              setPicks((p) => ({ ...p, emoji }));
              setStep(3);
            }}
          />
        )}
        {step === 3 && (
          <StepTheme
            value={picks.theme}
            onPick={async (theme) => {
              const next = { ...picks, theme };
              setPicks(next);
              await finish(next);
            }}
            pending={updateMut.isLoading}
            error={updateMut.error?.message ?? null}
          />
        )}
      </section>
    </main>
  );
}

function StepName({
  value,
  onChange,
  onNext,
}: {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
}): JSX.Element {
  return (
    <>
      <Header text="What's your pet's name?" />
      <input
        className="hc-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={24}
        autoFocus
        aria-label="Pet name"
      />
      <Footer
        primaryLabel="Next"
        primaryDisabled={value.trim().length === 0}
        onPrimary={onNext}
      />
    </>
  );
}

function StepEmoji({ value, onPick }: { value: string; onPick: (v: string) => void }): JSX.Element {
  return (
    <>
      <Header text="What kind of pet?" />
      <div
        role="radiogroup"
        aria-label="Pet kind"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))',
          gap: 10,
          margin: '12px 0 20px',
        }}
      >
        {PET_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            role="radio"
            aria-checked={value === emoji}
            aria-label={emoji === '🐾' ? 'Other' : emoji}
            onClick={() => onPick(emoji)}
            style={{
              fontSize: 32,
              padding: 12,
              borderRadius: 14,
              border: value === emoji ? '2px solid var(--accent)' : '1.5px solid var(--border)',
              background: 'var(--surface-raised)',
              cursor: 'pointer',
              minHeight: 72,
            }}
          >
            <span aria-hidden>{emoji}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function StepTheme({
  value,
  onPick,
  pending,
  error,
}: {
  value: PaletteName;
  onPick: (v: PaletteName) => Promise<void>;
  pending: boolean;
  error: string | null;
}): JSX.Element {
  return (
    <>
      <Header text="Pick your colors!" />
      <div
        role="radiogroup"
        aria-label="Theme color"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 10,
          margin: '12px 0 20px',
        }}
      >
        {PALETTES.map((p) => (
          <button
            key={p.name}
            type="button"
            role="radio"
            aria-checked={value === p.name}
            disabled={pending}
            onClick={() => void onPick(p.name)}
            style={{
              padding: 14,
              borderRadius: 14,
              border: value === p.name ? '2px solid var(--text)' : '1.5px solid var(--border)',
              background: p.light.bg,
              color: p.light.text,
              cursor: 'pointer',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minHeight: 64,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: p.swatchPreview,
                boxShadow: '0 0 0 2px white inset',
              }}
            />
            {p.label}
          </button>
        ))}
      </div>
      {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
      {pending && <p style={{ color: 'var(--text-muted)' }}>Saving…</p>}
    </>
  );
}

function Header({ text }: { text: string }): JSX.Element {
  return (
    <div style={{ textAlign: 'center', marginBottom: 14 }}>
      <Mascot pose="waving" size={56} />
      <h1 id="onboarding-title" className="display" style={{ fontSize: 24, margin: '10px 0 0' }}>
        {text}
      </h1>
    </div>
  );
}

function Footer({
  primaryLabel,
  primaryDisabled,
  onPrimary,
}: {
  primaryLabel: string;
  primaryDisabled: boolean;
  onPrimary: () => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
      <button
        type="button"
        className="hc-btn hc-btn-primary"
        disabled={primaryDisabled}
        onClick={onPrimary}
      >
        {primaryLabel}
      </button>
    </div>
  );
}
