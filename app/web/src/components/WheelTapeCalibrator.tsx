// app/web/src/components/WheelTapeCalibrator.tsx
//
// Tape-crossing detector calibration card. Replaces WheelMotionCalibrator.
//
// Architecture:
//   - Polls getWheelTape every 150ms while the card is expanded and the page
//     is visible. Polling is paused on visibilitychange to save bandwidth.
//   - The oscilloscope is a Canvas2D line chart drawn with requestAnimationFrame
//     so the redraw is decoupled from the poll cadence.
//   - Admin sees full edit UI. Non-admins see read-only oscilloscope + stats.
//   - ROI drag is pointer-event-based (no external drag library). The default
//     shape is a wide horizontal strip, not a square.
//   - Sensitivity slider commits on pointerUp. Circumference input commits on
//     blur (debounced — 300ms).
//   - Recent-sessions panel is collapsible and fetched on-demand.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { trpc, type RouterOutputs } from '../trpc';
import { LiveStream } from './LiveStream';
import { useAuth } from '../hooks/useAuth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WheelTapeConfig = RouterOutputs['cameras']['getWheelTape'];
type TapeSession = RouterOutputs['cameras']['getWheelTapeSessionsRecent'][number];

interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Default ROI: a wide horizontal strip across the middle of the frame.
// A wider strip catches the tape on each rotation more reliably than a square.
const DEFAULT_ROI: Roi = { x: 10, y: 40, w: 80, h: 20 };

const DEFAULT_SENSITIVITY = 2.0;
const DEFAULT_CIRCUMFERENCE_CM = 13;

// ---------------------------------------------------------------------------
// Session time helpers
// ---------------------------------------------------------------------------

