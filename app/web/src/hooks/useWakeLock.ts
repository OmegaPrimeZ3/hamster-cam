// app/web/src/hooks/useWakeLock.ts
//
// Keeps the screen awake (Screen Wake Lock API) while the app is open, so a
// wall-docked iPad showing the live cam never dims or goes to sleep.
//
// Two platform wrinkles this handles:
//   1. The OS silently releases a wake lock whenever the tab is backgrounded,
//      so we re-acquire on every visibilitychange back to 'visible'.
//   2. request() can reject (low battery, permissions, backgrounded mid-call);
//      we swallow that and retry on the next visibility/charging change.
//
// Power gating ("…and plugged into power"): where the Battery Status API
// exists (Chromium desktop), we only hold the lock while charging. iOS Safari
// — the iPad target — does NOT expose battery state, so there we hold the lock
// whenever the app is visible, which matches the docked-on-charger use case.

import { useEffect } from 'react';

// Battery Status API is not in the TS DOM lib — declare the slice we use.
interface BatteryManager extends EventTarget {
  charging: boolean;
}
type NavigatorWithBattery = Navigator & {
  getBattery?: () => Promise<BatteryManager>;
};

export function useWakeLock(): void {
  useEffect(() => {
    if (!('wakeLock' in navigator)) return undefined;

    let sentinel: WakeLockSentinel | null = null;
    let battery: BatteryManager | null = null;
    let cancelled = false;

    // Hold the lock only when it makes sense: app visible, and — where the
    // platform can report it — the device charging. Unknown power = assume
    // docked (iOS) and hold.
    function shouldHold(): boolean {
      if (document.visibilityState !== 'visible') return false;
      if (battery) return battery.charging;
      return true;
    }

    async function acquire(): Promise<void> {
      if (cancelled || sentinel || !shouldHold()) return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => {
          sentinel = null;
        });
      } catch {
        // Rejected — retry on the next sync().
        sentinel = null;
      }
    }

    async function release(): Promise<void> {
      const current = sentinel;
      sentinel = null;
      if (!current) return;
      try {
        await current.release();
      } catch {
        // Already released or no longer valid — nothing to do.
      }
    }

    function sync(): void {
      if (shouldHold()) void acquire();
      else void release();
    }

    document.addEventListener('visibilitychange', sync);

    const nav = navigator as NavigatorWithBattery;
    if (typeof nav.getBattery === 'function') {
      nav
        .getBattery()
        .then((b) => {
          if (cancelled) return;
          battery = b;
          b.addEventListener('chargingchange', sync);
          sync();
        })
        .catch(() => {
          // Battery info unavailable — fall back to visible-only gating.
          sync();
        });
    }

    // Initial attempt (also covers the window before getBattery resolves).
    sync();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', sync);
      if (battery) battery.removeEventListener('chargingchange', sync);
      void release();
    };
  }, []);
}
