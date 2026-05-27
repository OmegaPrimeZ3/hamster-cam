// app/web/src/components/WheelOdometerSection.tsx
//
// Collapsible "Wheel odometer" section rendered inside AddCameraForm (and the
// per-camera edit panel in CameraSettings) when the camera's zones array
// includes 'wheel'.
//
// The section controls are part of the parent form's save flow — there is no
// separate save button here. The parent collects these values via the
// `onChange` callback and includes them in the same cameras.update mutation it
// already fires.

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Loader2, Eye, EyeOff } from 'lucide-react';
import { trpc } from '../trpc';
import { LiveStream } from './LiveStream';
import type { DistanceUnit } from '../lib/trpc-extensions';
import { formatMeters } from '../lib/distance';

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export interface WheelConfig {
  wheel_mark_enabled: boolean;
  wheel_diameter_mm: number;
  wheel_band_x_pct: number;
  wheel_band_width_pct: number;
  wheel_band_y_pct: number;
  wheel_band_height_pct: number;
  wheel_threshold_pct: number;
}

export const WHEEL_CONFIG_DEFAULTS: WheelConfig = {
  wheel_mark_enabled: false,
  wheel_diameter_mm: 152,
  wheel_band_x_pct: 0,
  wheel_band_width_pct: 100,
  wheel_band_y_pct: 50,
  wheel_band_height_pct: 10,
  wheel_threshold_pct: 50,
};

export interface WheelOdometerSectionProps {
  cameraId: number;
  config: WheelConfig;
  onChange: (next: WheelConfig) => void;
  distanceUnit?: DistanceUnit;
  /**
   * go2rtc stream name for this camera. When provided, a "Targeting feed"
   * toggle is available so the user can overlay the detection band on the live
   * stream while dragging the sliders. Absent (or null) for brand-new cameras
   * that have not been saved yet — in that case the button is hidden.
   */
  liveSrc?: string | null;
}

// -----------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------

// Duration options for the rotation test (seconds).
const ROTATION_DURATION_OPTIONS = [10, 15, 30] as const;
type RotationDurationS = (typeof ROTATION_DURATION_OPTIONS)[number];

