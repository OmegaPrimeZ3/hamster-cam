// app/web/src/components/RoleGuard.tsx
//
// UX-only role gate. Server-side enforcement still lives in adminProcedure.
// `<RoleGuard role="admin"><Gear /></RoleGuard>` — renders children iff the
// current user's role matches. `fallback` lets a caller render an alternate
// node (defaults to null).

import { ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth';
import type { Role } from '../lib/auth-api';

export interface RoleGuardProps {
  role: Role;
  children: ReactNode;
  fallback?: ReactNode;
}

export function RoleGuard({ role, children, fallback = null }: RoleGuardProps): JSX.Element {
  const { user } = useAuth();
  if (!user) return <>{fallback}</>;
  if (user.role !== role) return <>{fallback}</>;
  return <>{children}</>;
}
