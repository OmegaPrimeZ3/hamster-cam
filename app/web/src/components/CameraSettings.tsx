// app/web/src/components/CameraSettings.tsx
//
// Cameras tab. Lists configured cameras with reorder (up/down for
// accessibility — drag is a nice-to-have but keyboard users need a way too),
// edit, delete, and an "Add camera" panel.

import { useState } from 'react';
import { ChevronUp, ChevronDown, Pencil, Trash2, Plus } from 'lucide-react';
import { trpc, RouterOutputs } from '../trpc';
import { AddCameraForm } from './AddCameraForm';
import { activityStyle, isZoneActivity, zoneLabel } from '../lib/activity-style';

type CameraDTO = RouterOutputs['cameras']['list'][number];

// Reference list shown to operators in the Cameras tab so they know which
// Frigate zone names map to which activity. Keep in sync with `matchKeyword`
// in app/server/src/narrator.ts.
const SUPPORTED_ZONES: ReadonlyArray<{
  activity: string;
  emoji: string;
  primary: string;
  aliases: readonly string[];
  description: string;
}> = [
  { activity: 'wheel',    emoji: '🎡', primary: 'wheel',    aliases: [],                              description: 'Running wheel' },
  { activity: 'food',     emoji: '🥕', primary: 'food',     aliases: ['bowl', 'feed'],                description: 'Food bowl / feeding area' },
  { activity: 'water',    emoji: '💧', primary: 'water',    aliases: ['drink'],                       description: 'Water bottle / drinking spot' },
  { activity: 'bathroom', emoji: '🚽', primary: 'bathroom', aliases: ['potty', 'litter', 'toilet'],   description: 'Potty corner' },
  { activity: 'resting',  emoji: '💤', primary: 'bed',      aliases: ['nest', 'sleep', 'rest'],       description: 'Sleeping nest' },
  { activity: 'tunnel',   emoji: '🕳️', primary: 'tunnel',   aliases: ['tube', 'pipe'],                description: 'Tube / pipe enrichment' },
  { activity: 'hiding',   emoji: '🙈', primary: 'hide',     aliases: ['cave', 'burrow'],              description: 'Hideout / burrow' },
];

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
                  <div
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}
                    aria-label="Configured zones"
                  >
                    {cam.zones.filter(isZoneActivity).length === 0 ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '4px 8px',
                          borderRadius: 999,
                          border: '1px dashed var(--border)',
                          color: 'var(--text-muted)',
                          fontSize: 12,
                          lineHeight: 1.2,
                          fontStyle: 'italic',
                        }}
                      >
                        no zones configured
                      </span>
                    ) : (
                      cam.zones.filter(isZoneActivity).map((z) => {
                        const { accent, badgeEmoji } = activityStyle(z);
                        return (
                          <span
                            key={z}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '4px 8px',
                              borderRadius: 999,
                              background: `color-mix(in srgb, ${accent} 18%, transparent)`,
                              border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
                              color: 'var(--text)',
                              fontSize: 12,
                              lineHeight: 1.2,
                            }}
                          >
                            <span aria-hidden>{badgeEmoji}</span> {zoneLabel(z)}
                          </span>
                        );
                      })
                    )}
                  </div>
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

      <section className="hc-card" style={{ padding: 12, marginTop: 8 }}>
        <h4 className="display" style={{ margin: '0 0 4px' }}>Supported zones</h4>
        <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', fontSize: 13 }}>
          Name your Frigate zones with one of the keywords below — the narrator
          will classify motion in that zone as the matching activity. Unmatched
          zones fall through to <strong>exploring</strong>.
        </p>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {SUPPORTED_ZONES.map((z) => (
            <li
              key={z.activity}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}
            >
              <span aria-hidden style={{ fontSize: 20, width: 24, textAlign: 'center' }}>{z.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                  <code style={{
                    fontWeight: 600,
                    background: 'var(--surface-2, rgba(0,0,0,0.06))',
                    padding: '1px 6px',
                    borderRadius: 4,
                  }}>{z.primary}</code>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    → {z.activity}
                  </span>
                </div>
                <small style={{ color: 'var(--text-muted)', display: 'block' }}>
                  {z.description}
                  {z.aliases.length > 0 && (
                    <> · also matches: {z.aliases.map((a) => <code key={a} style={{ marginRight: 4 }}>{a}</code>)}</>
                  )}
                </small>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
