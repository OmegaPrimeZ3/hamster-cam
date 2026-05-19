// app/web/src/components/AuthGate.tsx
//
// Calls /auth/me on mount; while loading, shows a friendly splash; if not
// signed in, redirects to /login while preserving the requested path so we
// can bounce back after sign-in.

import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { Mascot } from './Mascot';

export interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps): JSX.Element {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <AuthSplash />;
  }
  if (!user) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <>{children}</>;
}

function AuthSplash(): JSX.Element {
  return (
    <main
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <Mascot pose="waving" size={72} ariaLabel="Loading" />
      <p style={{ color: 'var(--text-muted)' }}>Looking for your pet…</p>
    </main>
  );
}
