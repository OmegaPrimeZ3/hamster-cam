// app/web/src/components/SwUpdateBanner.tsx
//
// Displays a top-of-screen banner when a new service worker is waiting to
// activate. Uses the `useRegisterSW` hook from vite-plugin-pwa's virtual
// module — no new dependencies.
//
// Behavior:
//   - Banner appears when vite-plugin-pwa signals a new SW is available.
//   - Tapping "Update now" posts SKIP_WAITING to the waiting SW, then reloads.
//   - Tapping "×" dismisses the banner for the current session so it doesn't
//     nag the user on every minute.
//   - The virtual module import is dynamic via a bare specifier so vitest
//     tests can override it; the component accepts an optional `onNeedRefresh`
//     prop for testing.

import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

export interface SwUpdateBannerProps {
  /**
   * Test seam: override the "needRefresh" signal externally.
   * In production this is always undefined and the hook value is used.
   */
  _testNeedRefresh?: boolean;
  /**
   * Test seam: override the updateServiceWorker callback.
   */
  _testUpdate?: (reloadPage?: boolean) => Promise<void>;
}

export function SwUpdateBanner({ _testNeedRefresh, _testUpdate }: SwUpdateBannerProps): JSX.Element | null {
  const { needRefresh: [hookNeedRefresh], updateServiceWorker: hookUpdate } = useRegisterSW({
    // onNeedRefresh is handled via the returned needRefresh tuple — no action needed here.
    onNeedRefresh() {},
    onOfflineReady() {},
  });

  const needRefresh = _testNeedRefresh !== undefined ? _testNeedRefresh : hookNeedRefresh;
  const updateServiceWorker = _testUpdate ?? hookUpdate;

  const [dismissed, setDismissed] = useState(false);

  if (!needRefresh || dismissed) return null;

  function handleUpdate(): void {
    void updateServiceWorker(true);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: '10px 16px',
        background: 'var(--accent)',
        color: 'var(--accent-text)',
        fontSize: 14,
        fontWeight: 500,
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
      }}
    >
      <span>A new version is available</span>
      <button
        type="button"
        onClick={handleUpdate}
        style={{
          padding: '6px 16px',
          background: 'var(--accent-text)',
          color: 'var(--accent)',
          border: 'none',
          borderRadius: 8,
          fontWeight: 600,
          cursor: 'pointer',
          fontSize: 13,
          minHeight: 36,
        }}
      >
        Update now
      </button>
      <button
        type="button"
        aria-label="Dismiss update notification"
        onClick={() => setDismissed(true)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--accent-text)',
          cursor: 'pointer',
          fontSize: 18,
          lineHeight: 1,
          padding: '4px 8px',
          minHeight: 36,
          opacity: 0.8,
        }}
      >
        ×
      </button>
    </div>
  );
}