export function WheelOdometerSection({
  cameraId,
  config,
  onChange,
  distanceUnit = 'mi',
  liveSrc,
}: WheelOdometerSectionProps): JSX.Element {
  // Change A: expand by default.
  const [open, setOpen] = useState(true);
  const [targetingOpen, setTargetingOpen] = useState(false);
  const testMutation = trpc.cameras.testWheelDetection.useMutation();

  // ---- Rotation test state ----
  const rotationMutation = trpc.cameras.testWheelRotation.useMutation();
  const [rotationDurationS, setRotationDurationS] = useState<RotationDurationS>(15);
  const [elapsed, setElapsed] = useState(0);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start / clear elapsed ticker when the rotation mutation state changes.
  useEffect(() => {
    if (rotationMutation.isLoading) {
      setElapsed(0);
      elapsedRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } else {
      if (elapsedRef.current !== null) {
        clearInterval(elapsedRef.current);
        elapsedRef.current = null;
      }
    }
    return () => {
      if (elapsedRef.current !== null) {
        clearInterval(elapsedRef.current);
        elapsedRef.current = null;
      }
    };
  }, [rotationMutation.isLoading]);

  function set<K extends keyof WheelConfig>(key: K, value: WheelConfig[K]): void {
    onChange({ ...config, [key]: value });
  }

  const result = testMutation.data;
  const tapeVisible =
    result != null && result.error == null
      ? result.darkPixelRatio * 100 >= result.thresholdPct
      : null;
  const darkPct =
    result != null ? Math.round(result.darkPixelRatio * 100) : null;

  // Only show the targeting feed toggle when a saved stream source exists.
  const canTarget = liveSrc != null && liveSrc.length > 0;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
        marginTop: 4,
      }}
    >
      {/* ---- Collapsible header ---- */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="wheel-odometer-body"
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
        }}
      >
        <span>🎡 Wheel odometer</span>
        {open ? (
          <ChevronUp aria-hidden size={16} />
        ) : (
          <ChevronDown aria-hidden size={16} />
        )}
      </button>

      {/* ---- Body ---- */}
      {open && (
        <div
          id="wheel-odometer-body"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            padding: '14px 16px',
            background: 'var(--surface)',
          }}
        >
          {/* Enable toggle */}
          <FieldRow>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={config.wheel_mark_enabled}
                onChange={(e) => set('wheel_mark_enabled', e.target.checked)}
                style={{ width: 20, height: 20 }}
              />
              <span style={{ fontWeight: 600 }}>Enable wheel odometer</span>
            </label>
            <HelpText>
              Stick a piece of dark tape on the wheel rim. We&rsquo;ll count how often it
              passes through the detection box below. If the camera sees the wheel at an
              angle, drag a small box over the one spot on the rim where the tape passes
              &mdash; ideally near the left or right edge of the wheel, where the tape
              crosses just once per turn.
            </HelpText>
          </FieldRow>

          {/* Wheel diameter */}
          <FieldRow>
            <label className="hc-label" htmlFor="wheel-diameter">
              Wheel diameter (mm)
            </label>
            <input
              id="wheel-diameter"
              type="number"
              min={30}
              max={500}
              step={1}
              value={config.wheel_diameter_mm}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (Number.isFinite(v)) set('wheel_diameter_mm', v);
              }}
              className="hc-input"
              style={{ width: 100 }}
            />
          </FieldRow>

          {/* Box X position */}
          <FieldRow>
            <label className="hc-label" htmlFor="wheel-band-x">
              Detection box X position — {config.wheel_band_x_pct}%
            </label>
            <input
              id="wheel-band-x"
              type="range"
              min={0}
              max={100}
              step={1}
              value={config.wheel_band_x_pct}
              onChange={(e) => set('wheel_band_x_pct', parseInt(e.target.value, 10))}
              style={{ width: '100%' }}
            />
          </FieldRow>

          {/* Box width */}
          <FieldRow>
            <label className="hc-label" htmlFor="wheel-band-width">
              Detection box width — {config.wheel_band_width_pct}%
            </label>
            <input
              id="wheel-band-width"
              type="range"
              min={1}
              max={100}
              step={1}
              value={config.wheel_band_width_pct}
              onChange={(e) =>
                set('wheel_band_width_pct', parseInt(e.target.value, 10))
              }
              style={{ width: '100%' }}
            />
          </FieldRow>

          {/* Box Y position */}
          <FieldRow>
            <label className="hc-label" htmlFor="wheel-band-y">
              Detection box Y position — {config.wheel_band_y_pct}%
            </label>
            <input
              id="wheel-band-y"
              type="range"
              min={0}
              max={100}
              step={1}
              value={config.wheel_band_y_pct}
              onChange={(e) => set('wheel_band_y_pct', parseInt(e.target.value, 10))}
              style={{ width: '100%' }}
            />
          </FieldRow>

          {/* Box height */}
          <FieldRow>
            <label className="hc-label" htmlFor="wheel-band-height">
              Detection box height — {config.wheel_band_height_pct}%
            </label>
            <input
              id="wheel-band-height"
              type="range"
              min={1}
              max={50}
              step={1}
              value={config.wheel_band_height_pct}
              onChange={(e) =>
                set('wheel_band_height_pct', parseInt(e.target.value, 10))
              }
              style={{ width: '100%' }}
            />
          </FieldRow>

          {/* Dark threshold */}
          <FieldRow>
            <label className="hc-label" htmlFor="wheel-threshold">
              Dark threshold — {config.wheel_threshold_pct}%
            </label>
            <input
              id="wheel-threshold"
              type="range"
              min={10}
              max={90}
              step={1}
              value={config.wheel_threshold_pct}
              onChange={(e) =>
                set('wheel_threshold_pct', parseInt(e.target.value, 10))
              }
              style={{ width: '100%' }}
            />
            <HelpText>
              Lower if the tape isn&rsquo;t being detected; higher if shadows are being
              mistaken for the tape.
            </HelpText>
          </FieldRow>

          {/* ---- Targeting feed toggle ---- */}
          {canTarget && (
            <FieldRow>
              <button
                type="button"
                className="hc-btn"
                onClick={() => setTargetingOpen((v) => !v)}
                aria-expanded={targetingOpen}
                aria-controls="wheel-targeting-feed"
                style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {targetingOpen ? (
                  <>
                    <EyeOff aria-hidden size={14} />
                    Hide targeting feed
                  </>
                ) : (
                  <>
                    <Eye aria-hidden size={14} />
                    Targeting feed
                  </>
                )}
              </button>
              <HelpText>
                Watch the live stream with the detection box overlaid. Drag the
                sliders above to position it over the tape spot on the wheel. For
                angled cameras, make the box small and place it where the tape
                crosses once per spin.
              </HelpText>
            </FieldRow>
          )}

          {/* ---- Live targeting feed with band overlay ---- */}
          {canTarget && targetingOpen && (
            <div
              id="wheel-targeting-feed"
              style={{
                position: 'relative',
                width: '100%',
                // 16:9 aspect ratio container; the LiveStream fills it.
                aspectRatio: '16 / 9',
                borderRadius: 10,
                overflow: 'hidden',
                background: '#000',
                border: '1px solid var(--border)',
              }}
            >
              <LiveStream
                liveSrc={liveSrc}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              />

              {/* Detection box overlay — matches backend crop geometry:
                  crop=iw*W/100:ih*H/100:iw*X/100:ih*Y/100 */}
              <div
                aria-hidden
                data-testid="targeting-band-overlay"
                style={{
                  position: 'absolute',
                  left: `${config.wheel_band_x_pct}%`,
                  width: `${config.wheel_band_width_pct}%`,
                  top: `${config.wheel_band_y_pct}%`,
                  height: `${config.wheel_band_height_pct}%`,
                  background: 'color-mix(in srgb, var(--accent, #f59e0b) 28%, transparent)',
                  border: '2px solid var(--accent, #f59e0b)',
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                }}
              >
                {/* Crosshair at the centre of the box */}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: '50%',
                    height: 1,
                    background: 'var(--accent, #f59e0b)',
                    opacity: 0.7,
                    transform: 'translateY(-50%)',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: '50%',
                    width: 1,
                    background: 'var(--accent, #f59e0b)',
                    opacity: 0.7,
                    transform: 'translateX(-50%)',
                  }}
                />
                {/* Label */}
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--accent, #f59e0b)',
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  detection box
                </span>
              </div>
            </div>
          )}

          {/* Test detection */}
          <FieldRow>
            <button
              type="button"
              className="hc-btn"
              disabled={testMutation.isLoading}
              onClick={() => {
                testMutation.mutate({ cameraId });
              }}
              style={{ alignSelf: 'flex-start' }}
            >
              {testMutation.isLoading ? (
                <span
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Loader2 aria-hidden size={14} className="spin" />
                  Testing…
                </span>
              ) : (
                'Test detection'
              )}
            </button>

            {/* Result — error path */}
            {result?.error != null && (
              <p role="alert" style={{ color: 'var(--danger)', margin: '6px 0 0' }}>
                {result.error}
              </p>
            )}

            {/* Result — success path */}
            {result != null && result.error == null && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Cropped band image with a red horizontal centre-line */}
                <div style={{ position: 'relative', display: 'inline-block' }}>
                  <img
                    src={`data:image/png;base64,${result.croppedPngBase64}`}
                    alt="Wheel detection band preview"
                    style={{
                      display: 'block',
                      maxWidth: '100%',
                      borderRadius: 8,
                      border: '1px solid var(--border)',
                    }}
                  />
                  {/* Red centre line overlaid at 50% height of the band */}
                  <div
                    aria-hidden
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      top: '50%',
                      height: 2,
                      background: 'red',
                      transform: 'translateY(-50%)',
                      pointerEvents: 'none',
                    }}
                  />
                </div>

                {/* Ratio readout */}
                <p
                  style={{
                    margin: 0,
                    fontWeight: 600,
                    color: tapeVisible ? 'var(--success)' : 'var(--danger)',
                  }}
                >
                  {tapeVisible
                    ? `Currently ${darkPct}% dark — tape visible ✓`
                    : `Only ${darkPct}% dark — adjust the band or threshold`}
                </p>
              </div>
            )}

            {testMutation.error != null && (
              <p role="alert" style={{ color: 'var(--danger)', margin: '6px 0 0' }}>
                {testMutation.error.message}
              </p>
            )}
          </FieldRow>

          {/* ---- Test rotation count ---- */}
          <RotationTestBlock
            durationS={rotationDurationS}
            distanceUnit={distanceUnit}
            isRunning={rotationMutation.isLoading}
            elapsed={elapsed}
            result={rotationMutation.data ?? null}
            error={rotationMutation.error}
            onDurationChange={(d) => setRotationDurationS(d)}
            onRun={() => {
              rotationMutation.reset();
              rotationMutation.mutate({ cameraId, durationS: rotationDurationS });
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RotationTestResultProps (declared early so RotationTestBlockProps can ref it)
// ---------------------------------------------------------------------------

export interface RotationTestResultProps {
  result: {
    rotations: number;
    sampledDurationS: number;
    sampleFps: number;
    framesSampled: number;
    ratioTrace: number[];
    thresholdRatio: number;
    distanceMeters: number;
    diameterMm: number;
  };
  distanceUnit: DistanceUnit;
}

// ---------------------------------------------------------------------------
// RotationTestBlock
// ---------------------------------------------------------------------------

interface RotationTestBlockProps {
  durationS: RotationDurationS;
  distanceUnit: DistanceUnit;
  isRunning: boolean;
  elapsed: number;
  result: RotationTestResultProps['result'] | null;
  error: { message: string } | null;
  onDurationChange: (d: RotationDurationS) => void;
  onRun: () => void;
}

function RotationTestBlock({
  durationS,
  distanceUnit,
  isRunning,
  elapsed,
  result,
  error,
  onDurationChange,
  onRun,
}: RotationTestBlockProps): JSX.Element {
  return (
    <FieldRow>
      {/* Row: button + duration selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="hc-btn"
          disabled={isRunning}
          aria-label={`Test rotation count over ${durationS} seconds`}
          onClick={onRun}
          style={{ alignSelf: 'flex-start', minWidth: 64, minHeight: 44 }}
        >
          {isRunning ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Loader2 aria-hidden size={14} className="spin" />
              {elapsed}s&nbsp;/&nbsp;{durationS}s
            </span>
          ) : (
            'Test rotation count'
          )}
        </button>

        {/* Duration picker */}
        <div
          role="group"
          aria-label="Sample duration"
          style={{ display: 'flex', gap: 4 }}
        >
          {ROTATION_DURATION_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              disabled={isRunning}
              aria-pressed={durationS === d}
              onClick={() => onDurationChange(d)}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: durationS === d ? 'var(--accent, #f59e0b)' : 'var(--surface-raised)',
                color: durationS === d ? '#000' : 'var(--text)',
                fontWeight: durationS === d ? 700 : 400,
                cursor: isRunning ? 'not-allowed' : 'pointer',
                fontSize: 13,
                minHeight: 32,
              }}
            >
              {d}s
            </button>
          ))}
        </div>
      </div>

      {/* In-progress message */}
      {isRunning && (
        <p style={{ margin: '6px 0 0', color: 'var(--text-muted)', fontSize: 13 }} aria-live="polite">
          Watching the wheel for {durationS}s — give it a spin or let {'✨'} run.
        </p>
      )}

      {/* Error state */}
      {error != null && !isRunning && (
        <p role="alert" style={{ color: 'var(--danger)', margin: '6px 0 0' }}>
          {error.message}
        </p>
      )}

      {/* Result state */}
      {result != null && !isRunning && (
        <RotationTestResult result={result} distanceUnit={distanceUnit} />
      )}

      <HelpText>
        Runs a live sample and counts full wheel rotations. Spin the wheel during
        the window. If rotations show 0, check the detection test above to confirm
        the tape is visible.
      </HelpText>
    </FieldRow>
  );
}

