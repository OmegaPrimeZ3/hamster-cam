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

    // WebRTC on LAN, MSE everywhere else. HLS and MJPEG are intentionally
    // excluded: HLS assigns a data: URL to <video>.src which the site CSP
    // (media-src 'self' blob:) blocks, and MJPEG is an unnecessary extra
    // fallback surface. Changing this set requires a matching CSP update.
    host.mode = 'webrtc,mse';
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

    // Stall detection: two failure modes are monitored.
    //
    // Mode A — cold-start hang: video.readyState stays 0 for >20s with no
    // frames arriving (the existing check).
    //
    // Mode B — silent mid-stream freeze: the socket stays "open" but
    // video.currentTime stops advancing. This goes unnoticed by browser error
    // events because no error actually fires. We sample currentTime every
    // ADVANCE_POLL_MS and fire onError if it fails to advance for
    // ADVANCE_STALL_TIMEOUT_MS while the document is visible and the element
    // should be playing (readyState >= HAVE_CURRENT_DATA and not paused/ended).
    let stallCheckId = 0;
    const STALL_TIMEOUT_MS = 20_000;
    const ADVANCE_POLL_MS = 2_000;
    const ADVANCE_STALL_TIMEOUT_MS = 12_000;

    const startTs = Date.now();
    let lastCurrentTime: number | null = null;
    let lastAdvanceTs: number = Date.now();

    stallCheckId = window.setInterval(() => {
      const vid = host.video;

      // Mode A: explicit video decode error.
      if (vid && vid.error) {
        window.clearInterval(stallCheckId);
        onErrorRef.current?.();
        return;
      }

      // Mode A: never connected — readyState=0 (HAVE_NOTHING) for too long.
      if (Date.now() - startTs > STALL_TIMEOUT_MS && vid && vid.readyState === 0) {
        window.clearInterval(stallCheckId);
        onErrorRef.current?.();
        return;
      }

      // Mode B: playing but frozen — currentTime not advancing.
      // Only fire when the page is visible (don't punish background tabs) and
      // the video element is in a state where it should be making progress
      // (readyState >= HAVE_CURRENT_DATA=2, not paused, not ended).
      if (
        vid &&
        document.visibilityState === 'visible' &&
        !vid.paused &&
        !vid.ended &&
        vid.readyState >= 2
      ) {
        const ct = vid.currentTime;
        if (lastCurrentTime === null || ct !== lastCurrentTime) {
          // Time is advancing — reset the stall clock.
          lastCurrentTime = ct;
          lastAdvanceTs = Date.now();
        } else if (Date.now() - lastAdvanceTs > ADVANCE_STALL_TIMEOUT_MS) {
          // currentTime has not moved for ADVANCE_STALL_TIMEOUT_MS. Silent freeze.
          window.clearInterval(stallCheckId);
          onErrorRef.current?.();
        }
      }
    }, ADVANCE_POLL_MS);

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
