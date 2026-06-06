// app/web/src/components/WheelMotionCalibrator.tsx
//
// Wheel motion-energy calibration card. Replaces the old tape-band ROI picker.
// Self-contained: manages its own tRPC calls for setWheelMotion, getWheelMotion,
// and getWheelMotionSessionsRecent. Renders a live energy meter, draggable ROI
// overlay, threshold slider, avg-speed slider, and recent-sessions panel.
//
// Architecture:
//   - Admin sees full edit UI; non-admin sees read-only live meter + sessions.
//   - ROI overlay is pointer-event-based (no external drag library).
//   - getWheelMotion polls every 500ms when the card is expanded.
//   - setWheelMotion is called on: enable toggle, drag-end for ROI, slider release.

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

type WheelMotionConfig = RouterOutputs['cameras']['getWheelMotion'];
type RecentSession = RouterOutputs['cameras']['getWheelMotionSessionsRecent'][number];

interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_ROI: Roi = { x: 25, y: 25, w: 50, h: 50 };

// ---------------------------------------------------------------------------
// Speed label helper
// ---------------------------------------------------------------------------

function speedLabel(mps: number): string {
  const kph = mps * 3.6;
  if (mps < 0.5) return `${kph.toFixed(1)} km/h — very slow`;
  if (mps < 1.0) return `${kph.toFixed(1)} km/h — slow trot`;
  if (mps < 1.5) return `${kph.toFixed(1)} km/h — typical hamster pace`;
  if (mps < 2.5) return `${kph.toFixed(1)} km/h — brisk run`;
  return `${kph.toFixed(1)} km/h — full sprint`;
}

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

