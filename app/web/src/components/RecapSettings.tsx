// app/web/src/components/RecapSettings.tsx
//
// "Nightly Recap" settings tab — nightly video + AI story.
// Section A: timelapse_enabled toggle + zone priority reorder.
// Section B: recap_enabled toggle (moved from PetSettings) + names chip editor.

import { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { trpc } from '../trpc';
import { Toggle } from './PetSettings';

// ─── Zone catalogue ────────────────────────────────────────────────────────────
// Order here is the canonical DEFAULT when recap_video_zone_priority is "".
// Friendly labels mirror the narratives the kids already read in the diary.

const ALL_ZONES: ReadonlyArray<{ token: string; label: string; emoji: string }> = [
  { token: 'wheel',     label: 'Running wheel',    emoji: '🎡' },
  { token: 'food',      label: 'Snack time',        emoji: '🥕' },
  { token: 'water',     label: 'Drinking',          emoji: '💧' },
  { token: 'bathroom',  label: 'Bathroom',          emoji: '🚽' },
  { token: 'resting',   label: 'Resting',           emoji: '😴' },
  { token: 'tunnel',    label: 'Tunnel adventures', emoji: '🕳️' },
  { token: 'exploring', label: 'Exploring',         emoji: '🔍' },
  { token: 'hiding',    label: 'Hiding away',       emoji: '🫣' },
];

const DEFAULT_ORDER = ALL_ZONES.map((z) => z.token);

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parsePriorityCSV(raw: string): string[] {
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && DEFAULT_ORDER.includes(t));
  // Append any missing tokens so all 8 are always represented.
  const seen = new Set(tokens);
  for (const t of DEFAULT_ORDER) {
    if (!seen.has(t)) tokens.push(t);
  }
  return tokens;
}

function serializeOrder(order: string[]): string {
  return order.join(',');
}

// ─── Component ─────────────────────────────────────────────────────────────────

const MAX_NAMES = 5;

