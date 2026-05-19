// app/web/src/components/SettingsDrawer.tsx
//
// Admin-only drawer with five tabs. The gear icon in Header only renders for
// admins, but we also bail at render-time if `useAuth().isAdmin` is false —
// double-checked defense.

import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { X } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { PetSettings } from './PetSettings';
import { CameraSettings } from './CameraSettings';
import { UserSettings } from './UserSettings';
import { AuditSettings } from './AuditSettings';
import { ShareSettings } from './ShareSettings';

export interface SettingsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: SettingsTabId;
}

export type SettingsTabId = 'pet' | 'cameras' | 'users' | 'audit' | 'sharing';

const TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: 'pet', label: 'Pet' },
  { id: 'cameras', label: 'Cameras' },
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit' },
  { id: 'sharing', label: 'Sharing' },
];

export function SettingsDrawer({ open, onOpenChange, initialTab = 'pet' }: SettingsDrawerProps): JSX.Element | null {
  const { isAdmin } = useAuth();
  if (!isAdmin) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 80,
          }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            height: '100%',
            width: 'min(560px, 100vw)',
            background: 'var(--surface)',
            borderLeft: '1px solid var(--border)',
            boxShadow: '-18px 0 36px rgba(0,0,0,0.18)',
            zIndex: 81,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <header
            style={{
              padding: '14px 16px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Dialog.Title className="display" style={{ margin: 0, flex: 1 }}>Settings</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="hc-btn" aria-label="Close settings">
                <X aria-hidden size={20} />
              </button>
            </Dialog.Close>
          </header>

          <Tabs.Root defaultValue={initialTab} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Tabs.List
              aria-label="Settings sections"
              style={{
                display: 'flex',
                gap: 4,
                padding: 8,
                borderBottom: '1px solid var(--border)',
                overflowX: 'auto',
              }}
            >
              {TABS.map((t) => (
                <Tabs.Trigger
                  key={t.id}
                  value={t.id}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    padding: '10px 14px',
                    borderRadius: 10,
                    fontWeight: 500,
                    cursor: 'pointer',
                    minHeight: 40,
                  }}
                  className="hc-tab-trigger"
                >
                  {t.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
              <Tabs.Content value="pet"><PetSettings /></Tabs.Content>
              <Tabs.Content value="cameras"><CameraSettings /></Tabs.Content>
              <Tabs.Content value="users"><UserSettings /></Tabs.Content>
              <Tabs.Content value="audit"><AuditSettings /></Tabs.Content>
              <Tabs.Content value="sharing"><ShareSettings /></Tabs.Content>
            </div>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
