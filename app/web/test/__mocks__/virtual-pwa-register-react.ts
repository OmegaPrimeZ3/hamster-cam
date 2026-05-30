// app/web/test/__mocks__/virtual-pwa-register-react.ts
//
// Stub for `virtual:pwa-register/react` used in vitest (jsdom).
// The real module is synthesized by vite-plugin-pwa at build time and doesn't
// exist in the test environment.
//
// Returns a minimal hook shape that matches what SwUpdateBanner consumes:
//   needRefresh: [boolean, Dispatch<boolean>]
//   updateServiceWorker: (reloadPage?: boolean) => Promise<void>

import React, { useState } from 'react';

export function useRegisterSW(_opts?: {
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
}): {
  needRefresh: [boolean, React.Dispatch<React.SetStateAction<boolean>>];
  offlineReady: [boolean, React.Dispatch<React.SetStateAction<boolean>>];
  updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
} {
  const needRefresh = useState(false);
  const offlineReady = useState(false);
  return {
    needRefresh,
    offlineReady,
    updateServiceWorker: async (_reloadPage?: boolean) => undefined,
  };
}
