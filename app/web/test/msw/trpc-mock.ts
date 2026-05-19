// app/web/test/msw/trpc-mock.ts
//
// Minimal tRPC-over-HTTP responder for msw. Mirrors the wire format produced
// by `httpBatchLink`:
//
//   GET  /trpc/foo.bar,baz.qux?batch=1&input=<encoded {0:..., 1:...}>
//   POST /trpc/foo.bar,baz.qux?batch=1   (body = {0:..., 1:...})
//
// Response is an array per the batched encoding:
//   [{ result: { data: ... } }, ...]
//
// `defineProcedure` registers a handler keyed by procedure path. Procedures
// not registered → 500 from the responder so tests fail loud.
//
// The handler imports `RouterInputs` / `RouterOutputs` types via the
// frontend's own typed client, so a mock's signature drift from `AppRouter`
// is caught at compile time.

import { http, HttpResponse, type DefaultBodyType } from 'msw';
import type { RouterInputs, RouterOutputs } from '../../src/trpc';

type ProcKey = `${keyof RouterInputs & string}.${string}`;

interface ProcEntry {
  path: ProcKey;
  type: 'query' | 'mutation';
  handler: (input: unknown) => unknown | Promise<unknown>;
}

const registry: Map<ProcKey, ProcEntry> = new Map();

export function defineProcedure<P extends ProcKey>(
  path: P,
  type: 'query' | 'mutation',
  handler: (input: unknown) => unknown | Promise<unknown>,
): void {
  registry.set(path, { path, type, handler });
}

// Sugar wrappers that constrain the input/output types to the real
// AppRouter for a given path. Tests use these so mocks always match the
// contract.

type Path = keyof FlatProcedures<RouterInputs>;
type FlatProcedures<T> = {
  [K in keyof T & string as `${K}.${keyof T[K] & string}`]: T[K][keyof T[K] & string];
};
type InputFor<P extends Path> = FlatProcedures<RouterInputs>[P];
type OutputFor<P extends Path> = P extends keyof FlatProcedures<RouterOutputs>
  ? FlatProcedures<RouterOutputs>[P]
  : never;

export function mockQuery<P extends Path>(
  path: P,
  handler: (input: InputFor<P>) => OutputFor<P> | Promise<OutputFor<P>>,
): void {
  defineProcedure(path as ProcKey, 'query', handler as (input: unknown) => unknown);
}

export function mockMutation<P extends Path>(
  path: P,
  handler: (input: InputFor<P>) => OutputFor<P> | Promise<OutputFor<P>>,
): void {
  defineProcedure(path as ProcKey, 'mutation', handler as (input: unknown) => unknown);
}

export function clearMocks(): void {
  registry.clear();
}

interface BatchInputMap {
  [k: string]: unknown;
}

async function dispatch(
  pathList: string[],
  inputs: BatchInputMap,
  expectedType: 'query' | 'mutation',
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < pathList.length; i++) {
    const procPath = pathList[i]!;
    const entry = registry.get(procPath as ProcKey);
    if (!entry) {
      throw new Error(`tRPC mock not registered: ${procPath}`);
    }
    if (entry.type !== expectedType) {
      throw new Error(
        `tRPC mock for ${procPath} is a ${entry.type}, called as ${expectedType}`,
      );
    }
    const input = inputs[String(i)];
    const data = await entry.handler(input);
    out.push({ result: { data } });
  }
  return out;
}

function parseBatchedInput(raw: string | null): BatchInputMap {
  if (!raw) return {};
  try {
    const decoded = decodeURIComponent(raw);
    const parsed = JSON.parse(decoded);
    return typeof parsed === 'object' && parsed !== null ? (parsed as BatchInputMap) : {};
  } catch {
    return {};
  }
}

/**
 * MSW handlers for any tRPC GET/POST. Returned as an array so callers can
 * spread them into setupServer().
 */
export function trpcHandlers(): Array<ReturnType<typeof http.get>> {
  return [
    http.get('/trpc/:procs', async ({ params, request }) => {
      const procs = String((params as { procs: string }).procs).split(',');
      const url = new URL(request.url);
      const inputs = parseBatchedInput(url.searchParams.get('input'));
      try {
        const result = await dispatch(procs, inputs, 'query');
        return HttpResponse.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        return HttpResponse.json({ error: { message } }, { status: 500 });
      }
    }),
    http.post('/trpc/:procs', async ({ params, request }) => {
      const procs = String((params as { procs: string }).procs).split(',');
      let body: DefaultBodyType | null = null;
      try {
        body = (await request.json()) as DefaultBodyType;
      } catch {
        body = null;
      }
      const inputs = (body ?? {}) as BatchInputMap;
      try {
        const result = await dispatch(procs, inputs, 'mutation');
        return HttpResponse.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        return HttpResponse.json({ error: { message } }, { status: 500 });
      }
    }),
  ];
}
