// app/web/test/useTTSEnabled.test.ts
//
// Tests for the useTTSEnabled hook — localStorage persistence and state.

import { describe, expect, it, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTTSEnabled } from '../src/hooks/useTTSEnabled';

const LS_KEY = 'hc.tts.enabled';

describe('useTTSEnabled', () => {
  beforeEach(() => {
    localStorage.removeItem(LS_KEY);
  });

  it('defaults to true when localStorage key is absent', () => {
    const { result } = renderHook(() => useTTSEnabled());
    expect(result.current.ttsEnabled).toBe(true);
  });

  it('reads existing false value from localStorage', () => {
    localStorage.setItem(LS_KEY, 'false');
    const { result } = renderHook(() => useTTSEnabled());
    expect(result.current.ttsEnabled).toBe(false);
  });

  it('reads existing true value from localStorage', () => {
    localStorage.setItem(LS_KEY, 'true');
    const { result } = renderHook(() => useTTSEnabled());
    expect(result.current.ttsEnabled).toBe(true);
  });

  it('persists false to localStorage when setTTSEnabled(false) is called', () => {
    const { result } = renderHook(() => useTTSEnabled());
    act(() => result.current.setTTSEnabled(false));
    expect(result.current.ttsEnabled).toBe(false);
    expect(localStorage.getItem(LS_KEY)).toBe('false');
  });

  it('persists true to localStorage when setTTSEnabled(true) is called', () => {
    localStorage.setItem(LS_KEY, 'false');
    const { result } = renderHook(() => useTTSEnabled());
    act(() => result.current.setTTSEnabled(true));
    expect(result.current.ttsEnabled).toBe(true);
    expect(localStorage.getItem(LS_KEY)).toBe('true');
  });
});