export function RecapSettings(): JSX.Element {
  const settings = trpc.settings.get.useQuery();
  const utils = trpc.useUtils();
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.get.invalidate();
    },
  });

  const [nameInput, setNameInput] = useState('');

  if (!settings.data) return <p>Loading…</p>;
  const s = settings.data;

  // ── Zone priority state derived from server (no local copy — keep it simple) ──
  const isCustomOrder = s.recap_video_zone_priority.trim() !== '';
  const zoneOrder = isCustomOrder
    ? parsePriorityCSV(s.recap_video_zone_priority)
    : DEFAULT_ORDER.slice();

  function moveZone(idx: number, dir: -1 | 1): void {
    const next = zoneOrder.slice();
    const swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= next.length) return;
    const a = next[idx]!;
    const b = next[swapWith]!;
    next[idx] = b;
    next[swapWith] = a;
    update.mutate({ recap_video_zone_priority: serializeOrder(next) });
  }

  function resetZoneOrder(): void {
    update.mutate({ recap_video_zone_priority: '' });
  }

  // ── Names (CSV chips) ─────────────────────────────────────────────────────────
  const currentNames: string[] = s.recap_names
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);

  function addName(): void {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    if (currentNames.length >= MAX_NAMES) return;
    // Case-insensitive dedup
    const lower = trimmed.toLowerCase();
    if (currentNames.some((n) => n.toLowerCase() === lower)) {
      setNameInput('');
      return;
    }
    const next = [...currentNames, trimmed];
    setNameInput('');
    update.mutate({ recap_names: next.join(',') });
  }

  function removeName(name: string): void {
    const next = currentNames.filter((n) => n !== name);
    update.mutate({ recap_names: next.join(',') });
  }

  const priorityDimmed = !s.timelapse_enabled;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ═══ SECTION A — NIGHTLY VIDEO ════════════════════════════════════════ */}
      <section className="hc-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h3 className="display" style={{ margin: 0, fontSize: 18 }}>Nightly Video</h3>

        <Toggle
          label="🎬 Nightly recap video"
          hint="Auto-generate a short highlight video each morning."
          checked={s.timelapse_enabled}
          onChange={(v) => update.mutate({ timelapse_enabled: v })}
        />

        {/* Zone priority list */}
        <div style={{ opacity: priorityDimmed ? 0.45 : 1, transition: 'opacity 0.2s' }}>
          <div className="hc-label" style={{ marginBottom: 4 }}>Clip priority</div>
          <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            The top activity is guaranteed a featured clip. Reorder to control what
            leads the video.
          </p>

          {!isCustomOrder && (
            <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Using default ordering — reorder to customize.
            </p>
          )}

          <ul
            style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
            aria-label="Zone priority order"
          >
            {zoneOrder.map((token, i) => {
              const zone = ALL_ZONES.find((z) => z.token === token);
              if (!zone) return null;
              return (
                <li
                  key={token}
                  className="hc-card"
                  style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 10 }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <button
                      type="button"
                      className="hc-btn hc-btn-ghost"
                      aria-label={`Move ${zone.label} up`}
                      onClick={() => moveZone(i, -1)}
                      disabled={i === 0 || update.isLoading}
                      style={{ minHeight: 28, padding: '0 8px' }}
                    >
                      <ChevronUp aria-hidden size={16} />
                    </button>
                    <button
                      type="button"
                      className="hc-btn hc-btn-ghost"
                      aria-label={`Move ${zone.label} down`}
                      onClick={() => moveZone(i, 1)}
                      disabled={i === zoneOrder.length - 1 || update.isLoading}
                      style={{ minHeight: 28, padding: '0 8px' }}
                    >
                      <ChevronDown aria-hidden size={16} />
                    </button>
                  </div>
                  <span aria-hidden style={{ fontSize: 20, width: 26, textAlign: 'center', flexShrink: 0 }}>
                    {zone.emoji}
                  </span>
                  <span style={{ flex: 1, fontWeight: 500 }}>{zone.label}</span>
                  {i === 0 && (
                    <span
                      className="hc-chip hc-chip-accent"
                      style={{ fontSize: 11, padding: '2px 8px' }}
                    >
                      featured
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {isCustomOrder && (
            <button
              type="button"
              className="hc-btn hc-btn-ghost"
              onClick={resetZoneOrder}
              disabled={update.isLoading}
              style={{ marginTop: 8, minHeight: 36, fontSize: 13, color: 'var(--text-muted)' }}
            >
              Reset to default order
            </button>
          )}
        </div>
      </section>

      {/* ═══ SECTION B — AI RECAP STORY ═══════════════════════════════════════ */}
      <section className="hc-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h3 className="display" style={{ margin: 0, fontSize: 18 }}>AI Recap Story</h3>

        <Toggle
          label="📖 AI Nightly Recap"
          hint="A warm storybook summary of each day, written automatically."
          checked={s.recap_enabled}
          onChange={(v) => update.mutate({ recap_enabled: v })}
        />

        {/* Names chip editor */}
        <div>
          <div className="hc-label">Personalize greeting</div>
          <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.4 }}>
            The recap will open with e.g. "Hello {currentNames.length > 0 ? currentNames.join(' and ') : 'Maya and Leo'},"
          </p>

          {/* Current name chips */}
          {currentNames.length > 0 && (
            <div
              style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}
              aria-label="Names in greeting"
            >
              {currentNames.map((name) => (
                <span key={name} className="hc-chip hc-chip-accent" style={{ gap: 4 }}>
                  {name}
                  <button
                    type="button"
                    aria-label={`Remove ${name}`}
                    onClick={() => removeName(name)}
                    disabled={update.isLoading}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: '0 2px',
                      cursor: 'pointer',
                      color: 'inherit',
                      lineHeight: 1,
                      fontSize: 14,
                      fontWeight: 700,
                      opacity: 0.8,
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Add name input */}
          {currentNames.length < MAX_NAMES ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <label htmlFor="recap-name-input" className="hc-sr-only">Add a name</label>
              <input
                id="recap-name-input"
                className="hc-input"
                style={{ flex: 1, minHeight: 48 }}
                placeholder="Add a name…"
                value={nameInput}
                maxLength={32}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addName();
                  }
                }}
              />
              <button
                type="button"
                className="hc-btn"
                onClick={addName}
                disabled={!nameInput.trim() || update.isLoading}
                style={{ flexShrink: 0 }}
              >
                Add
              </button>
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Up to {MAX_NAMES} names maximum.
            </p>
          )}
        </div>
      </section>

    </div>
  );
}
