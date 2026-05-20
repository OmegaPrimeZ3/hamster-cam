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

import { useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { trpc } from '../trpc';
import type { DistanceUnit } from '../lib/trpc-extensions';

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export interface WheelConfig {
  wheel_mark_enabled: boolean;
  wheel_diameter_mm: number;
  wheel_band_y_pct: number;
  wheel_band_height_pct: number;
  wheel_threshold_pct: number;
}

export const WHEEL_CONFIG_DEFAULTS: WheelConfig = {
  wheel_mark_enabled: false,
  wheel_diameter_mm: 152,
  wheel_band_y_pct: 50,
  wheel_band_height_pct: 10,
  wheel_threshold_pct: 50,
};

export interface WheelOdometerSectionProps {
  cameraId: number;
  config: WheelConfig;
  onChange: (next: WheelConfig) => void;
  distanceUnit?: DistanceUnit;
}

// -----------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------

export function WheelOdometerSection({
  cameraId,
  config,
  onChange,
}: WheelOdometerSectionProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const testMutation = trpc.cameras.testWheelDetection.useMutation();

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
              passes across the line below.
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

          {/* Band Y position */}
          <FieldRow>
            <label className="hc-label" htmlFor="wheel-band-y">
              Detection band Y position — {config.wheel_band_y_pct}%
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

          {/* Band height */}
          <FieldRow>
            <label className="hc-label" htmlFor="wheel-band-height">
              Detection band height — {config.wheel_band_height_pct}%
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
        </div>
      )}
    </div>
  );
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
