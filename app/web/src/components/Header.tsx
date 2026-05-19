// app/web/src/components/Header.tsx
//
// Sticky top header per PLAN §5.4:
//   {PetEmoji} {PetName} Cam!   [mascot]   ● live    [user menu]   ⚙ (admin only)
//
// The connection pip aggregates per-camera state into a single ok/warn/bad
// indicator. Tap it → opens a small panel listing each camera's state. The
// gear icon is rendered only when the signed-in user is an admin.

import { useMemo, useState } from 'react';
import { Settings } from 'lucide-react';
import { trpc, RouterOutputs } from '../trpc';
import { Mascot, MascotPose } from './Mascot';
import { UserMenu } from './UserMenu';
import { RoleGuard } from './RoleGuard';
import { useAuth } from '../hooks/useAuth';

type CameraDTO = RouterOutputs['cameras']['list'][number];

export interface HeaderProps {
  onOpenSettings: () => void;
  onOpenChangePassword: () => void;
  /** Most recent activity, used to drive the mascot pose. */
  activityHint?: MascotPose;
}

export function Header({ onOpenSettings, onOpenChangePassword, activityHint = 'idle' }: HeaderProps): JSX.Element {
  const { user } = useAuth();
  const settings = trpc.settings.get.useQuery(undefined, {
    enabled: !!user,
    staleTime: 60_000,
  });
  const cameras = trpc.cameras.list.useQuery(undefined, {
    enabled: !!user,
    refetchInterval: 15_000,
  });
  const [statusOpen, setStatusOpen] = useState(false);

  const petName = settings.data?.pet_name?.trim() ?? '';
  const petEmoji = settings.data?.pet_emoji ?? '🐾';
  const title = petName ? `${petName} Cam!` : 'Pet Cam!';
  const { aggregate, perCamera } = useMemo(
    () => computeStatus(cameras.data ?? []),
    [cameras.data],
  );

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        background: 'color-mix(in srgb, var(--surface) 92%, transparent)',
        backdropFilter: 'blur(8px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto',
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <h1 className="display" style={{ margin: 0, fontSize: 22, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span aria-hidden>{petEmoji}</span>
          {title}
        </h1>

        <div aria-hidden style={{ display: 'inline-flex', marginLeft: 4 }}>
          <Mascot emoji={petEmoji} pose={activityHint} size={28} ariaLabel="Pet mascot" />
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="hc-btn"
            onClick={() => setStatusOpen((v) => !v)}
            aria-expanded={statusOpen}
            aria-haspopup="dialog"
            aria-label={`Connection status: ${describe(aggregate)}`}
            style={{ minHeight: 48, padding: '0 12px' }}
          >
            <span className={`hc-status-pip ${pipClass(aggregate)}`} />
            <span style={{ fontWeight: 500 }}>{describeShort(aggregate)}</span>
          </button>
          {statusOpen && (
            <div
              role="dialog"
              aria-label="Camera status"
              style={{
                position: 'absolute',
                top: '110%',
                right: 0,
                minWidth: 260,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                boxShadow: '0 18px 36px rgba(0,0,0,0.12)',
                padding: 12,
                zIndex: 30,
              }}
            >
              {perCamera.length === 0 ? (
                <p style={{ margin: 0, color: 'var(--text-muted)' }}>No cameras yet.</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {perCamera.map((c) => (
                    <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`hc-status-pip ${pipClass(c.severity)}`} />
                      <span aria-hidden>{c.emoji}</span>
                      <span style={{ flex: 1 }}>{c.name}</span>
                      <small style={{ color: 'var(--text-muted)' }}>{c.label}</small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <UserMenu onOpenChangePassword={onOpenChangePassword} />

        <RoleGuard role="admin">
          <button
            type="button"
            className="hc-btn"
            onClick={onOpenSettings}
            aria-label="Open settings"
            style={{ minHeight: 48, padding: '0 12px' }}
          >
            <Settings aria-hidden size={20} />
          </button>
        </RoleGuard>
      </div>
    </header>
  );
}

type Severity = 'ok' | 'warn' | 'bad';

interface CameraStatusEntry {
  id: number;
  name: string;
  emoji: string;
  severity: Severity;
  label: string;
}

function computeStatus(cameras: CameraDTO[]): {
  aggregate: Severity;
  perCamera: CameraStatusEntry[];
} {
  const now = Date.now();
  const perCamera: CameraStatusEntry[] = [];
  for (const cam of cameras) {
    if (!cam.enabled) continue;
    const stale = cam.last_frame_at == null ? Infinity : now - cam.last_frame_at;
    let severity: Severity;
    let label: string;
    if (stale < 30_000) {
      severity = 'ok';
      label = 'Live';
    } else if (stale < 5 * 60_000) {
      severity = 'warn';
      label = 'Napping';
    } else {
      severity = 'bad';
      label = 'Offline';
    }
    perCamera.push({ id: cam.id, name: cam.name, emoji: cam.emoji, severity, label });
  }
  let aggregate: Severity = 'ok';
  if (perCamera.length === 0) {
    aggregate = 'warn';
  } else if (perCamera.every((c) => c.severity === 'bad')) {
    aggregate = 'bad';
  } else if (perCamera.some((c) => c.severity !== 'ok')) {
    aggregate = 'warn';
  }
  return { aggregate, perCamera };
}

function describe(s: Severity): string {
  if (s === 'ok') return 'all cameras live';
  if (s === 'warn') return 'some cameras degraded';
  return 'cameras offline';
}

function describeShort(s: Severity): string {
  if (s === 'ok') return 'live';
  if (s === 'warn') return 'check';
  return 'offline';
}

function pipClass(s: Severity): string {
  if (s === 'ok') return 'hc-status-pip-ok';
  if (s === 'warn') return 'hc-status-pip-warn';
  return 'hc-status-pip-bad';
}
