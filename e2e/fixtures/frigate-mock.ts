// e2e/fixtures/frigate-mock.ts
//
// Tiny HTTP server emulating the slice of Frigate's REST API the backend
// reads (`/api/config` for discover, `/api/stats` for per-camera freshness).
// Specs that don't need it can leave FRIGATE_URL unset and the backend
// degrades to "no cameras found".

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface FrigateMockCamera {
  name: string;
  /** rtsp/http stream path used by Frigate's ffmpeg input. */
  stream_url: string;
  /** Optional last-frame epoch (seconds) reported by /api/stats. */
  last_frame_time?: number;
}

export interface FrigateMock {
  baseUrl: string;
  setCameras: (cams: FrigateMockCamera[]) => void;
  close: () => Promise<void>;
}

export async function startFrigateMock(initial: FrigateMockCamera[] = []): Promise<FrigateMock> {
  let cameras: FrigateMockCamera[] = [...initial];

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url.startsWith('/api/config')) {
      const config: { cameras: Record<string, { ffmpeg: { inputs: Array<{ path: string; roles: string[] }> } }> } = {
        cameras: {},
      };
      for (const c of cameras) {
        config.cameras[c.name] = {
          ffmpeg: { inputs: [{ path: c.stream_url, roles: ['detect'] }] },
        };
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(config));
      return;
    }
    if (req.method === 'GET' && url.startsWith('/api/stats')) {
      const stats: { cameras: Record<string, { camera_fps: number; last_frame_time: number }> } = {
        cameras: {},
      };
      for (const c of cameras) {
        stats.cameras[c.name] = {
          camera_fps: 15,
          last_frame_time: c.last_frame_time ?? Math.floor(Date.now() / 1000),
        };
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(stats));
      return;
    }
    res.statusCode = 404;
    res.end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    setCameras(next) {
      cameras = [...next];
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
