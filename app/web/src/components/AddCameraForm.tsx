// app/web/src/components/AddCameraForm.tsx
//
// Add or edit a camera. The stream is now configured via a go2rtc stream name
// (live_src), NOT a raw RTSP URL. The Discover button populates a dropdown
// from cameras.discover; the user can also type a name manually as a fallback.
//
// When 'wheel' is in the zones array, a WheelOdometerSection is rendered
// below the zones picker — its fields travel through the same save mutation.

import { useEffect, useState } from 'react';
import { trpc, RouterOutputs } from '../trpc';
import { ZONE_ACTIVITIES, activityStyle, zoneLabel } from '../lib/activity-style';
import {
  WheelOdometerSection,
  WHEEL_CONFIG_DEFAULTS,
  type WheelConfig,
} from './WheelOdometerSection';

type CameraDTO = RouterOutputs['cameras']['list'][number];

/** go2rtc stream name: alphanumeric + underscores/hyphens, no slashes or spaces. */
const LIVE_SRC_RE = /^[a-zA-Z0-9_\-.]+$/;

export interface AddCameraFormProps {
  existing?: CameraDTO;
  onDone: () => void;
}

export function AddCameraForm({ existing, onDone }: AddCameraFormProps): JSX.Element {
  const utils = trpc.useUtils();
  const create = trpc.cameras.create.useMutation({
    onSuccess: async () => {
      await utils.cameras.list.invalidate();
      onDone();
    },
  });
  const update = trpc.cameras.update.useMutation({
    onSuccess: async () => {
      await utils.cameras.list.invalidate();
      onDone();
    },
  });
  const [discoverEnabled, setDiscoverEnabled] = useState(false);
  const discover = trpc.cameras.discover.useQuery(undefined, {
    enabled: discoverEnabled,
    refetchOnWindowFocus: false,
  });
  const testStream = trpc.cameras.testStream.useMutation();

  const [name, setName] = useState(existing?.name ?? '');
  const [emoji, setEmoji] = useState(existing?.emoji ?? '📷');
  // live_src: the go2rtc stream name used by /live/ws?src=<name>
  const [liveSrc, setLiveSrc] = useState(existing?.live_src ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [zones, setZones] = useState<string[]>(existing?.zones ?? []);

  // Wheel odometer config
  const existingExt = existing as (CameraDTO & Partial<WheelConfig>) | undefined;
  const [wheelConfig, setWheelConfig] = useState<WheelConfig>({
    wheel_mark_enabled: existingExt?.wheel_mark_enabled ?? WHEEL_CONFIG_DEFAULTS.wheel_mark_enabled,
    wheel_diameter_mm: existingExt?.wheel_diameter_mm ?? WHEEL_CONFIG_DEFAULTS.wheel_diameter_mm,
    wheel_band_y_pct: existingExt?.wheel_band_y_pct ?? WHEEL_CONFIG_DEFAULTS.wheel_band_y_pct,
    wheel_band_height_pct: existingExt?.wheel_band_height_pct ?? WHEEL_CONFIG_DEFAULTS.wheel_band_height_pct,
    wheel_threshold_pct: existingExt?.wheel_threshold_pct ?? WHEEL_CONFIG_DEFAULTS.wheel_threshold_pct,
  });

  function toggleZone(z: string): void {
    setZones((prev) => (prev.includes(z) ? prev.filter((x) => x !== z) : [...prev, z]));
  }

  // Reset test result when liveSrc changes.
  useEffect(() => {
    testStream.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSrc]);

  const liveSrcValue = liveSrc.trim();
  const liveSrcOk = liveSrcValue === '' || LIVE_SRC_RE.test(liveSrcValue);
  const liveSrcSet = liveSrcValue.length > 0 && liveSrcOk;
  const formOk = name.trim().length > 0;
  const submitting = create.isLoading || update.isLoading;

  function submit(): void {
    if (!formOk) return;
    const commonFields = {
      name: name.trim(),
      emoji,
      enabled,
      zones,
      // live_src: empty string → send null to clear; otherwise send the value.
      live_src: liveSrcValue.length > 0 ? liveSrcValue : null,
    };

    if (existing) {
      const payload: unknown = {
        id: existing.id,
        ...commonFields,
        stream_url: existing.stream_url ?? '',
        ...(zones.includes('wheel') ? wheelConfig : {}),
      };
      (update.mutate as (input: unknown) => void)(payload);
    } else {
      create.mutate({
        name: commonFields.name,
        emoji: commonFields.emoji,
        live_src: commonFields.live_src,
        enabled: commonFields.enabled,
        zones: commonFields.zones,
      });
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <div>
        <label className="hc-label" htmlFor="cam-name">Name</label>
        <input
          id="cam-name"
          className="hc-input"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>

      <div>
        <label className="hc-label" htmlFor="cam-emoji">Emoji</label>
        <input
          id="cam-emoji"
          className="hc-input"
          value={emoji}
          maxLength={8}
          onChange={(e) => setEmoji(e.target.value)}
        />
      </div>

      <div>
        <label className="hc-label" htmlFor="cam-live-src">
          go2rtc stream name
        </label>
        <p style={{ margin: '0 0 6px', color: 'var(--text-muted)', fontSize: 12 }}>
          The stream name configured in Frigate / go2rtc (e.g.{' '}
          <code>hamster_cam_1</code>). Use <strong>Discover</strong> to pick from
          detected cameras, or type it manually. Leave blank to skip live video.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="cam-live-src"
            className="hc-input"
            value={liveSrc}
            onChange={(e) => setLiveSrc(e.target.value)}
            placeholder="hamster_cam_1"
            aria-invalid={!liveSrcOk && liveSrc.length > 0}
            style={{ flex: 1 }}
            list="cam-live-src-datalist"
          />
          {discover.data && discover.data.length > 0 && (
            <datalist id="cam-live-src-datalist">
              {discover.data.map((d) => (
                <option key={d.live_src} value={d.live_src}>{d.name}</option>
              ))}
            </datalist>
          )}
        </div>
        {!liveSrcOk && liveSrc.length > 0 && (
          <small style={{ color: 'var(--danger)' }}>
            Use only letters, numbers, underscores, hyphens, and dots — no spaces or slashes.
          </small>
        )}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      <div>
        <span className="hc-label">Zones</span>
        <p style={{ margin: '0 0 8px', color: 'var(--text-muted)', fontSize: 12 }}>
          Tick the zones you&rsquo;ve drawn for this camera in Frigate. They power the diary and scoreboard.
        </p>
        <div role="group" aria-label="Zones" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ZONE_ACTIVITIES.map((z) => {
            const selected = zones.includes(z);
            const { accent, badgeEmoji } = activityStyle(z);
            return (
              <button
                key={z}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleZone(z)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 36,
                  padding: '4px 12px',
                  borderRadius: 999,
                  border: '1px solid',
                  borderColor: selected ? 'transparent' : 'var(--border)',
                  background: selected ? accent : 'var(--surface)',
                  color: selected ? '#fff' : 'var(--text)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  lineHeight: 1.2,
                }}
              >
                <span aria-hidden>{badgeEmoji}</span> {zoneLabel(z)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Wheel odometer subsection — only shown when 'wheel' zone is active */}
      {zones.includes('wheel') && existing && (
        <WheelOdometerSection
          cameraId={existing.id}
          config={wheelConfig}
          onChange={setWheelConfig}
          liveSrc={existing.live_src}
        />
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="submit" className="hc-btn hc-btn-primary" disabled={!formOk || submitting}>
          {submitting ? 'Saving…' : existing ? 'Save changes' : 'Add camera'}
        </button>
        <button
          type="button"
          className="hc-btn"
          onClick={() => {
            setDiscoverEnabled(true);
            void discover.refetch();
          }}
          disabled={discover.isFetching}
        >
          {discover.isFetching ? 'Discovering…' : 'Discover'}
        </button>
        <button
          type="button"
          className="hc-btn"
          onClick={() => {
            if (!liveSrcSet) return;
            testStream.mutate({ live_src: liveSrcValue });
          }}
          disabled={!liveSrcSet || testStream.isLoading}
        >
          {testStream.isLoading ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className="hc-btn hc-btn-ghost" onClick={onDone} disabled={submitting}>
          Cancel
        </button>
      </div>

      {/* Discovery results — tap a chip to fill the live_src field */}
      {discover.data && discover.data.length > 0 && (
        <div className="hc-card-raised" style={{ padding: 10 }}>
          <p style={{ margin: '0 0 6px', fontSize: 13 }}>Detected streams — tap to select:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {discover.data.map((d) => (
              <button
                key={d.live_src}
                type="button"
                className="hc-btn"
                onClick={() => {
                  setName((prev) => (prev.length > 0 ? prev : d.name));
                  setLiveSrc(d.live_src);
                }}
              >
                {d.name}{' '}
                <code style={{ fontSize: 11, opacity: 0.75 }}>{d.live_src}</code>
              </button>
            ))}
          </div>
        </div>
      )}
      {discover.data && discover.data.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>No streams found via Frigate.</p>
      )}
      {discover.isError && (
        <p style={{ color: 'var(--danger)' }}>
          Discover failed — is Frigate reachable?
        </p>
      )}

      {testStream.data && (
        <p style={{ color: testStream.data.ok ? 'var(--success)' : 'var(--danger)' }}>
          {testStream.data.ok
            ? '✅ Stream name is known to go2rtc.'
            : '❌ Stream name not found in go2rtc. Check Frigate config.'}
        </p>
      )}
      {testStream.error && (
        <p style={{ color: 'var(--danger)' }}>{testStream.error.message}</p>
      )}

      {(create.error || update.error) && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {(create.error ?? update.error)?.message}
        </p>
      )}
    </form>
  );
}
