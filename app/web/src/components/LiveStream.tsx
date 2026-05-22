// app/web/src/components/LiveStream.tsx
//
// React wrapper around the vendored go2rtc VideoRTC web component.
//
// Props:
//   liveSrc  — go2rtc stream name (from camera.live_src). If null, does NOT
//               attempt a connection and renders the "not configured" state.
//   style    — CSS properties forwarded to the host element (use this to apply
//               pinch-zoom transform without breaking the inner <video>).
//   videoRef — optional ref forwarded to the internal <video> element; used
//               by MaximizedCamera for Picture-in-Picture.
//   onError  — called when the player fires a connection error / stalled event.
//   isAdmin  — drives the "configure in settings" affordance for the null case.
//   onConfigureClick — admin shortcut to Settings → Cameras.
//
// Connection lifecycle:
//   - liveSrc changes → old element is removed from the DOM, new one is
//     created (key-based remount via wrapping div key). The VideoRTC
//     disconnectedCallback tears down WS/PC cleanly.
//   - Unmount → element is removed from DOM → DISCONNECT_TIMEOUT fires →
//     WS/PC closed. No leaks.
//   - Error states propagate to onError; the parent's state machine maps
//     that to the tile's `error` state.

import { useEffect, useRef, CSSProperties } from 'react';
import '../lib/video-rtc.js'; // side-effect: registers <video-rtc> custom element

// Augment JSX intrinsics so we can use <video-rtc> inline.
declare global {
  namespace JSX {
    interface IntrinsicElements {
      'video-rtc': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        ref?: React.Ref<VideoRTCElement>;
      };
    }
  }
}

interface VideoRTCElement extends HTMLElement {
  src: string;
  mode: string;
  media: string;
  video: HTMLVideoElement | null;
}

export interface LiveStreamProps {
  /** go2rtc stream name — null means "not configured". */
  liveSrc: string | null;
  /** CSS passed to the host wrapper (used for zoom transforms in maximized view). */
  style?: CSSProperties;
  /** Ref forwarded to the inner <video> element for PiP support. */
  videoRef?: React.RefObject<HTMLVideoElement>;
  /** Called when the player encounters a connection or decode error. */
  onError?: () => void;
  /** Whether the current user is an admin (drives the settings affordance). */
  isAdmin?: boolean;
  /** Admin callback to open Settings → Cameras for the "not configured" state. */
  onConfigureClick?: () => void;
}

/** Build the same-origin WS URL the backend expects for /live/ws. */
function buildWsUrl(liveSrc: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/live/ws?src=${encodeURIComponent(liveSrc)}`;
}

export function LiveStream({
  liveSrc,
  style,
  videoRef,
  onError,
  isAdmin,
  onConfigureClick,
}: LiveStreamProps): JSX.Element {
  const hostRef = useRef<VideoRTCElement | null>(null);
  // Stable ref to onError so the effect below never needs to re-run on callback changes.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !liveSrc) return;

    // WebRTC preferred, MSE fallback per the task spec.
    host.mode = 'webrtc,mse,hls,mjpeg';
    host.media = 'video,audio';

    // Setting .src on the VideoRTC element triggers onconnect().
    // The value is the WS URL that the /live/ws proxy listens on.
    host.src = buildWsUrl(liveSrc);

    // Forward the inner <video> ref. The VideoRTC element creates its
    // <video> child inside oninit() which runs synchronously on connectedCallback.
    // We poll once via rAF to give the custom element one tick to initialise.
    let raf = 0;
    function tryForwardVideoRef(): void {
      if (!videoRef) return;
      const video = host?.video ?? null;
      if (video) {
        (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = video;
        return;
      }
      raf = requestAnimationFrame(tryForwardVideoRef);
    }
    tryForwardVideoRef();

    // Surface errors: listen on the host element for a custom error event that
    // the VideoRTC class emits when its inner <video> fires an error and the WS
    // is subsequently closed. We use a polling stall-check instead of relying on
    // a custom event (the upstream class doesn't emit one) — watch the WS readyState
    // via a simple interval: if the element stays in CONNECTING state for more
    // than RECONNECT_TIMEOUT without going OPEN, surface onError.
    //
    // Simpler alternative: listen to the inner video's error event once it's set.
    let stallCheckId = 0;
    const STALL_TIMEOUT_MS = 20_000;
    const startTs = Date.now();
    stallCheckId = window.setInterval(() => {
      const vid = host.video;
      // If video exists and has an error, fire callback.
      if (vid && vid.error) {
        window.clearInterval(stallCheckId);
        onErrorRef.current?.();
        return;
      }
      // If we haven't made progress in STALL_TIMEOUT_MS, surface an error.
      if (Date.now() - startTs > STALL_TIMEOUT_MS && vid && vid.readyState === 0) {
        window.clearInterval(stallCheckId);
        onErrorRef.current?.();
      }
    }, 2000);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(stallCheckId);
      // Clear the forwarded ref on teardown.
      if (videoRef) {
        (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = null;
      }
    };
    // liveSrc is the key dependency; a change causes remount via the key prop on the wrapper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSrc]);

  // "Not configured" state — admins get a tap-to-configure affordance.
  if (!liveSrc) {
    return (
      <div
        style={{
          ...style,
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          background: 'var(--surface-raised)',
          color: 'var(--text-muted)',
          fontSize: 13,
          textAlign: 'center',
          padding: 16,
        }}
      >
        <span aria-hidden style={{ fontSize: 28 }}>📡</span>
        <span>Live stream not configured</span>
        {isAdmin && onConfigureClick && (
          <button
            type="button"
            className="hc-btn"
            style={{ minHeight: 40, marginTop: 4 }}
            onClick={onConfigureClick}
          >
            Configure in Settings
          </button>
        )}
      </div>
    );
  }

  // Keyed by liveSrc so a change in stream name causes a clean DOM remount,
  // which triggers VideoRTC.disconnectedCallback → cleanup on the old element.
  return (
    <div
      key={liveSrc}
      style={{
        ...style,
        width: '100%',
        height: '100%',
        position: 'relative',
        background: '#000',
      }}
    >
      <video-rtc
        ref={hostRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          objectFit: 'contain',
        }}
      />
    </div>
  );
}
