// app/web/src/components/Login.tsx
//
// Full-screen login. Single dedicated route at /login per PLAN §5.4.
// - Email + password, autofocus on email
// - Big primary button, ≥64px tap target
// - Friendly *"Forgot your password? Ask whoever set up {PetName} Cam..."* line
// - On 2xx with `mfa_required`, morphs into MfaChallenge with the same card
// - On success, navigates to the path the user originally requested (kept in
//   location.state.from), defaulting to "/"

import { FormEvent, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { LoginError } from './LoginError';
import { MfaChallenge } from './MfaChallenge';
import { Mascot } from './Mascot';
import { readCachedBrand, writeCachedBrand } from '../lib/brandCache';

// Re-export so callers that previously imported from Login.tsx keep working.
export { readCachedBrand, writeCachedBrand };

interface LocationState {
  from?: string;
}

interface MfaState {
  challengeToken: string;
}

export function Login(): JSX.Element {
  const { signIn, signInPending, signInError, verifyMfa, verifyMfaPending, verifyMfaError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const fallback = (location.state as LocationState | null)?.from ?? '/';

  // PLAN §5.4 calls for "{PetName} Cam!" branding on Login — but settings is
  // a protected procedure, so unauthed users get the generic title. After
  // first sign-in the AuthGate refetches settings; the splash on subsequent
  // signs-out still shows the pet name via the localStorage cache below.
  const cached = readCachedBrand();
  const petName = cached.petName;
  const petEmoji = cached.petEmoji;
  const title = petName ? `${petName} Cam!` : 'Pet Cam!';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [mfa, setMfa] = useState<MfaState | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!email || !password) return;
    try {
      const res = await signIn({ email: email.trim(), password });
      if ('mfa_required' in res) {
        setMfa({ challengeToken: res.mfa_challenge.token });
        return;
      }
      navigate(fallback, { replace: true });
    } catch {
      // Error is stored in signInError; nothing else to do here.
    }
  }

  async function handleMfaVerify(code: string): Promise<void> {
    if (!mfa) return;
    try {
      await verifyMfa({ challenge_token: mfa.challengeToken, code });
      navigate(fallback, { replace: true });
    } catch {
      /* surfaced via verifyMfaError */
    }
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background:
          'radial-gradient(ellipse at top, color-mix(in srgb, var(--accent) 18%, var(--bg)) 0%, var(--bg) 60%)',
      }}
    >
      <section
        className="hc-card"
        aria-labelledby="login-title"
        style={{
          width: '100%',
          maxWidth: 420,
          padding: 28,
          boxShadow: '0 18px 40px rgba(0,0,0,0.12)',
          borderRadius: 22,
          position: 'relative',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div aria-hidden style={{ fontSize: 56, lineHeight: 1, marginBottom: 8 }}>{petEmoji}</div>
          <h1 id="login-title" className="display" style={{ fontSize: 30, margin: 0 }}>{title}</h1>
          <p style={{ color: 'var(--text-muted)', marginTop: 6 }}>Sign in to see your pet!</p>
        </div>

        {mfa ? (
          <MfaChallenge
            challengeToken={mfa.challengeToken}
            onSubmit={handleMfaVerify}
            isPending={verifyMfaPending}
            error={verifyMfaError}
            onCancel={() => setMfa(null)}
          />
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <LoginError error={signInError} />
            <div>
              <label htmlFor="login-email" className="hc-label">Email</label>
              <input
                id="login-email"
                className="hc-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="login-password" className="hc-label">Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="login-password"
                  className="hc-input"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  style={{ paddingRight: 52 }}
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="hc-btn hc-btn-ghost"
                  onClick={() => setShowPassword((v) => !v)}
                  style={{
                    position: 'absolute',
                    right: 6,
                    top: 4,
                    height: 48,
                    minHeight: 48,
                    padding: '0 12px',
                  }}
                >
                  {showPassword ? <EyeOff aria-hidden size={20} /> : <Eye aria-hidden size={20} />}
                </button>
              </div>
            </div>
            <button
              type="submit"
              className="hc-btn hc-btn-primary"
              disabled={signInPending || !email || !password}
              style={{ marginTop: 6 }}
            >
              {signInPending ? 'Signing in…' : 'Sign in'}
            </button>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4, textAlign: 'center' }}>
              Forgot your password? Ask whoever set up {petName ? `${petName} Cam` : 'Pet Cam'} to send a reset email.
            </p>
          </form>
        )}

        <div
          aria-hidden
          style={{
            position: 'absolute',
            bottom: -8,
            right: -4,
            width: 64,
            height: 64,
          }}
        >
          <Mascot emoji={petEmoji} pose="waving" size={56} />
        </div>
      </section>
    </main>
  );
}
