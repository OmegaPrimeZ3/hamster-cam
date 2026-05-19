// app/web/src/hooks/useTouchZoom.ts
//
// Pinch-to-zoom + pan + double-tap reset for the MaximizedCamera view.
// Pure pointer events; no external dep. Lives in PLAN §5.4 "Maximized
// camera view".
//
// Conflict resolution with the camera-switcher swipe:
//   - One pointer with horizontal travel  → caller's `onSwipe(direction)`
//     fires once when the threshold is crossed; we report that mode and
//     suppress pan
//   - Two pointers                         → zoom mode; swipe is suppressed
//   - Double-tap                           → snaps back to scale 1, offset 0
//
// Math:
//   - scale = clamp(initialDistance ratio, MIN_SCALE, MAX_SCALE)
//   - transform-origin tracks the midpoint of the two pointers so the zoom
//     centers under the kid's fingers (transformed to element-local coords)
//
// We expose a `transform` string and a `transformOrigin` string for the caller
// to slap directly onto its inner element's style. The hook is rendering-
// library-agnostic.

import { useCallback, useEffect, useRef, useState } from 'react';

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
const DOUBLE_TAP_MS = 280;
const SWIPE_TRIGGER_PX = 60;
const SWIPE_LOCK_PX = 10; // horizontal travel before we commit to swipe mode

export interface TouchZoomState {
  scale: number;
  offsetX: number;
  offsetY: number;
  originX: number;
  originY: number;
  mode: 'idle' | 'pan' | 'zoom' | 'swipe';
}

export interface UseTouchZoomArgs {
  /** Called when the user finishes a horizontal swipe that crossed SWIPE_TRIGGER_PX. */
  onSwipe?: (direction: 'left' | 'right') => void;
}

export interface UseTouchZoomReturn {
  transform: string;
  transformOrigin: string;
  state: TouchZoomState;
  reset: () => void;
  bind: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
}

interface PointerSample {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
}

interface GestureSnapshot {
  initialDistance: number;
  initialScale: number;
  initialOffsetX: number;
  initialOffsetY: number;
  midX: number;
  midY: number;
}

