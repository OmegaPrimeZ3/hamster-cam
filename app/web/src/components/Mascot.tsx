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

import { motion, useReducedMotion } from 'framer-motion';

export type MascotPose = 'idle' | 'running' | 'eating' | 'sleeping' | 'peeking' | 'waving';

export interface MascotProps {
  emoji?: string;
  pose?: MascotPose;
  size?: number;
  ariaLabel?: string;
}

export function Mascot({ emoji = '🐹', pose = 'idle', size = 48, ariaLabel }: MascotProps): JSX.Element {
  const reduced = useReducedMotion();
  const label = ariaLabel ?? `${pose === 'sleeping' ? 'Sleeping' : 'Awake'} pet mascot`;

  const animProps = reduced ? {} : poseAnimation(pose);

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
