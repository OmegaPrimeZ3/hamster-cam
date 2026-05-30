// app/web/src/hooks/useNow.ts
//
// Returns the current epoch ms, re-computed every `intervalMs` milliseconds.
// This drives relative-timestamp re-renders ("5 minutes ago" → "6 minutes ago")
// without requiring each consumer to manage its own interval.

import { useEffect, useState } from 'react';

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