export function useTouchZoom(args: UseTouchZoomArgs = {}): UseTouchZoomReturn {
  const onSwipe = args.onSwipe;
  const pointersRef = useRef<Map<number, PointerSample>>(new Map());
  const gestureRef = useRef<GestureSnapshot | null>(null);
  const lastTapRef = useRef<number>(0);
  const swipeCommittedRef = useRef<boolean>(false);

  const [state, setState] = useState<TouchZoomState>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    originX: 50,
    originY: 50,
    mode: 'idle',
  });

  const reset = useCallback(() => {
    pointersRef.current.clear();
    gestureRef.current = null;
    swipeCommittedRef.current = false;
    setState({ scale: 1, offsetX: 0, offsetY: 0, originX: 50, originY: 50, mode: 'idle' });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const target = e.currentTarget as Element & {
      setPointerCapture?: (id: number) => void;
    };
    if (target.setPointerCapture) {
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture occasionally throws on synthetic events; ignore */
      }
    }
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    pointersRef.current.set(e.pointerId, {
      id: e.pointerId,
      x,
      y,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
    });

    // Double-tap detection (only when zero existing pointers before this one)
    if (pointersRef.current.size === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < DOUBLE_TAP_MS) {
        reset();
        lastTapRef.current = 0;
        return;
      }
      lastTapRef.current = now;
    }

    swipeCommittedRef.current = false;

    if (pointersRef.current.size === 2) {
      const ps = Array.from(pointersRef.current.values());
      const p1 = ps[0]!;
      const p2 = ps[1]!;
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      const dist = Math.hypot(dx, dy) || 1;
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      gestureRef.current = {
        initialDistance: dist,
        initialScale: state.scale,
        initialOffsetX: state.offsetX,
        initialOffsetY: state.offsetY,
        midX,
        midY,
      };
      setState((s) => ({
        ...s,
        mode: 'zoom',
        originX: (midX / rect.width) * 100,
        originY: (midY / rect.height) * 100,
      }));
    } else if (pointersRef.current.size === 1 && state.scale > 1) {
      setState((s) => ({ ...s, mode: 'pan' }));
    } else {
      setState((s) => ({ ...s, mode: 'idle' }));
    }
  }, [reset, state.scale, state.offsetX, state.offsetY]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const pointer = pointersRef.current.get(e.pointerId);
    if (!pointer) return;
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;

    if (pointersRef.current.size === 2 && gestureRef.current) {
      const ps = Array.from(pointersRef.current.values());
      const p1 = ps[0]!;
      const p2 = ps[1]!;
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ratio = dist / gestureRef.current.initialDistance;
      const nextScale = clamp(gestureRef.current.initialScale * ratio, MIN_SCALE, MAX_SCALE);
      setState((s) => ({ ...s, scale: nextScale, mode: 'zoom' }));
      return;
    }

    if (pointersRef.current.size === 1) {
      const totalDx = pointer.x - pointer.startX;
      const totalDy = pointer.y - pointer.startY;

      if (state.scale > 1) {
        // Frame-to-frame delta so panning feels 1:1.
        const deltaX = pointer.x - pointer.lastX;
        const deltaY = pointer.y - pointer.lastY;
        pointer.lastX = pointer.x;
        pointer.lastY = pointer.y;
        setState((s) => ({
          ...s,
          mode: 'pan',
          offsetX: s.offsetX + deltaX,
          offsetY: s.offsetY + deltaY,
        }));
        return;
      }

      // scale === 1: maybe a swipe
      if (
        !swipeCommittedRef.current &&
        Math.abs(totalDx) > SWIPE_LOCK_PX &&
        Math.abs(totalDx) > Math.abs(totalDy)
      ) {
        swipeCommittedRef.current = true;
        setState((s) => ({ ...s, mode: 'swipe' }));
      }
    }
  }, [state.scale]);

  const finishPointer = useCallback((e: React.PointerEvent) => {
    const pointer = pointersRef.current.get(e.pointerId);
    if (!pointer) return;
    const dx = pointer.x - pointer.startX;
    const dy = pointer.y - pointer.startY;
    pointersRef.current.delete(e.pointerId);
    const remaining = pointersRef.current.size;

    if (remaining === 0) {
      gestureRef.current = null;
      // commit pending swipe on release
      if (
        swipeCommittedRef.current &&
        Math.abs(dx) >= SWIPE_TRIGGER_PX &&
        Math.abs(dx) > Math.abs(dy) &&
        state.scale === 1
      ) {
        onSwipe?.(dx < 0 ? 'left' : 'right');
      }
      swipeCommittedRef.current = false;
      setState((s) => ({ ...s, mode: s.scale > 1 ? 'idle' : 'idle' }));
    } else if (remaining === 1) {
      // dropped from two-finger zoom to one finger — switch to pan
      gestureRef.current = null;
      const last = Array.from(pointersRef.current.values())[0];
      if (last) {
        last.startX = last.x;
        last.startY = last.y;
        last.lastX = last.x;
        last.lastY = last.y;
      }
      setState((s) => ({ ...s, mode: s.scale > 1 ? 'pan' : 'idle' }));
    }
  }, [onSwipe, state.scale]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    finishPointer(e);
  }, [finishPointer]);

  const onPointerCancel = useCallback((e: React.PointerEvent) => {
    finishPointer(e);
  }, [finishPointer]);

  useEffect(() => {
    // If component unmounts mid-gesture, clear pointer map to avoid stale state.
    const ptrs = pointersRef.current;
    return () => {
      ptrs.clear();
    };
  }, []);

  const transform = `translate(${state.offsetX}px, ${state.offsetY}px) scale(${state.scale})`;
  const transformOrigin = `${state.originX}% ${state.originY}%`;

  return {
    transform,
    transformOrigin,
    state,
    reset,
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