// ---------------------------------------------------------------------------
// RotationTestResult + RatioSparkline
// (exported so tests can render them in isolation)
// ---------------------------------------------------------------------------

export function RotationTestResult({ result, distanceUnit }: RotationTestResultProps): JSX.Element {
  const {
    rotations,
    sampledDurationS,
    sampleFps,
    framesSampled,
    ratioTrace,
    thresholdRatio,
    distanceMeters,
  } = result;

  const formattedDistance = formatMeters(distanceMeters, distanceUnit);
  const isZero = rotations === 0;

  return (
    <div
      data-testid="rotation-test-result"
      style={{
        marginTop: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid var(--border)',
        background: 'var(--surface-raised)',
      }}
    >
      {/* Primary readout */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span
          aria-label={`${rotations} rotation${rotations === 1 ? '' : 's'} counted`}
          style={{
            fontFamily: "'Fredoka', sans-serif",
            fontSize: 28,
            fontWeight: 700,
            color: isZero ? 'var(--text-muted)' : 'var(--success, #22c55e)',
            lineHeight: 1,
          }}
        >
          {rotations}
        </span>
        <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--text)' }}>
          rotation{rotations === 1 ? '' : 's'}
        </span>
        {!isZero && (
          <span
            aria-label={`distance ${formattedDistance}`}
            style={{ fontSize: 15, color: 'var(--text-muted)' }}
          >
            &nbsp;&mdash;&nbsp;{formattedDistance}
          </span>
        )}
      </div>

      {/* Small print: frame stats */}
      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
        {framesSampled} frames sampled over {sampledDurationS}s @ {sampleFps.toFixed(1)} fps
      </p>

      {/* Trace visualization */}
      {ratioTrace.length > 0 && (
        <RatioSparkline
          trace={ratioTrace}
          threshold={thresholdRatio}
        />
      )}

      {/* Zero-state explanation */}
      {isZero && (
        <p
          role="status"
          style={{
            margin: 0,
            fontSize: 13,
            color: 'var(--text-muted)',
            lineHeight: 1.5,
          }}
        >
          No rotations detected. The wheel may not have spun during the sample window,
          or the detection box and threshold may need adjustment. Use "Test detection"
          above to confirm the tape is crossing the box cleanly.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RatioSparkline
// ---------------------------------------------------------------------------

export interface RatioSparklineProps {
  /** Dark-pixel ratio per sampled frame, 0..1. */
  trace: number[];
  /** The cutoff 0..1 — drawn as a reference line across the chart. */
  threshold: number;
}

const SPARKLINE_HEIGHT = 48;
const SPARKLINE_BAR_WIDTH = 3;
const SPARKLINE_BAR_GAP = 1;

export function RatioSparkline({ trace, threshold }: RatioSparklineProps): JSX.Element {
  // Cap rendering to keep the element compact even on long samples.
  // Show at most ~120 bars; downsample by averaging buckets if needed.
  const MAX_BARS = 120;
  const samples = downsample(trace, MAX_BARS);

  const svgWidth = samples.length * (SPARKLINE_BAR_WIDTH + SPARKLINE_BAR_GAP);
  const thresholdY = SPARKLINE_HEIGHT * (1 - threshold);

  return (
    <div aria-label="Ratio trace — dark-pixel ratio per sampled frame">
      <p style={{ margin: '0 0 4px', fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.03em', textTransform: 'uppercase' }}>
        Dark-pixel ratio trace (threshold line = {Math.round(threshold * 100)}%)
      </p>
      <svg
        data-testid="ratio-sparkline"
        role="img"
        aria-label={`Sparkline: ${samples.length} data points, threshold at ${Math.round(threshold * 100)}%`}
        width={svgWidth}
        height={SPARKLINE_HEIGHT}
        style={{
          display: 'block',
          maxWidth: '100%',
          borderRadius: 4,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          overflow: 'visible',
        }}
      >
        {/* Bars */}
        {samples.map((ratio, i) => {
          const barH = Math.max(1, Math.round(ratio * SPARKLINE_HEIGHT));
          const x = i * (SPARKLINE_BAR_WIDTH + SPARKLINE_BAR_GAP);
          const y = SPARKLINE_HEIGHT - barH;
          const aboveThreshold = ratio >= threshold;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={SPARKLINE_BAR_WIDTH}
              height={barH}
              fill={aboveThreshold ? 'var(--accent, #f59e0b)' : 'var(--text-muted, #888)'}
              opacity={aboveThreshold ? 0.9 : 0.45}
            />
          );
        })}

        {/* Threshold reference line */}
        <line
          data-testid="sparkline-threshold-line"
          x1={0}
          y1={thresholdY}
          x2={svgWidth}
          y2={thresholdY}
          stroke="var(--danger, #ef4444)"
          strokeWidth={1.5}
          strokeDasharray="4 2"
        />
      </svg>
      <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
        Bars above the red dashed line = tape detected. Each dip/peak crossing the line
        should correspond to one wheel rotation.
      </p>
    </div>
  );
}

/** Average-downsample `arr` to at most `maxLen` buckets. */
export function downsample(arr: number[], maxLen: number): number[] {
  if (arr.length <= maxLen) return arr;
  const bucketSize = arr.length / maxLen;
  const result: number[] = [];
  for (let i = 0; i < maxLen; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let sum = 0;
    for (let j = start; j < end; j++) sum += arr[j] ?? 0;
    result.push(sum / (end - start));
  }
  return result;
}

// -----------------------------------------------------------------------
// Layout helpers
// -----------------------------------------------------------------------

function FieldRow({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
  );
}

function HelpText({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <small style={{ color: 'var(--text-muted)', lineHeight: 1.4 }}>{children}</small>
  );
}
