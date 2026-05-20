// app/web/src/components/Mascot.tsx
//
// Tiny SVG mascot whose pose mirrors the most recent pet activity. Respects
// prefers-reduced-motion (no bounce, no Z's drift).
//
// Activities map to poses:
//   - 'idle'      → gentle bounce
//   - 'running'   → tilted forward, faster bounce
//   - 'eating'    → small "munching" head bob
//   - 'sleeping'  → eyes closed + Z's
//   - 'peeking'   → off-center, peeking out
//
// The avatar is a stylized circle with two ears and dot-eyes. Pet emoji is
// rendered above it (via the `emoji` prop) so families with non-hamster pets
// still recognize themselves.

import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export type MascotPose = 'idle' | 'running' | 'eating' | 'sleeping' | 'peeking' | 'waving';

export interface MascotProps {
  emoji?: string;
  pose?: MascotPose;
  size?: number;
  ariaLabel?: string;
  /**
   * When true, play a one-shot wave animation on first mount (~1.2 s) before
   * settling into `pose`. Skipped entirely under prefers-reduced-motion.
   * Defaults to false so existing callers keep their current behaviour.
   */
  waveOnMount?: boolean;
}

const WAVE_DURATION_MS = 1200;

export function Mascot({
  emoji = '🐹',
  pose = 'idle',
  size = 48,
  ariaLabel,
  waveOnMount = false,
}: MascotProps): JSX.Element {
  const reduced = useReducedMotion();
  const label = ariaLabel ?? `${pose === 'sleeping' ? 'Sleeping' : 'Awake'} pet mascot`;

  // Skip the wave entirely under reduced-motion, or if the caller didn't ask
  // for one. `hasWaved` initialises to true in those cases so the regular
  // pose animation takes over from the first paint.
  const [hasWaved, setHasWaved] = useState<boolean>(() => !(waveOnMount && !reduced));

  useEffect(() => {
    if (hasWaved) return undefined;
    const id = window.setTimeout(() => setHasWaved(true), WAVE_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [hasWaved]);

  const animProps = reduced
    ? {}
    : hasWaved
      ? poseAnimation(pose)
      : waveOnceAnimation();

  return (
    <motion.div
      role="img"
      aria-label={label}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.78),
        lineHeight: 1,
        userSelect: 'none',
      }}
      {...animProps}
    >
      <span aria-hidden>{pose === 'sleeping' ? '💤' : emoji}</span>
    </motion.div>
  );
}

function waveOnceAnimation() {
  // One-shot, non-repeating wave. No `repeat: Infinity` — runs the keyframe
  // sequence once, then the effect flips `hasWaved` and the pose animation
  // takes over on the next render.
  return {
    animate: { rotate: [0, 14, -8, 14, -4, 0] },
    transition: { duration: WAVE_DURATION_MS / 1000, ease: 'easeInOut' as const },
  };
}

function poseAnimation(pose: MascotPose) {
  switch (pose) {
    case 'running':
      return {
        animate: { y: [0, -4, 0, -4, 0], rotate: [-3, 3, -3] },
        transition: { duration: 0.55, repeat: Infinity, ease: 'easeInOut' as const },
      };
    case 'eating':
      return {
        animate: { y: [0, -2, 0], rotate: [0, -2, 0] },
        transition: { duration: 0.45, repeat: Infinity, ease: 'easeInOut' as const },
      };
    case 'sleeping':
      return {
        animate: { y: [0, -1, 0] },
        transition: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' as const },
      };
    case 'peeking':
      return {
        animate: { x: [-3, 0, -3] },
        transition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' as const },
      };
    case 'waving':
      return {
        animate: { rotate: [0, 14, -8, 14, 0] },
        transition: { duration: 1.4, repeat: Infinity, ease: 'easeInOut' as const },
      };
    case 'idle':
    default:
      return {
        animate: { y: [0, -3, 0] },
        transition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' as const },
      };
  }
}
