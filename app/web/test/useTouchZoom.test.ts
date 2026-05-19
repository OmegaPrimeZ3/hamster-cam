// app/web/test/useTouchZoom.test.ts
//
// Pinch math, double-tap reset, and conflict between zoom and horizontal-
// swipe modes. We drive the hook through React Testing Library's renderHook
// API and synthesize PointerEvent-like dispatches.

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTouchZoom, MIN_SCALE } from '../src/hooks/useTouchZoom';
import type { PointerEvent as ReactPointerEvent } from 'react';

interface FakePointerEvent {
  pointerId: number;
  clientX: number;
  clientY: number;
  currentTarget: { getBoundingClientRect: () => DOMRect };
}

function pe(opts: { id: number; x: number; y: number }): ReactPointerEvent {
  const target = {
    getBoundingClientRect: () =>
      ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect),
  };
  return {
    pointerId: opts.id,
    clientX: opts.x,
    clientY: opts.y,
    currentTarget: target,
  } as unknown as ReactPointerEvent;
}

describe('useTouchZoom', () => {
  it('starts at scale 1, idle mode', () => {
    const { result } = renderHook(() => useTouchZoom());
    expect(result.current.state.scale).toBe(MIN_SCALE);
    expect(result.current.state.mode).toBe('idle');
    expect(result.current.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('two pointers pinching outwards increases scale', () => {
    const { result } = renderHook(() => useTouchZoom());
    act(() => {
      result.current.bind.onPointerDown(pe({ id: 1, x: 180, y: 150 }));
    });
    act(() => {
      result.current.bind.onPointerDown(pe({ id: 2, x: 220, y: 150 }));
    });
    // Initial distance: 40
    act(() => {
      result.current.bind.onPointerMove(pe({ id: 1, x: 100, y: 150 }));
    });
    act(() => {
      result.current.bind.onPointerMove(pe({ id: 2, x: 300, y: 150 }));
    });
    // New distance: 200 → ratio = 5 → clamped to MAX_SCALE = 4
    expect(result.current.state.scale).toBe(4);
    expect(result.current.state.mode).toBe('zoom');
  });

  it('double-tap resets state back to scale 1', () => {
    const { result } = renderHook(() => useTouchZoom());
    // First, push the scale up via pinch
    act(() => {
      result.current.bind.onPointerDown(pe({ id: 1, x: 180, y: 150 }));
      result.current.bind.onPointerDown(pe({ id: 2, x: 220, y: 150 }));
      result.current.bind.onPointerMove(pe({ id: 1, x: 120, y: 150 }));
      result.current.bind.onPointerMove(pe({ id: 2, x: 280, y: 150 }));
      result.current.bind.onPointerUp(pe({ id: 1, x: 120, y: 150 }));
      result.current.bind.onPointerUp(pe({ id: 2, x: 280, y: 150 }));
    });
    expect(result.current.state.scale).toBeGreaterThan(1);

    act(() => {
      result.current.bind.onPointerDown(pe({ id: 3, x: 200, y: 150 }));
      result.current.bind.onPointerUp(pe({ id: 3, x: 200, y: 150 }));
    });
    act(() => {
      result.current.bind.onPointerDown(pe({ id: 4, x: 200, y: 150 }));
    });
    expect(result.current.state.scale).toBe(MIN_SCALE);
    expect(result.current.state.offsetX).toBe(0);
    expect(result.current.state.offsetY).toBe(0);
  });

  it('horizontal one-finger drag at scale 1 triggers onSwipe', () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useTouchZoom({ onSwipe }));
    act(() => {
      result.current.bind.onPointerDown(pe({ id: 1, x: 50, y: 150 }));
    });
    act(() => {
      result.current.bind.onPointerMove(pe({ id: 1, x: 200, y: 152 }));
    });
    expect(result.current.state.mode).toBe('swipe');
    act(() => {
      result.current.bind.onPointerUp(pe({ id: 1, x: 200, y: 152 }));
    });
    expect(onSwipe).toHaveBeenCalledWith('right');
  });

  it('vertical drag at scale 1 does NOT trigger swipe', () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useTouchZoom({ onSwipe }));
    act(() => {
      result.current.bind.onPointerDown(pe({ id: 1, x: 200, y: 50 }));
    });
    act(() => {
      result.current.bind.onPointerMove(pe({ id: 1, x: 205, y: 250 }));
    });
    act(() => {
      result.current.bind.onPointerUp(pe({ id: 1, x: 205, y: 250 }));
    });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('two-pointer pinch suppresses swipe (conflict)', () => {
    const onSwipe = vi.fn();
    const { result } = renderHook(() => useTouchZoom({ onSwipe }));
    act(() => {
      result.current.bind.onPointerDown(pe({ id: 1, x: 180, y: 150 }));
      result.current.bind.onPointerDown(pe({ id: 2, x: 220, y: 150 }));
      result.current.bind.onPointerMove(pe({ id: 1, x: 120, y: 150 }));
      result.current.bind.onPointerMove(pe({ id: 2, x: 280, y: 150 }));
      result.current.bind.onPointerUp(pe({ id: 1, x: 120, y: 150 }));
      result.current.bind.onPointerUp(pe({ id: 2, x: 280, y: 150 }));
    });
    expect(onSwipe).not.toHaveBeenCalled();
  });
});
