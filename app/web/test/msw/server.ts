// app/web/test/msw/server.ts
//
// Default msw server: REST /auth/* + tRPC dispatcher. Tests override per-case
// with `server.use(http.post('/auth/login', ...))` or `mockQuery('foo.bar', ...)`.

import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { trpcHandlers } from './trpc-mock';

const defaultMe = http.get('/auth/me', () => HttpResponse.json(null, { status: 401 }));
const defaultLogin = http.post('/auth/login', () =>
  HttpResponse.json({ message: 'no handler' }, { status: 500 }),
);
const defaultLogout = http.post('/auth/logout', () => new HttpResponse(null, { status: 204 }));
const defaultMfa = http.post('/auth/mfa/verify', () =>
  HttpResponse.json({ message: 'no handler' }, { status: 500 }),
);

export const server = setupServer(
  defaultMe,
  defaultLogin,
  defaultLogout,
  defaultMfa,
  ...trpcHandlers(),
);

export { http, HttpResponse };
