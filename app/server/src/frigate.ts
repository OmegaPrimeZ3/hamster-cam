// app/server/src/frigate.ts
// Typed Frigate REST client. Used by:
//   - cameras.discover  (GET /api/config)
//   - cameras.testStream (HEAD probe)
//   - cameras.list      (GET /api/stats — per-camera lastFrameAt)
//   - share.send         (recording-clip fetch for ffmpeg extraction)
//
// Stage 2a fills the bodies.

export interface DiscoveredCamera {
  name: string;
  /** Suggested `cameras.stream_url` value (rtsp:// or http(s)://). */
  stream_url: string;
}

export interface CameraStats {
  /** ms since epoch of the most recent frame Frigate has processed. */
  lastFrameAt: number | null;
  /** Best-effort FPS in the last sampling window. */
  fps: number | null;
}

export interface ExtractedClip {
  /** Absolute path on the server's filesystem of the produced .mp4. */
  path: string;
  /** Duration of the clip in milliseconds. */
  duration_ms: number;
}

export async function discoverCameras(): Promise<DiscoveredCamera[]> {
  throw new Error('Stage 2a will implement frigate.discoverCameras');
}

export async function testStream(_url: string): Promise<{ ok: boolean; status: number | null }> {
  throw new Error('Stage 2a will implement frigate.testStream');
}

export async function getCameraStats(_cameraName: string): Promise<CameraStats> {
  throw new Error('Stage 2a will implement frigate.getCameraStats');
}

export interface ExtractClipInput {
  cameraName: string;
  centerMs: number;
  /** Default 10_000. */
  durationMs?: number;
}

export async function extractClip(_input: ExtractClipInput): Promise<ExtractedClip> {
  throw new Error('Stage 2a will implement frigate.extractClip');
}