function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDuration(startMs: number, endMs: number): string {
  const totalS = Math.floor((endMs - startMs) / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WheelTapeCalibratorProps {
  cameraId: number;
  liveSrc: string | null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WheelTapeCalibrator({
  cameraId,
  liveSrc,
}: WheelTapeCalibratorProps): JSX.Element {
  const { isAdmin } = useAuth();
  const utils = trpc.useUtils();

  const [open, setOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionsEnabled, setSessionsEnabled] = useState(false);

  // Local slider / input state — committed to server on release/blur.
  // Null means "not yet synced from server"; defaults are applied on first load.
  const [localSensitivity, setLocalSensitivity] = useState<number | null>(null);
  const [localCircumference, setLocalCircumference] = useState<number | null>(null);

  // Page-visibility gate for the poll loop.
  const [pageVisible, setPageVisible] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'visible',
  );
  useEffect(() => {
    function onVisibility(): void {
      setPageVisible(document.visibilityState === 'visible');
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // ── tRPC: poll getWheelTape ───────────────────────────────────────────────
  const tapeQuery = trpc.cameras.getWheelTape.useQuery(
    { cameraId },
    {
      enabled: open && pageVisible,
      refetchInterval: open && pageVisible ? 150 : false,
      refetchIntervalInBackground: false,
    },
  );

  const setWheelTape = trpc.cameras.setWheelTape.useMutation({
    onSuccess: async () => {
      await utils.cameras.getWheelTape.invalidate({ cameraId });
    },
  });

  // ── tRPC: sessions ────────────────────────────────────────────────────────
  const sessionsQuery = trpc.cameras.getWheelTapeSessionsRecent.useQuery(
    { cameraId },
    { enabled: sessionsEnabled, staleTime: Infinity },
  );

  // Seed local state from the first server response.
  useEffect(() => {
    if (!tapeQuery.data) return;
    if (localSensitivity === null) {
      setLocalSensitivity(tapeQuery.data.sensitivity);
    }
    if (localCircumference === null) {
      setLocalCircumference(tapeQuery.data.circumferenceCm);
    }
  }, [tapeQuery.data, localSensitivity, localCircumference]);

  // ── Derived values ────────────────────────────────────────────────────────
  const roi = tapeQuery.data?.roi ?? null;
  const enabled = roi !== null;
  const sensitivity = localSensitivity ?? DEFAULT_SENSITIVITY;
  const circumferenceCm = localCircumference ?? DEFAULT_CIRCUMFERENCE_CM;
  const signal = tapeQuery.data?.signal ?? null;

  // ── Enable / disable toggle ───────────────────────────────────────────────
  function handleEnableToggle(checked: boolean): void {
    if (!isAdmin) return;
    setWheelTape.mutate({
      cameraId,
      roi: checked ? DEFAULT_ROI : null,
      sensitivity,
      circumferenceCm,
    });
  }

  // ── Commit sensitivity on pointer-up ─────────────────────────────────────
  function commitSensitivity(value: number): void {
    if (!isAdmin || roi === null) return;
    setWheelTape.mutate({ cameraId, roi, sensitivity: value, circumferenceCm });
  }

  // ── Circumference: debounced commit ──────────────────────────────────────
  const circumferenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleCircumferenceChange(value: number): void {
    setLocalCircumference(value);
    if (circumferenceTimerRef.current !== null) {
      clearTimeout(circumferenceTimerRef.current);
    }
    circumferenceTimerRef.current = setTimeout(() => {
      if (!isAdmin || roi === null) return;
      setWheelTape.mutate({ cameraId, roi, sensitivity, circumferenceCm: value });
    }, 300);
  }

  function handleCircumferenceBlur(): void {
    if (circumferenceTimerRef.current !== null) {
      clearTimeout(circumferenceTimerRef.current);
      circumferenceTimerRef.current = null;
    }
    if (!isAdmin || roi === null) return;
    const val = localCircumference ?? DEFAULT_CIRCUMFERENCE_CM;
    setWheelTape.mutate({ cameraId, roi, sensitivity, circumferenceCm: val });
  }

  // ── ROI drag ──────────────────────────────────────────────────────────────
  const frameRef = useRef<HTMLDivElement | null>(null);

  const [dragState, setDragState] = useState<{
    type: 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 'e' | 's' | 'w';
    startX: number;
    startY: number;
    startRoi: Roi;
  } | null>(null);

  const [liveRoi, setLiveRoi] = useState<Roi | null>(null);
  const displayRoi = liveRoi ?? roi;

  const onRoiPointerDown = useCallback(
    (
      e: ReactPointerEvent<HTMLDivElement>,
      type: NonNullable<typeof dragState>['type'],
    ) => {
      if (!isAdmin || roi === null) return;
      e.stopPropagation();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      setDragState({ type, startX: e.clientX, startY: e.clientY, startRoi: roi });
      setLiveRoi(roi);
    },
    [isAdmin, roi],
  );

  const onOverlayPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragState || !frameRef.current) return;
      const frame = frameRef.current.getBoundingClientRect();
      const dx = ((e.clientX - dragState.startX) / frame.width) * 100;
      const dy = ((e.clientY - dragState.startY) / frame.height) * 100;
      const r = dragState.startRoi;

      let nx = r.x;
      let ny = r.y;
      let nw = r.w;
      let nh = r.h;

      switch (dragState.type) {
        case 'move':
          nx = Math.max(0, Math.min(100 - r.w, r.x + dx));
          ny = Math.max(0, Math.min(100 - r.h, r.y + dy));
          break;
        case 'nw':
          nx = Math.max(0, Math.min(r.x + r.w - 5, r.x + dx));
          ny = Math.max(0, Math.min(r.y + r.h - 5, r.y + dy));
          nw = r.x + r.w - nx;
          nh = r.y + r.h - ny;
          break;
        case 'ne':
          ny = Math.max(0, Math.min(r.y + r.h - 5, r.y + dy));
          nw = Math.max(5, Math.min(100 - r.x, r.w + dx));
          nh = r.y + r.h - ny;
          break;
        case 'sw':
          nx = Math.max(0, Math.min(r.x + r.w - 5, r.x + dx));
          nw = r.x + r.w - nx;
          nh = Math.max(5, Math.min(100 - r.y, r.h + dy));
          break;
        case 'se':
          nw = Math.max(5, Math.min(100 - r.x, r.w + dx));
          nh = Math.max(5, Math.min(100 - r.y, r.h + dy));
          break;
        case 'n':
          ny = Math.max(0, Math.min(r.y + r.h - 5, r.y + dy));
          nh = r.y + r.h - ny;
          break;
        case 's':
          nh = Math.max(5, Math.min(100 - r.y, r.h + dy));
          break;
        case 'w':
          nx = Math.max(0, Math.min(r.x + r.w - 5, r.x + dx));
          nw = r.x + r.w - nx;
          break;
        case 'e':
          nw = Math.max(5, Math.min(100 - r.x, r.w + dx));
          break;
      }

      setLiveRoi({
        x: Math.round(nx),
        y: Math.round(ny),
        w: Math.round(nw),
        h: Math.round(nh),
      });
    },
    [dragState],
  );

  const onOverlayPointerUp = useCallback(() => {
    if (!dragState || !liveRoi) {
      setDragState(null);
      setLiveRoi(null);
      return;
    }
    const committed = liveRoi;
    setDragState(null);
    setLiveRoi(null);
    setWheelTape.mutate({ cameraId, roi: committed, sensitivity, circumferenceCm });
  }, [dragState, liveRoi, cameraId, sensitivity, circumferenceCm, setWheelTape]);

  // ── Sessions panel ────────────────────────────────────────────────────────
  function handleSessionsToggle(): void {
    if (!sessionsOpen) {
      setSessionsEnabled(true);
      void sessionsQuery.refetch();
    }
    setSessionsOpen((v) => !v);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
        marginTop: 8,
      }}
    >
      {/* ---- Collapsible header ---- */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`wheel-tape-body-${cameraId}`}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '10px 14px',
          background: 'var(--surface-raised)',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: "'Fredoka', sans-serif",
          fontWeight: 600,
          fontSize: 15,
          color: 'var(--text)',
          minHeight: 44,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span aria-hidden>🎡</span>
          Wheel rotations (tape)
          {enabled && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 8px',
                borderRadius: 999,
                background: 'color-mix(in srgb, var(--success, #22c55e) 20%, transparent)',
                border: '1px solid color-mix(in srgb, var(--success, #22c55e) 35%, transparent)',
                color: 'var(--success, #22c55e)',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.03em',
                textTransform: 'uppercase',
              }}
            >
              active
            </span>
          )}
        </span>
        {open ? <ChevronUp aria-hidden size={16} /> : <ChevronDown aria-hidden size={16} />}
      </button>

      {/* ---- Body ---- */}
      {open && (
        <div
          id={`wheel-tape-body-${cameraId}`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
            padding: '16px',
            background: 'var(--surface)',
          }}
        >
          {tapeQuery.isLoading && (
            <p style={{ margin: 0, color: 'var(--text-muted)' }}>Loading…</p>
          )}

          {!tapeQuery.isLoading && (
            <>
              {/* ---- Enable toggle ---- */}
              <FieldRow>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    cursor: isAdmin ? 'pointer' : 'default',
                    opacity: setWheelTape.isLoading ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={!isAdmin || setWheelTape.isLoading}
                    onChange={(e) => handleEnableToggle(e.target.checked)}
                    style={{ width: 22, height: 22, marginTop: 1, flexShrink: 0 }}
                  />
                  <span>
                    <span style={{ fontWeight: 600 }}>Track wheel rotations (tape)</span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 13,
                        opacity: 0.65,
                        fontWeight: 400,
                        marginTop: 2,
                      }}
                    >
                      Counts rotations by detecting when the tape on the wheel
                      crosses the strip. Distance is rotations times circumference.
                    </span>
                  </span>
                </label>
              </FieldRow>

              {/* ---- Oscilloscope stats + plot ---- */}
              <LiveStats signal={signal} />

              {/* ---- ROI picker + oscilloscope canvas — only when enabled ---- */}
              {enabled && displayRoi !== null && (
                <>
                  {/* Wide-strip ROI over live frame */}
                  {liveSrc !== null && (
                    <FieldRow>
                      <span className="hc-label">Strip position</span>
                      <p style={{ margin: '0 0 6px', color: 'var(--text-muted)', fontSize: 13 }}>
                        Position this strip so the tape on the wheel passes through it once per
                        rotation. A wider strip catches the tape more reliably than a small box.
                      </p>
                      <div
                        ref={frameRef}
                        data-testid="wheel-tape-roi-frame"
                        style={{
                          position: 'relative',
                          width: '100%',
                          aspectRatio: '16 / 9',
                          borderRadius: 10,
                          overflow: 'hidden',
                          background: '#000',
                          border: '1px solid var(--border)',
                          cursor: dragState ? 'grabbing' : 'default',
                          userSelect: 'none',
                          touchAction: 'none',
                        }}
                        onPointerMove={onOverlayPointerMove}
                        onPointerUp={onOverlayPointerUp}
                      >
                        <LiveStream
                          liveSrc={liveSrc}
                          style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                          }}
                        />

                        {/* Strip overlay */}
                        <div
                          aria-hidden
                          data-testid="wheel-tape-roi-overlay"
                          style={{
                            position: 'absolute',
                            left: `${displayRoi.x}%`,
                            top: `${displayRoi.y}%`,
                            width: `${displayRoi.w}%`,
                            height: `${displayRoi.h}%`,
                            border: '2px solid #f97316',
                            background: 'color-mix(in srgb, #f97316 15%, transparent)',
                            boxSizing: 'border-box',
                            cursor: isAdmin ? 'grab' : 'default',
                          }}
                          onPointerDown={(e) => onRoiPointerDown(e, 'move')}
                        >
                          <span
                            style={{
                              position: 'absolute',
                              top: 3,
                              left: 6,
                              fontSize: 10,
                              fontWeight: 700,
                              color: '#f97316',
                              letterSpacing: '0.04em',
                              textTransform: 'uppercase',
                              textShadow: '0 1px 3px rgba(0,0,0,0.9)',
                              whiteSpace: 'nowrap',
                              pointerEvents: 'none',
                            }}
                          >
                            tape strip
                          </span>

                          {isAdmin && (
                            <>
                              <RoiHandle position="nw" onPointerDown={(e) => onRoiPointerDown(e, 'nw')} />
                              <RoiHandle position="ne" onPointerDown={(e) => onRoiPointerDown(e, 'ne')} />
                              <RoiHandle position="sw" onPointerDown={(e) => onRoiPointerDown(e, 'sw')} />
                              <RoiHandle position="se" onPointerDown={(e) => onRoiPointerDown(e, 'se')} />
                              <RoiHandle position="n" onPointerDown={(e) => onRoiPointerDown(e, 'n')} />
                              <RoiHandle position="s" onPointerDown={(e) => onRoiPointerDown(e, 's')} />
                              <RoiHandle position="w" onPointerDown={(e) => onRoiPointerDown(e, 'w')} />
                              <RoiHandle position="e" onPointerDown={(e) => onRoiPointerDown(e, 'e')} />
                            </>
                          )}
                        </div>
                      </div>

                      {isAdmin && (
                        <small style={{ color: 'var(--text-muted)' }}>
                          Strip: x={displayRoi.x}% y={displayRoi.y}% w={displayRoi.w}% h={displayRoi.h}%
                        </small>
                      )}
                    </FieldRow>
                  )}

                  {liveSrc === null && (
                    <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
                      No live stream configured — add a stream source to enable the strip picker.
                    </p>
                  )}

                  {/* Oscilloscope canvas */}
                  <FieldRow>
                    <span className="hc-label">Live brightness signal</span>
                    <p style={{ margin: '0 0 4px', color: 'var(--text-muted)', fontSize: 13 }}>
                      The orange line is rolling mean (baseline brightness in the strip). The red
                      dashed line is the dip-detection threshold. Each red tick on the axis marks
                      a detected rotation. When Remy spins, you should see periodic dips crossing
                      below the red line.
                    </p>
                    <Oscilloscope signal={signal} sensitivity={sensitivity} />
                  </FieldRow>

                  {/* Sensitivity slider */}
                  {isAdmin && (
                    <FieldRow>
                      <label className="hc-label" htmlFor={`wheel-sensitivity-${cameraId}`}>
                        Dip sensitivity — {sensitivity.toFixed(1)}
                      </label>
                      <input
                        id={`wheel-sensitivity-${cameraId}`}
                        type="range"
                        min={1.5}
                        max={3.5}
                        step={0.1}
                        value={sensitivity}
                        disabled={roi === null}
                        onChange={(e) => setLocalSensitivity(parseFloat(e.target.value))}
                        onPointerUp={(e) =>
                          commitSensitivity(parseFloat((e.target as HTMLInputElement).value))
                        }
                        style={{ width: '100%' }}
                      />
                      <small style={{ color: 'var(--text-muted)' }}>
                        Lower = catches more dips (may fire on noise). Higher = ignores noise
                        (may miss shallow dips). Default 2.0 works well for most reflective
                        tapes in average lighting.
                      </small>
                    </FieldRow>
                  )}

                  {/* Wheel circumference */}
                  {isAdmin && (
                    <FieldRow>
                      <label
                        className="hc-label"
                        htmlFor={`wheel-circumference-${cameraId}`}
                      >
                        Wheel circumference (cm)
                      </label>
                      <input
                        id={`wheel-circumference-${cameraId}`}
                        type="number"
                        min={5}
                        max={30}
                        step={0.5}
                        value={localCircumference ?? DEFAULT_CIRCUMFERENCE_CM}
                        disabled={roi === null}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!Number.isNaN(v)) handleCircumferenceChange(v);
                        }}
                        onBlur={handleCircumferenceBlur}
                        style={{
                          width: 80,
                          padding: '4px 8px',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--surface-raised)',
                          color: 'var(--text)',
                          fontSize: 14,
                        }}
                      />
                      <small style={{ color: 'var(--text-muted)' }}>
                        Measure the inside running surface — the distance Remy's feet cover in
                        one full rotation. A standard 5-inch wheel has a circumference of about
                        13 cm.
                      </small>
                    </FieldRow>
                  )}
                </>
              )}

              {/* Mutation error */}
              {setWheelTape.error && (
                <p role="alert" style={{ margin: 0, color: 'var(--danger)' }}>
                  {setWheelTape.error.message}
                </p>
              )}

              {/* ---- Recent sessions panel ---- */}
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                <button
                  type="button"
                  onClick={handleSessionsToggle}
                  aria-expanded={sessionsOpen}
                  aria-controls={`wheel-tape-sessions-${cameraId}`}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '8px 12px',
                    background: 'var(--surface-raised)',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--text)',
                    minHeight: 40,
                  }}
                >
                  Recent sessions
                  {sessionsOpen ? (
                    <ChevronUp aria-hidden size={14} />
                  ) : (
                    <ChevronDown aria-hidden size={14} />
                  )}
                </button>

                {sessionsOpen && (
                  <div
                    id={`wheel-tape-sessions-${cameraId}`}
                    style={{ padding: '10px 12px', background: 'var(--surface)' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 8,
                      }}
                    >
                      <small style={{ color: 'var(--text-muted)' }}>
                        Last 10 completed wheel sessions — most recent first.
                      </small>
                      <button
                        type="button"
                        className="hc-btn hc-btn-ghost"
                        onClick={() => void sessionsQuery.refetch()}
                        disabled={sessionsQuery.isFetching}
                        aria-label="Refresh sessions"
                        style={{
                          minHeight: 32,
                          padding: '0 8px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <RefreshCw
                          aria-hidden
                          size={13}
                          style={{
                            animation: sessionsQuery.isFetching
                              ? 'spin 1s linear infinite'
                              : undefined,
                          }}
                        />
                        Refresh
                      </button>
                    </div>

                    {sessionsQuery.isLoading && (
                      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
                        Loading…
                      </p>
                    )}

                    {sessionsQuery.data && sessionsQuery.data.length === 0 && (
                      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
                        No sessions recorded yet. Enable wheel tracking and let Remy run.
                      </p>
                    )}

                    {sessionsQuery.data && sessionsQuery.data.length > 0 && (
                      <SessionsTable sessions={sessionsQuery.data.slice(0, 10)} />
                    )}

                    {sessionsQuery.error && (
                      <p
                        role="alert"
                        style={{ margin: 0, color: 'var(--danger)', fontSize: 13 }}
                      >
                        {sessionsQuery.error.message}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LiveStats — big-number readout above/below the oscilloscope
// ---------------------------------------------------------------------------

interface LiveStatsProps {
  signal: WheelTapeConfig['signal'];
}

function LiveStats({ signal }: LiveStatsProps): JSX.Element {
  if (!signal) {
    return (
      <p
        style={{
          margin: 0,
          color: 'var(--text-muted)',
          fontSize: 13,
          fontStyle: 'italic',
        }}
      >
        Track wheel rotations is off — enable the toggle above to start detecting dips.
      </p>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 16,
        padding: '10px 14px',
        background: 'var(--surface-raised)',
        borderRadius: 10,
        border: '1px solid var(--border)',
      }}
    >
      <StatTile
        label="Rotations (30 s)"
        value={String(signal.rotationsLast30s)}
        large
      />
      <StatTile
        label="Rate"
        value={`${signal.rotationRateRps.toFixed(2)} rps`}
      />
      <StatTile
        label="Mean (μ)"
        value={signal.mean.toFixed(1)}
      />
      <StatTile
        label="Std dev (σ)"
        value={signal.std.toFixed(2)}
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  large = false,
}: {
  label: string;
  value: string;
  large?: boolean;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 72 }}>
      <span
        style={{
          fontSize: large ? 26 : 18,
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--text)',
          lineHeight: 1.1,
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Oscilloscope — Canvas2D line chart
// ---------------------------------------------------------------------------

interface OscilloscopeProps {
  signal: WheelTapeConfig['signal'];
  sensitivity: number;
}

function Oscilloscope({ signal, sensitivity }: OscilloscopeProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    // Respect prefers-reduced-motion — skip animated redraw, just draw once.
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function draw(): void {
      if (!canvas || !ctx2d) return;

      const W = canvas.width;
      const H = canvas.height;

      // Clear
      ctx2d.clearRect(0, 0, W, H);

      // Background
      ctx2d.fillStyle = getComputedStyle(canvas).getPropertyValue('--surface-raised') || '#1e1e2e';
      ctx2d.fillRect(0, 0, W, H);

      if (!signal || signal.samples.length < 2) {
        // No data — draw a dim placeholder line
        ctx2d.strokeStyle = 'rgba(150, 150, 180, 0.3)';
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        ctx2d.moveTo(0, H / 2);
        ctx2d.lineTo(W, H / 2);
        ctx2d.stroke();

        ctx2d.fillStyle = 'rgba(150, 150, 180, 0.5)';
        ctx2d.font = '12px Inter, sans-serif';
        ctx2d.textAlign = 'center';
        ctx2d.fillText('Waiting for signal…', W / 2, H / 2 - 8);
        return;
      }

      // Auto-zoom: show mean±3σ range, with a floor of 30px spread
      const { samples, mean, std, threshold, recentDips, sampleMs } = signal;

      // The threshold is computed from the server's current sensitivity.
      // If the user is dragging the slider locally, recompute it from local state.
      const localThreshold = mean - sensitivity * std;

      const spread = Math.max(3 * std, 15);
      const yMin = mean - spread;
      const yMax = mean + spread;
      const yRange = yMax - yMin;

      function sampleToY(v: number): number {
        return H - ((v - yMin) / yRange) * H;
      }

      // ---- Mean line (dashed orange) ----
      ctx2d.save();
      ctx2d.strokeStyle = '#f97316';
      ctx2d.lineWidth = 1.5;
      ctx2d.setLineDash([6, 4]);
      const meanY = sampleToY(mean);
      ctx2d.beginPath();
      ctx2d.moveTo(0, meanY);
      ctx2d.lineTo(W, meanY);
      ctx2d.stroke();
      ctx2d.restore();

      // ---- Threshold line (dashed red) ----
      ctx2d.save();
      ctx2d.strokeStyle = '#ef4444';
      ctx2d.lineWidth = 1.5;
      ctx2d.setLineDash([4, 3]);
      const threshY = sampleToY(localThreshold);
      ctx2d.beginPath();
      ctx2d.moveTo(0, threshY);
      ctx2d.lineTo(W, threshY);
      ctx2d.stroke();

      // Threshold label (top-right of the threshold line)
      ctx2d.fillStyle = '#ef4444';
      ctx2d.font = '10px Inter, sans-serif';
      ctx2d.textAlign = 'right';
      ctx2d.fillText(`threshold ${localThreshold.toFixed(1)}`, W - 6, threshY - 4);
      ctx2d.restore();

      // ---- Samples line ----
      const n = samples.length;
      // Map sample index to X. Newest sample is at the right edge.
      function indexToX(i: number): number {
        return ((i / (n - 1)) * W);
      }

      ctx2d.save();
      ctx2d.strokeStyle = 'rgba(139, 92, 246, 0.9)'; // purple
      ctx2d.lineWidth = 1.5;
      ctx2d.lineJoin = 'round';
      ctx2d.beginPath();
      for (let i = 0; i < n; i++) {
        const x = indexToX(i);
        const y = sampleToY(samples[i] ?? mean);
        if (i === 0) ctx2d.moveTo(x, y);
        else ctx2d.lineTo(x, y);
      }
      ctx2d.stroke();
      ctx2d.restore();

      // ---- Dip tick marks on the bottom axis ----
      if (recentDips.length > 0) {
        const now = Date.now();
        // The oscilloscope shows the last n samples × sampleMs ms of data.
        const windowMs = n * sampleMs;
        const windowStart = now - windowMs;

        ctx2d.save();
        ctx2d.fillStyle = '#ef4444';
        for (const dipEpoch of recentDips) {
          const age = now - dipEpoch;
          if (age < 0 || age > windowMs) continue;
          // Position: most recent dips are on the right.
          const xFrac = 1 - age / windowMs;
          const tickX = xFrac * W;
          ctx2d.fillRect(tickX - 1, H - 8, 2, 8);
        }
        ctx2d.restore();

        void windowStart; // suppress unused-var lint (it's used structurally above)
      }

      // ---- Mean label ----
      ctx2d.save();
      ctx2d.fillStyle = '#f97316';
      ctx2d.font = '10px Inter, sans-serif';
      ctx2d.textAlign = 'right';
      ctx2d.fillText(`μ ${mean.toFixed(1)}`, W - 6, meanY + 13);
      ctx2d.restore();
    }

    function frame(): void {
      draw();
      if (!reducedMotion) {
        rafRef.current = requestAnimationFrame(frame);
      }
    }

    draw();
    if (!reducedMotion) {
      rafRef.current = requestAnimationFrame(frame);
    }

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [signal, sensitivity]);

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={120}
      aria-label="Brightness signal oscilloscope"
      style={{
        width: '100%',
        height: 120,
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--surface-raised)',
        display: 'block',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// SessionsTable
// ---------------------------------------------------------------------------

function SessionsTable({ sessions }: { sessions: TapeSession[] }): JSX.Element {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 12,
          color: 'var(--text)',
        }}
      >
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
            <th
              style={{
                padding: '4px 8px',
                fontWeight: 600,
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              Started
            </th>
            <th
              style={{
                padding: '4px 8px',
                fontWeight: 600,
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              Duration
            </th>
            <th
              style={{
                padding: '4px 8px',
                fontWeight: 600,
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              Rotations
            </th>
            <th
              style={{
                padding: '4px 8px',
                fontWeight: 600,
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              Mean rps
            </th>
            <th
              style={{
                padding: '4px 8px',
                fontWeight: 600,
                color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              Peak rps
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s, i) => (
            <tr
              key={s.startedAt}
              style={{
                borderBottom:
                  i < sessions.length - 1 ? '1px solid var(--border)' : undefined,
                background:
                  i % 2 === 0 ? 'transparent' : 'var(--surface-raised)',
              }}
            >
              <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>
                {formatRelative(s.startedAt)}
              </td>
              <td
                style={{
                  padding: '5px 8px',
                  whiteSpace: 'nowrap',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatDuration(s.startedAt, s.endedAt)}
              </td>
              <td
                style={{
                  padding: '5px 8px',
                  whiteSpace: 'nowrap',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {s.rotations}
              </td>
              <td
                style={{
                  padding: '5px 8px',
                  whiteSpace: 'nowrap',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {s.meanRps.toFixed(2)}
              </td>
              <td
                style={{
                  padding: '5px 8px',
                  whiteSpace: 'nowrap',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {s.peakRps.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoiHandle
// ---------------------------------------------------------------------------

type HandlePosition = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e';

const HANDLE_STYLES: Record<HandlePosition, React.CSSProperties> = {
  nw: { top: -5, left: -5, cursor: 'nw-resize' },
  ne: { top: -5, right: -5, cursor: 'ne-resize' },
  sw: { bottom: -5, left: -5, cursor: 'sw-resize' },
  se: { bottom: -5, right: -5, cursor: 'se-resize' },
  n: { top: -5, left: '50%', transform: 'translateX(-50%)', cursor: 'n-resize' },
  s: { bottom: -5, left: '50%', transform: 'translateX(-50%)', cursor: 's-resize' },
  w: { top: '50%', left: -5, transform: 'translateY(-50%)', cursor: 'w-resize' },
  e: { top: '50%', right: -5, transform: 'translateY(-50%)', cursor: 'e-resize' },
};

function RoiHandle({
  position,
  onPointerDown,
}: {
  position: HandlePosition;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}): JSX.Element {
  return (
    <div
      aria-hidden
      onPointerDown={onPointerDown}
      style={{
        position: 'absolute',
        width: 10,
        height: 10,
        background: '#f97316',
        border: '1px solid #fff',
        borderRadius: 2,
        boxSizing: 'border-box',
        ...HANDLE_STYLES[position],
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function FieldRow({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {children}
    </div>
  );
}
