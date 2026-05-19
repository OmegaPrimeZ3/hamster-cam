// app/web/test/test-utils.tsx
//
// Render helper that wraps the tree with tRPC + React Query + Router so
// components-under-test see the same providers as production.

import { ReactElement, ReactNode } from 'react';
import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { trpc, makeTrpcClient } from '../src/trpc';

export interface WithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  route?: string;
}

export function renderWithProviders(
  ui: ReactElement,
  options: WithProvidersOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const trpcClient = makeTrpcClient();

  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[options.route ?? '/']}>
            {children}
          </MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    );
  }

  const result = render(ui, { wrapper: Wrapper, ...options });
  return { ...result, queryClient };
}
