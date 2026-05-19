// app/web/src/components/CameraTile.tsx
//
// Single camera tile. Full state machine per PLAN §5.4:
//   - loading: spinning mascot, "Looking for {pet}..."
//   - live:    plays stream via <video> (go2rtc HLS/WebRTC URL passed straight
//              through; backend hands us the resolved URL)
//   - napping: dimmed + sleeping mascot, "Wheel Cam is taking a nap…"
//   - offline: deep sleep, prompt to check
//   - error:   explicit failure, deep-link to settings for admins
//
// State source of truth is the backend's `last_frame_at` on cameras.list — we
// compute the visual state purely from `Date.now() - last_frame_at`, so the
// frontend doesn't need its own ticker.

import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Maximize2, AlertCircle } from 'lucide-react';
import type { RouterOutputs } from '../trpc';
import { Mascot } from './Mascot';
import { relativeTime } from '../lib/time';

export type CameraTileState = 'loading' | 'live' | 'napping' | 'offline' | 'error';

export type CameraDTO = RouterOutputs['cameras']['list'][number];

export interface CameraTileProps {
  camera: CameraDTO;
  petName: string;
  petEmoji: string;
  pulsing?: boolean;
  isAdmin: boolean;
  onMaximize: (cameraId: number) => void;
  onAdminFix?: (cameraId: number) => void;
  /** Test seam — defaults to Date.now() per render. */
  now?: number;
}

export function tileStateFor(lastFrameAt: number | null, now: number): CameraTileState {
  if (lastFrameAt == null) return 'loading';
  const ageMs = now - lastFrameAt;
  if (ageMs < 30_000) return 'live';
  if (ageMs < 5 * 60_000) return 'napping';
  return 'offline';
}

export function CameraTile({
  camera,
  petName,
  petEmoji,
  pulsing = false,
  isAdmin,
  onMaximize,
  onAdminFix,
  now,
}: CameraTileProps): JSX.Element {
  const reduced = useReducedMotion();
  const [videoError, setVideoError] = useState(false);

  const effectiveNow = now ?? Date.now();
  let state: CameraTileState = tileStateFor(camera.last_frame_at, effectiveNow);
  if (videoError) state = 'error';

  // Retry loop: poll the tile state when napping/offline.
  useEffect(() => {
    if (state !== 'napping' && state !== 'offline') return undefined;
    const interval = state === 'napping' ? 10_000 : 30_000;
    const id = window.setInterval(() => {
      // Clearing the video error lets the next paint re-attempt the stream;
      // the actual refresh of last_frame_at is driven by the cameras.list
      // refetchInterval on Header / parent.
      setVideoError(false);
    }, interval);
    return () => window.clearInterval(id);
  }, [state]);

  return (
    <motion.button
      type="button"
      onClick={() => onMaximize(camera.id)}
      whileHover={reduced ? undefined : { y: -2 }}
      whileTap={reduced ? undefined : { scale: 0.99 }}
      className={pulsing && state === 'live' ? 'hc-pulse' : undefined}
      aria-label={`Maximize ${camera.name}`}
      style={{
        position: 'relative',
        padding: 0,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 16,
        overflow: 'hidden',
        aspectRatio: '16 / 9',
        cursor: 'pointer',
        color: 'var(--text)',
      }}
    >
      {state === 'live' && (
        <video
          key={camera.stream_url}
          src={camera.stream_url}
          autoPlay
          muted
          playsInline
          onError={() => setVideoError(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000' }}
        />
      )}

      {state !== 'live' && <PlaceholderArt state={state} petName={petName} petEmoji={petEmoji} camera={camera} />}

      <div
        style={{
          position: 'absolute',
          left: 10,
          bottom: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'color-mix(in srgb, var(--surface) 88%, transparent)',
          padding: '6px 10px',
          borderRadius: 999,
          fontSize: 14,
          fontWeight: 500,
          maxWidth: 'calc(100% - 80px)',
        }}
      >
        <span aria-hidden>{camera.emoji}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{camera.name}</span>
      </div>

      <div
        style={{
          position: 'absolute',
          right: 10,
          bottom: 10,
          padding: 6,
          background: 'color-mix(in srgb, var(--surface) 88%, transparent)',
          borderRadius: 8,
          display: 'inline-flex',
        }}
      >
        <Maximize2 aria-hidden size={18} />
      </div>

      {state === 'error' && isAdmin && onAdminFix && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAdminFix(camera.id);
          }}
          className="hc-btn"
          style={{ position: 'absolute', top: 10, right: 10, padding: '4px 10px', minHeight: 36 }}
        >
          <AlertCircle aria-hidden size={16} /> Fix
        </button>
      )}
    </motion.button>
  );
}

interface PlaceholderArtProps {
  state: CameraTileState;
  petName: string;
  petEmoji: string;
  camera: CameraDTO;
}

function PlaceholderArt({ state, petName, petEmoji, camera }: PlaceholderArtProps): JSX.Element {
  const pose = state === 'loading' ? 'waving' : state === 'error' ? 'peeking' : 'sleeping';
  const dim = state === 'offline' ? 0.55 : state === 'napping' ? 0.8 : 1;
  const lastSeen = camera.last_frame_at ? relativeTime(camera.last_frame_at) : 'not yet seen';
  const pet = petName || 'your pet';
  const text =
    state === 'loading' ? `Looking for ${pet}…`
      : state === 'napping' ? `${camera.emoji} ${camera.name} is taking a nap — back soon`
      : state === 'offline' ? `😴 ${camera.name} is having a deep sleep — check the camera?`
      : `${camera.name} needs a grown-up's help. Tap to see what's wrong.`;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--surface-raised)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 16,
        opacity: dim,
        textAlign: 'center',
      }}
    >
      <Mascot emoji={petEmoji} pose={pose} size={48} ariaLabel={`${camera.name} ${state}`} />
      <p style={{ margin: 0, fontWeight: 500 }}>{text}</p>
      {(state === 'napping' || state === 'offline') && (
        <small style={{ color: 'var(--text-muted)' }}>last seen {lastSeen}</small>
      )}
    </div>
  );
}
