// app/web/src/components/CameraSettings.tsx
//
// Cameras tab. Lists configured cameras with reorder (up/down for
// accessibility — drag is a nice-to-have but keyboard users need a way too),
// edit, delete, and an "Add camera" panel.

import { useState } from 'react';
import { ChevronUp, ChevronDown, Pencil, Trash2, Plus } from 'lucide-react';
import { trpc, RouterOutputs } from '../trpc';
import { AddCameraForm } from './AddCameraForm';

type CameraDTO = RouterOutputs['cameras']['list'][number];

export function CameraSettings(): JSX.Element {
  const utils = trpc.useUtils();
  const cameras = trpc.cameras.list.useQuery();
  const reorder = trpc.cameras.reorder.useMutation({
    onSuccess: async () => {
      await utils.cameras.list.invalidate();
    },
  });
  const deleteCam = trpc.cameras.delete.useMutation({
    onSuccess: async () => {
      await utils.cameras.list.invalidate();
    },
  });
  const [editing, setEditing] = useState<CameraDTO | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const list = (cameras.data ?? []).slice().sort((a, b) => a.position - b.position);

  function move(id: number, dir: -1 | 1): void {
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= list.length) return;
    const next = list.slice();
    const a = next[idx]!;
    const b = next[swapWith]!;
    next[idx] = b;
    next[swapWith] = a;
    reorder.mutate({ ordered_ids: next.map((c) => c.id) });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 className="display" style={{ margin: 0 }}>Cameras</h3>
        <button type="button" className="hc-btn" onClick={() => setAdding((v) => !v)}>
          <Plus aria-hidden size={16} /> {adding ? 'Cancel' : 'Add camera'}
        </button>
      </div>

      {adding && (
        <div className="hc-card-raised" style={{ padding: 12 }}>
          <AddCameraForm onDone={() => setAdding(false)} />
        </div>
      )}

      {cameras.isLoading && <p>Loading…</p>}
      {!cameras.isLoading && list.length === 0 && <p style={{ color: 'var(--text-muted)' }}>No cameras yet.</p>}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((cam, i) => (
          <li key={cam.id} className="hc-card" style={{ padding: 12 }}>
            {editing?.id === cam.id ? (
              <AddCameraForm existing={cam} onDone={() => setEditing(null)} />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <button
                    type="button"
                    className="hc-btn hc-btn-ghost"
                    aria-label="Move up"
                    onClick={() => move(cam.id, -1)}
                    disabled={i === 0 || reorder.isLoading}
                    style={{ minHeight: 28, padding: '0 8px' }}
                  >
                    <ChevronUp aria-hidden size={16} />
                  </button>
                  <button
                    type="button"
                    className="hc-btn hc-btn-ghost"
                    aria-label="Move down"
                    onClick={() => move(cam.id, 1)}
                    disabled={i === list.length - 1 || reorder.isLoading}
                    style={{ minHeight: 28, padding: '0 8px' }}
                  >
                    <ChevronDown aria-hidden size={16} />
                  </button>
                </div>
                <span aria-hidden style={{ fontSize: 20 }}>{cam.emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{cam.name}</div>
                  <small style={{ color: 'var(--text-muted)', wordBreak: 'break-all' }}>{cam.stream_url}</small>
                </div>
                <span
                  className={`hc-status-pip ${
                    cam.last_frame_at == null ? 'hc-status-pip-warn' :
                      Date.now() - cam.last_frame_at < 30_000 ? 'hc-status-pip-ok' :
                      Date.now() - cam.last_frame_at < 5 * 60_000 ? 'hc-status-pip-warn' :
                      'hc-status-pip-bad'
                  }`}
                  aria-label="Status"
                />
                <button
                  type="button"
                  className="hc-btn"
                  aria-label={`Edit ${cam.name}`}
                  onClick={() => setEditing(cam)}
                >
                  <Pencil aria-hidden size={16} />
                </button>
                <button
                  type="button"
                  className={confirmDelete === cam.id ? 'hc-btn hc-btn-danger' : 'hc-btn'}
                  aria-label={`Delete ${cam.name}`}
                  onClick={() => {
                    if (confirmDelete === cam.id) {
                      deleteCam.mutate({ id: cam.id });
                      setConfirmDelete(null);
                    } else {
                      setConfirmDelete(cam.id);
                      window.setTimeout(
                        () => setConfirmDelete((c) => (c === cam.id ? null : c)),
                        3500,
                      );
                    }
                  }}
                >
                  <Trash2 aria-hidden size={16} />
                  {confirmDelete === cam.id ? ' Confirm' : ''}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
