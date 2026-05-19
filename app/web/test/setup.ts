// app/web/test/setup.ts
//
// Global test setup. Boots msw server with default handlers, wires
// @testing-library/jest-dom matchers, and stubs the bits of `window` that
// jsdom doesn't ship (matchMedia, IntersectionObserver, etc.).

import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from './msw/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// matchMedia stub — jsdom doesn't implement it.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }),
  });
}

// IntersectionObserver stub
class MockIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
if (typeof globalThis !== 'undefined' && !('IntersectionObserver' in globalThis)) {
  (globalThis as unknown as { IntersectionObserver: typeof MockIntersectionObserver }).IntersectionObserver = MockIntersectionObserver;
}

// canvas-confetti uses requestAnimationFrame; provide one if missing
if (typeof globalThis.requestAnimationFrame !== 'function') {
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
  (globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = (id) => clearTimeout(id);
}

// Stub speechSynthesis so Diary's read-aloud test doesn't blow up
if (typeof window !== 'undefined' && !('speechSynthesis' in window)) {
  Object.defineProperty(window, 'speechSynthesis', {
    writable: true,
    value: { speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn() },
  });
  (window as unknown as { SpeechSynthesisUtterance: new (text: string) => unknown }).SpeechSynthesisUtterance = class {
    text: string;
    rate = 1;
    pitch = 1;
    constructor(text: string) {
      this.text = text;
    }
  };
}