function formatDuration(ms: number): string {
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WheelMotionCalibratorProps {
  cameraId: number;
  liveSrc: string | null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WheelMotionCalibrator({
  cameraId,
  liveSrc,
}: WheelMotionCalibratorProps): JSX.Element {
  const { isAdmin } = useAuth();
  const utils = trpc.useUtils();

  const [open, setOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  // Local slider state — committed to server on release; not round-tripped
  // through server during drag (avoids laggy UI).
  const [localThreshold, setLocalThreshold] = useState<number | null>(null);
  const [localAvgSpeed, setLocalAvgSpeed] = useState<number | null>(null);

  // ── tRPC: read config + live energy ──────────────────────────────────────
  const configQuery = trpc.cameras.getWheelMotion.useQuery(
    { cameraId },
    {
      enabled: open,
      refetchInterval: open ? 500 : false,
      refetchIntervalInBackground: false,
    },
  );

  const setWheelMotion = trpc.cameras.setWheelMotion.useMutation({
    onSuccess: async () => {
      await utils.cameras.getWheelMotion.invalidate({ cameraId });
    },
  });

  // ── tRPC: recent sessions ─────────────────────────────────────────────────
  const [sessionsEnabled, setSessionsEnabled] = useState(false);
  const sessionsQuery = trpc.cameras.getWheelMotionSessionsRecent.useQuery(
    { cameraId },
    { enabled: sessionsEnabled, staleTime: Infinity },
  );

  // When config loads for the first time, seed local slider state.
  useEffect(() => {
    if (configQuery.data && localThreshold === null) {
      setLocalThreshold(configQuery.data.threshold);
    }
    if (configQuery.data && localAvgSpeed === null) {
      setLocalAvgSpeed(configQuery.data.avgSpeedMps);
    }
  }, [configQuery.data, localThreshold, localAvgSpeed]);

  // ── Derived values ────────────────────────────────────────────────────────
  const roi = configQuery.data?.roi ?? null;
  const enabled = roi !== null;
  const threshold = localThreshold ?? configQuery.data?.threshold ?? 12;
  const avgSpeedMps = localAvgSpeed ?? configQuery.data?.avgSpeedMps ?? 1.0;
  const currentEnergy = configQuery.data?.currentMotionEnergy ?? 0;

  // ── Enable / disable toggle ───────────────────────────────────────────────
  function handleEnableToggle(checked: boolean): void {
    if (!isAdmin) return;
    setWheelMotion.mutate({
      cameraId,
      roi: checked ? DEFAULT_ROI : null,
      threshold,
      avgSpeedMps,
    });
  }

  // ── Commit slider values on pointer-up ───────────────────────────────────
  function commitThreshold(value: number): void {
    if (!isAdmin || roi === null) return;
    setWheelMotion.mutate({ cameraId, roi, threshold: value, avgSpeedMps });
  }

  function commitAvgSpeed(value: number): void {
    if (!isAdmin || roi === null) return;
    setWheelMotion.mutate({ cameraId, roi, threshold, avgSpeedMps: value });
  }

  // ── ROI drag ──────────────────────────────────────────────────────────────
  const frameRef = useRef<HTMLDivElement | null>(null);

  const [dragState, setDragState] = useState<{
    type: 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 'e' | 's' | 'w';
    startX: number;
    startY: number;
    startRoi: Roi;
  } | null>(null);

  // Optimistic ROI during drag — committed on pointer-up.
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
    setWheelMotion.mutate({ cameraId, roi: committed, threshold, avgSpeedMps });
  }, [dragState, liveRoi, cameraId, threshold, avgSpeedMps, setWheelMotion]);

  // ── Sessions panel ────────────────────────────────────────────────────────
  function handleSessionsToggle(): void {
    if (!sessionsOpen) {
      setSessionsEnabled(true);
      void sessionsQuery.refetch();
    }
    setSessionsOpen((v) => !v);
  }

  function handleSessionsRefresh(): void {
    void sessionsQuery.refetch();
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
        aria-controls={`wheel-motion-body-${cameraId}`}
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
          Wheel motion
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
          id={`wheel-motion-body-${cameraId}`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
            padding: '16px',
            background: 'var(--surface)',
          }}
        >
          {configQuery.isLoading && <p style={{ margin: 0, color: 'var(--text-muted)' }}>Loading…</p>}

          {!configQuery.isLoading && (
            <>
              {/* ---- Enable toggle ---- */}
              <FieldRow>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    cursor: isAdmin ? 'pointer' : 'default',
                    opacity: setWheelMotion.isLoading ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={!isAdmin || setWheelMotion.isLoading}
                    onChange={(e) => handleEnableToggle(e.target.checked)}
                    style={{ width: 22, height: 22, marginTop: 1, flexShrink: 0 }}
                  />
                  <span>
                    <span style={{ fontWeight: 600 }}>Track wheel running</span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 13,
                        opacity: 0.65,
                        fontWeight: 400,
                        marginTop: 2,
                      }}
                    >
                      Measures motion energy inside the ROI to detect when Remy is running.
                      Distance is computed from session duration and the average speed below.
                    </span>
                  </span>
                </label>
              </FieldRow>

              {/* ---- ROI picker + live energy meter — only when enabled ---- */}
              {enabled && displayRoi !== null && (
                <>
                  {/* Live frame with ROI overlay */}
                  {liveSrc && (
                    <FieldRow>
                      <span className="hc-label">Detection area</span>
                      <p style={{ margin: '0 0 6px', color: 'var(--text-muted)', fontSize: 13 }}>
                        Drag the box to cover the wheel. Drag handles on the edges and corners to resize.
                      </p>
                      <div
                        ref={frameRef}
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
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                        />

                        {/* ROI rectangle overlay */}
                        <div
                          aria-hidden
                          data-testid="wheel-motion-roi-overlay"
                          style={{
                            position: 'absolute',
                            left: `${displayRoi.x}%`,
                            top: `${displayRoi.y}%`,
                            width: `${displayRoi.w}%`,
                            height: `${displayRoi.h}%`,
                            border: '2px solid #a78bfa',
                            background: 'color-mix(in srgb, #a78bfa 15%, transparent)',
                            boxSizing: 'border-box',
                            cursor: isAdmin ? 'grab' : 'default',
                          }}
                          onPointerDown={(e) => onRoiPointerDown(e, 'move')}
                        >
                          {/* Label */}
                          <span
                            style={{
                              position: 'absolute',
                              top: 3,
                              left: 6,
                              fontSize: 10,
                              fontWeight: 700,
                              color: '#a78bfa',
                              letterSpacing: '0.04em',
                              textTransform: 'uppercase',
                              textShadow: '0 1px 3px rgba(0,0,0,0.9)',
                              whiteSpace: 'nowrap',
                              pointerEvents: 'none',
                            }}
                          >
                            wheel ROI
                          </span>

                          {/* Corner handles */}
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
                          ROI: x={displayRoi.x}% y={displayRoi.y}% w={displayRoi.w}% h={displayRoi.h}%
                        </small>
                      )}
                    </FieldRow>
                  )}

                  {!liveSrc && (
                    <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
                      No live stream configured for this camera — add a stream source to enable the ROI picker.
                    </p>
                  )}

                  {/* Live energy meter */}
                  <FieldRow>
                    <span className="hc-label">Live motion energy</span>
                    <EnergyMeter value={currentEnergy} threshold={threshold} />
                    <small style={{ color: 'var(--text-muted)' }}>
                      Current: <strong>{Math.round(currentEnergy)}</strong> / 255.
                      Purple line marks your threshold. Remy running should push well above it.
                    </small>
                  </FieldRow>

                  {/* Threshold slider */}
                  {isAdmin && (
                    <FieldRow>
                      <label className="hc-label" htmlFor={`wheel-threshold-${cameraId}`}>
                        Motion threshold — {threshold.toFixed(1)}
                      </label>
                      <input
                        id={`wheel-threshold-${cameraId}`}
                        type="range"
                        min={0}
                        max={50}
                        step={0.5}
                        value={threshold}
                        disabled={roi === null}
                        onChange={(e) => setLocalThreshold(parseFloat(e.target.value))}
                        onPointerUp={(e) =>
                          commitThreshold(parseFloat((e.target as HTMLInputElement).value))
                        }
                        style={{ width: '100%' }}
                      />
                      <small style={{ color: 'var(--text-muted)' }}>
                        Set between the idle baseline (no motion) and the peak when running.
                        Lower = more sensitive; higher = fewer false positives.
                      </small>
                    </FieldRow>
                  )}

                  {/* Avg-speed slider */}
                  {isAdmin && (
                    <FieldRow>
                      <label className="hc-label" htmlFor={`wheel-speed-${cameraId}`}>
                        Average speed — {avgSpeedMps.toFixed(1)} m/s
                      </label>
                      <input
                        id={`wheel-speed-${cameraId}`}
                        type="range"
                        min={0.1}
                        max={3.0}
                        step={0.1}
                        value={avgSpeedMps}
                        disabled={roi === null}
                        onChange={(e) => setLocalAvgSpeed(parseFloat(e.target.value))}
                        onPointerUp={(e) =>
                          commitAvgSpeed(parseFloat((e.target as HTMLInputElement).value))
                        }
                        style={{ width: '100%' }}
                      />
                      <small style={{ color: 'var(--text-muted)' }}>
                        {speedLabel(avgSpeedMps)}
                      </small>
                    </FieldRow>
                  )}
                </>
              )}

              {/* Mutation error */}
              {setWheelMotion.error && (
                <p role="alert" style={{ margin: 0, color: 'var(--danger)' }}>
                  {setWheelMotion.error.message}
                </p>
              )}

              {/* ---- Recent sessions ---- */}
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
                  aria-controls={`wheel-sessions-${cameraId}`}
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
                    id={`wheel-sessions-${cameraId}`}
                    style={{ padding: '10px 12px', background: 'var(--surface)' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <small style={{ color: 'var(--text-muted)' }}>
                        Last 10 completed wheel-running sessions — most recent first.
                      </small>
                      <button
                        type="button"
                        className="hc-btn hc-btn-ghost"
                        onClick={handleSessionsRefresh}
                        disabled={sessionsQuery.isFetching}
                        aria-label="Refresh sessions"
                        style={{ minHeight: 32, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        <RefreshCw
                          aria-hidden
                          size={13}
                          style={{
                            animation: sessionsQuery.isFetching ? 'spin 1s linear infinite' : undefined,
                          }}
                        />
                        Refresh
                      </button>
                    </div>

                    {sessionsQuery.isLoading && (
                      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>
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
                      <p role="alert" style={{ margin: 0, color: 'var(--danger)', fontSize: 13 }}>
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
// EnergyMeter
// ---------------------------------------------------------------------------

interface EnergyMeterProps {
  value: number;
  threshold: number;
}

function EnergyMeter({ value, threshold }: EnergyMeterProps): JSX.Element {
  const valuePct = Math.min(100, (value / 255) * 100);
  const thresholdPct = Math.min(100, (threshold / 255) * 100);
  const isAbove = value >= threshold;

  return (
    <div
      role="meter"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={255}
      aria-label={`Motion energy: ${Math.round(value)} of 255`}
      style={{
        position: 'relative',
        height: 20,
        background: 'var(--surface-raised)',
        borderRadius: 6,
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      {/* Fill bar */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${valuePct}%`,
          background: isAbove
            ? 'color-mix(in srgb, #a78bfa 80%, #7c3aed)'
            : 'color-mix(in srgb, var(--text-muted) 50%, transparent)',
          borderRadius: 5,
          transition: 'width 0.15s ease-out, background 0.15s',
        }}
      />
      {/* Threshold marker — rendered outside overflow:hidden, so position is on wrapper */}
      <div
        aria-hidden
        data-testid="energy-threshold-marker"
        style={{
          position: 'absolute',
          left: `${thresholdPct}%`,
          top: 0,
          bottom: 0,
          width: 2,
          background: '#a78bfa',
          transform: 'translateX(-50%)',
          zIndex: 1,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionsTable
// ---------------------------------------------------------------------------

function SessionsTable({ sessions }: { sessions: RecentSession[] }): JSX.Element {
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
            <th style={{ padding: '4px 8px', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Started</th>
            <th style={{ padding: '4px 8px', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Duration</th>
            <th style={{ padding: '4px 8px', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Peak</th>
            <th style={{ padding: '4px 8px', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Mean</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s, i) => (
            <tr
              key={s.startedAt}
              style={{
                borderBottom: i < sessions.length - 1 ? '1px solid var(--border)' : undefined,
                background: i % 2 === 0 ? 'transparent' : 'var(--surface-raised)',
              }}
            >
              <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{formatRelative(s.startedAt)}</td>
              <td style={{ padding: '5px 8px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{formatDuration(s.durationMs)}</td>
              <td style={{ padding: '5px 8px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{Math.round(s.peakEnergy)}</td>
              <td style={{ padding: '5px 8px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{Math.round(s.meanEnergy)}</td>
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
  n:  { top: -5, left: '50%', transform: 'translateX(-50%)', cursor: 'n-resize' },
  s:  { bottom: -5, left: '50%', transform: 'translateX(-50%)', cursor: 's-resize' },
  w:  { top: '50%', left: -5, transform: 'translateY(-50%)', cursor: 'w-resize' },
  e:  { top: '50%', right: -5, transform: 'translateY(-50%)', cursor: 'e-resize' },
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
        background: '#a78bfa',
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
  );
}
