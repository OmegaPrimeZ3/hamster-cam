// app/web/src/hooks/useTTSEnabled.ts
//
// Persists the "Read diary aloud" per-card toggle to localStorage.
// Key: 'hc.tts.enabled' — defaults to true (opt-out rather than opt-in,
// matching the kid-first philosophy of the app).
//
// Pattern: read once on mount, write on change. No sync listener — tabs
// share state only on next load, which is fine for a preference toggle.

import { useCallback, useState } from 'react';

const LS_KEY = 'hc.tts.enabled';

function readStored(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    // Treat missing key as default (true). Only stored 'false' means disabled.
    if (raw === null) return true;
    return raw !== 'false';
  } catch {
    return true;
  }
}

export interface UseTTSEnabledResult {
  ttsEnabled: boolean;
  setTTSEnabled: (enabled: boolean) => void;
}

export function useTTSEnabled(): UseTTSEnabledResult {
  const [ttsEnabled, setLocal] = useState<boolean>(readStored);

  const setTTSEnabled = useCallback((enabled: boolean) => {
    setLocal(enabled);
    try {
      localStorage.setItem(LS_KEY, String(enabled));
    } catch {
      // localStorage unavailable (private browsing, quota, etc.) — silent.
    }
  }, []);

  return { ttsEnabled, setTTSEnabled };
}
