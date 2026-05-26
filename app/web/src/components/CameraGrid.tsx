// app/web/src/components/CameraGrid.tsx
//
// Responsive grid of CameraTile. Uses CSS grid auto-fit / minmax(280px, 1fr)
// so it scales from 1 → N cameras. Empty state opens Settings → Cameras for
// admins; child accounts see a friendly "ask a grown-up" message.

import { useMemo, useState } from 'react';
import { trpc } from '../trpc';
import { CameraTile } from './CameraTile';
import { MaximizedCamera } from './MaximizedCamera';
import { useAuth } from '../hooks/useAuth';

export interface CameraGridProps {
  onAdminOpenCameras?: () => void;
}

export function CameraGrid({ onAdminOpenCameras }: CameraGridProps): JSX.Element {
  const { isAdmin } = useAuth();
  const cameras = trpc.cameras.list.useQuery(undefined, {
    refetchInterval: 15_000,
  });
  const settings = trpc.settings.get.useQuery();
  const [maximizedId, setMaximizedId] = useState<number | null>(null);

  const list = useMemo(
    () => (cameras.data ?? []).filter((c) => c.enabled).sort((a, b) => a.position - b.position),
    [cameras.data],
  );

  // Show the loading skeleton while the first fetch is in flight OR while a
  // cold fetch has errored/is retrying with no data yet. We must NOT fall
  // through to the "set up your first camera" prompt on a transient failure:
  // in TanStack Query v4 the query only leaves `isLoading` once all retries are
  // exhausted, and on error `data` stays undefined — which used to render a
  // scary false "no cameras" message for ~20-30s until the 15s background
  // refetch healed it (same client-side recovery gap as the settings flow —
  // see project_web_resilience). Gating on `data === undefined` keys off the
  // real signal: React Query keeps `data` populated across later refetch
  // errors, so this only covers the genuine cold-start window.
  if (cameras.data === undefined) {
    return (
      <section aria-label="Cameras" style={gridStyle}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="hc-card-raised" style={{ aspectRatio: '16 / 9' }} />
        ))}
      </section>
    );
  }

  // Genuinely zero cameras: the query succeeded and returned an empty list.
  if (list.length === 0) {
    return (
      <section className="hc-card" style={{ padding: 24, textAlign: 'center' }}>
        <h2 className="display" style={{ marginTop: 0 }}>Let's set up your first camera!</h2>
        {isAdmin && onAdminOpenCameras ? (
          <button type="button" className="hc-btn hc-btn-primary" onClick={onAdminOpenCameras}>
            Open camera setup
          </button>
        ) : (
          <p style={{ color: 'var(--text-muted)' }}>Ask a grown-up to add a camera.</p>
        )}
      </section>
    );
  }

  const petName = settings.data?.pet_name ?? '';
  const petEmoji = settings.data?.pet_emoji ?? '🐾';

  return (
    <>
      <section aria-label="Cameras" style={gridStyle}>
        {list.map((cam) => (
          <CameraTile
            key={cam.id}
            camera={cam}
            petName={petName}
            petEmoji={petEmoji}
            isAdmin={isAdmin}
            onMaximize={(id) => setMaximizedId(id)}
            onAdminFix={onAdminOpenCameras ? () => onAdminOpenCameras() : undefined}
          />
        ))}
      </section>
      {maximizedId != null && (
        <MaximizedCamera
          initialCameraId={maximizedId}
          cameras={list}
          petName={petName}
          petEmoji={petEmoji}
          autoRotate={settings.data?.auto_rotate ?? false}
          onClose={() => setMaximizedId(null)}
        />
      )}
    </>
  );
}

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 16,
} as const;
