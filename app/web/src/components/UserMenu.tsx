// app/web/src/components/UserMenu.tsx
//
// "Hi, {DisplayName}!" chip in the header with a single-item menu:
// Sign out (and, for child accounts, "Change my password" since they have
// no Settings drawer to find it in).
//
// Implemented as a Radix-free disclosure to keep the footprint small; this
// is a one-level menu, not a tree.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, LogOut, KeyRound } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

export interface UserMenuProps {
  onOpenChangePassword?: () => void;
}

export function UserMenu({ onOpenChangePassword }: UserMenuProps): JSX.Element | null {
  const { user, signOut, signOutPending } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!user) return null;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="hc-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ minHeight: 48 }}
      >
        <span>Hi, {user.display_name}!</span>
        <ChevronDown aria-hidden size={16} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '110%',
            right: 0,
            minWidth: 220,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 18px 36px rgba(0,0,0,0.12)',
            padding: 6,
            zIndex: 30,
          }}
        >
          {onOpenChangePassword && (
            <button
              role="menuitem"
              type="button"
              className="hc-btn hc-btn-ghost"
              onClick={() => {
                setOpen(false);
                onOpenChangePassword();
              }}
              style={{ width: '100%', justifyContent: 'flex-start' }}
            >
              <KeyRound aria-hidden size={18} />
              Change my password
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            className="hc-btn hc-btn-ghost"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            disabled={signOutPending}
            style={{ width: '100%', justifyContent: 'flex-start' }}
          >
            <LogOut aria-hidden size={18} />
            {signOutPending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
