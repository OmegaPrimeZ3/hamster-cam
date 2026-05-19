// app/web/src/main.tsx
//
// React entry point. Wires:
//   - QueryClient + tRPC provider
//   - BrowserRouter (one router for the whole app)
//   - Theme bootstrap that paints palette + mode BEFORE first render so we
//     don't get a light-mode flash on dark systems
//   - Service-worker registration (vite-plugin-pwa autoUpdate)
//   - Font CSS imports (loaded via index.css)

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { trpc, makeTrpcClient } from './trpc';
import {
  applyTheme,
  readPersisted,
  resolveMode,
  systemPrefersDark,
} from './theme';

import './index.css';

// Paint the theme before React renders so dark-mode users don't see a flash.
function bootstrapTheme(): void {
  const persisted = readPersisted();
  const palette = persisted?.palette ?? 'bubblegum';
  const mode = persisted?.mode ?? 'auto';
  applyTheme({ palette, mode: resolveMode(mode, systemPrefersDark()) });
}
bootstrapTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});
const trpcClient = makeTrpcClient();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root container in index.html');
}

createRoot(container).render(
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
