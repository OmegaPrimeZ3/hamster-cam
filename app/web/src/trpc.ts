// app/web/src/trpc.ts
//
// Typed tRPC client wired to React Query.
//
// - Imports `AppRouter` type only from @hamster-cam/server (zero runtime cost,
//   end-to-end type inference)
// - Hits `/trpc` on the same origin (Caddy reverse-proxies to Fastify in prod;
//   Vite dev-proxy forwards to localhost:3000)
// - Sends cookies on every request so our `__Host-session` cookie travels
// - Exposes both the React hook bundle and a bare vanilla client so non-React
//   callers (e.g. msw-tests, useAuth helpers) can call procedures directly.

import { createTRPCReact, httpBatchLink } from '@trpc/react-query';
import { createTRPCProxyClient } from '@trpc/client';
import type { AppRouter } from '@hamster-cam/server/trpc';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export const trpc = createTRPCReact<AppRouter>();

function trpcUrl(): string {
  // Same-origin in prod (Caddy → Fastify). Vite dev proxy handles dev.
  return '/trpc';
}

function fetchWithCredentials(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: 'include' });
}

export function makeTrpcClient(): ReturnType<typeof trpc.createClient> {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: trpcUrl(),
        fetch: fetchWithCredentials,
      }),
    ],
  });
}

/** Vanilla proxy client for places where React hooks aren't available. */
export function makeVanillaTrpcClient(): ReturnType<typeof createTRPCProxyClient<AppRouter>> {
  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: trpcUrl(),
        fetch: fetchWithCredentials,
      }),
    ],
  });
}
