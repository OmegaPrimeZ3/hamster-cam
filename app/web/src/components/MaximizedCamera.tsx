// app/web/src/components/MaximizedCamera.tsx
//
// Single-camera fullscreen view per PLAN §5.4:
//   - Top-left X close
//   - Pinch/pan/double-tap reset via useTouchZoom
//   - Swipe left/right to switch cameras (gesture conflict handled in the hook)
//   - Bottom thumbnail strip switcher
//   - 📸 Take a photo! → activity.snapshot (saves a diary memory)
//   - Picture-in-picture + fullscreen via the native APIs
//   - Auto-rotate every 10s when enabled in settings

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import confetti from 'canvas-confetti';
import { Camera, PictureInPicture2, Maximize, X } from 'lucide-react';
import type { RouterOutputs } from '../trpc';
import { trpc } from '../trpc';
import { useTouchZoom } from '../hooks/useTouchZoom';

type CameraDTO = RouterOutputs['cameras']['list'][number];

const AUTO_ROTATE_MS = 10_000;

export interface MaximizedCameraProps {
  initialCameraId: number;
  cameras: CameraDTO[];
  petName: string;
  petEmoji: string;
  autoRotate: boolean;
  onClose: () => void;
}

export function MaximizedCamera({
  initialCameraId,
  cameras,
  petName,
  petEmoji,
  autoRotate,
  onClose,
}: MaximizedCameraProps): JSX.Element | null {
  const orderedIds = useMemo(() => cameras.map((c) => c.id), [cameras]);
  const initialIndex = Math.max(0, orderedIds.indexOf(initialCameraId));
  const [index, setIndex] = useState(initialIndex);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [snapMessage, setSnapMessage] = useState<string | null>(null);
  const [snapKind, setSnapKind] = useState<'success' | 'error'>('success');
  const reducedMotion = useReducedMotion();

  const utils = trpc.useUtils();
  const snapshotMut = trpc.activity.snapshot.useMutation({
    onSuccess: async () => {
      const reduced =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduced) {
        try {
          confetti({
            particleCount: 18,
            spread: 55,
            origin: { y: 0.55 },
            scalar: 0.7,
          });
        } catch {
          /* canvas-confetti can throw if a renderer isn't available; harmless */
        }
      }
      setSnapKind('success');
      setSnapMessage('Saved!');
      window.setTimeout(() => setSnapMessage(null), 1800);
      await utils.activity.today.invalidate();
    },
    onError: (err) => {
      setSnapKind('error');
      setSnapMessage(`Could not save: ${err.message}`);
      window.setTimeout(() => setSnapMessage(null), 2400);
    },
  });

  const onSwipe = useCallback(
    (dir: 'left' | 'right') => {
      setIndex((i) => {
        if (cameras.length === 0) return i;
        return dir === 'left'
          ? (i + 1) % cameras.length
          : (i - 1 + cameras.length) % cameras.length;
      });
    },
    [cameras.length],
  );

  const { transform, transformOrigin, reset, bind } = useTouchZoom({ onSwipe });

  // Reset zoom on camera change so a maxed view doesn't carry over.
  useEffect(() => {
    reset();
  }, [index, reset]);

  // Auto-rotate
  useEffect(() => {
    if (!autoRotate || cameras.length < 2) return undefined;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % cameras.length);
    }, AUTO_ROTATE_MS);
    return () => window.clearInterval(id);
  }, [autoRotate, cameras.length]);

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onSwipe('right');
      if (e.key === 'ArrowRight') onSwipe('left');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onSwipe]);

  const current = cameras[index];
  if (!current) return null;

  function handleSnap(): void {
    if (!current) return;
    snapshotMut.mutate({ camera_id: current.id });
  }

  async function handlePip(): Promise<void> {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (typeof v.requestPictureInPicture === 'function') {
        await v.requestPictureInPicture();
      }
    } catch {
      /* user denied / not supported — silent is fine here */
    }
  }

  async function handleFullscreen(): Promise<void> {
    const c = containerRef.current;
    if (!c) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (c.requestFullscreen) {
        await c.requestFullscreen();
      }
    } catch {
      /* harmless */
    }
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={`Maximized ${current.name} ${petEmoji}`}
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        {...bind}
        style={{
          flex: 1,
          position: 'relative',
          overflow: 'hidden',
          touchAction: 'none',
        }}
      >
        <video
          key={current.stream_url}
          ref={videoRef}
          src={current.stream_url}
          autoPlay
          muted
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            transform,
            transformOrigin,
            transition: 'transform 60ms linear',
          }}
        />

        <button
          type="button"
          onClick={onClose}
          className="hc-btn"
          aria-label="Close maximized view"
          style={controlStyle('top-left')}
        >
          <X aria-hidden size={22} />
        </button>

        <div style={{ ...controlStyle('top-right'), gap: 8 }}>
          <button type="button" onClick={handlePip} aria-label="Picture-in-picture" className="hc-btn">
            <PictureInPicture2 aria-hidden size={20} />
          </button>
          <button type="button" onClick={handleFullscreen} aria-label="Fullscreen" className="hc-btn">
            <Maximize aria-hidden size={20} />
          </button>
        </div>

        <button
          type="button"
          onClick={handleSnap}
          className="hc-btn hc-btn-primary"
          aria-label="Take a photo"
          disabled={snapshotMut.isLoading}
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 96,
            zIndex: 2,
          }}
        >
          <Camera aria-hidden size={22} /> {snapshotMut.isLoading ? 'Saving…' : 'Take a photo!'}
        </button>

        <AnimatePresence>
          {snapMessage && snapKind === 'success' && (
            <motion.div
              key="snap-sticker"
              role="status"
              aria-live="polite"
              initial={
                reducedMotion
                  ? { opacity: 0 }
                  : { rotate: -10, scale: 0.6, opacity: 0 }
              }
              animate={
                reducedMotion
                  ? { opacity: 1 }
                  : {
                      rotate: [-10, 6, -3, 0],
                      scale: [0.6, 1.1, 0.95, 1],
                      opacity: 1,
                    }
              }
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: reducedMotion ? 0.15 : 0.5 }}
              style={{
                position: 'absolute',
                left: '50%',
                transform: 'translateX(-50%)',
                bottom: 160,
                background: 'var(--success)',
                color: '#fff',
                padding: '10px 16px',
                borderRadius: 14,
                fontWeight: 700,
                fontSize: 18,
                boxShadow: '0 12px 28px rgba(0,0,0,0.22)',
                whiteSpace: 'nowrap',
              }}
            >
              {`📸 ${snapMessage}`}
            </motion.div>
          )}
          {snapMessage && snapKind === 'error' && (
            <motion.div
              key="snap-error"
              role="status"
              aria-live="polite"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              style={{
                position: 'absolute',
                left: '50%',
                transform: 'translateX(-50%)',
                bottom: 160,
                background: 'rgba(0,0,0,0.6)',
                color: '#fff',
                padding: '8px 14px',
                borderRadius: 10,
                fontWeight: 500,
              }}
            >
              {snapMessage}
            </motion.div>
          )}
        </AnimatePresence>

        <div
          style={{
            position: 'absolute',
            left: 16,
            bottom: 16,
            color: '#fff',
            fontSize: 14,
            background: 'rgba(0,0,0,0.5)',
            padding: '4px 10px',
            borderRadius: 999,
          }}
        >
          {current.emoji} {current.name} · {petName}
        </div>
      </div>

      {cameras.length > 1 && (
        <nav
          aria-label="Switch cameras"
          style={{
            display: 'flex',
            gap: 8,
            overflowX: 'auto',
            padding: 12,
            background: 'rgba(0,0,0,0.7)',
          }}
        >
          {cameras.map((cam, i) => (
            <button
              key={cam.id}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Switch to ${cam.name}`}
              aria-current={i === index}
              className="hc-btn"
              style={{
                padding: '8px 14px',
                background: i === index ? 'var(--accent)' : 'var(--surface)',
                color: i === index ? 'var(--accent-text)' : 'var(--text)',
                border: 'none',
              }}
            >
              <span aria-hidden>{cam.emoji}</span>
              <span>{cam.name}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

function controlStyle(corner: 'top-left' | 'top-right'): React.CSSProperties {
  return {
    position: 'absolute',
    top: 16,
    [corner === 'top-left' ? 'left' : 'right']: 16,
    zIndex: 2,
    display: 'flex',
    minHeight: 48,
    padding: '0 12px',
  };
}
