// app/web/src/components/AddCameraForm.tsx
//
// Add or edit a camera. Stream URL must look like `rtsp://...` or http(s).
// Discover + Test buttons hit cameras.discover and cameras.testStream.

import { useEffect, useState } from 'react';
import { trpc, RouterOutputs } from '../trpc';

type CameraDTO = RouterOutputs['cameras']['list'][number];

const STREAM_RE = /^(rtsp|rtsps|http|https):\/\//i;

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
  const [url, setUrl] = useState(existing?.stream_url ?? '');
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    setShowPreview(false);
  }, [url]);

  const urlOk = STREAM_RE.test(url);
  const formOk = name.trim().length > 0 && urlOk;
  const submitting = create.isLoading || update.isLoading;

  function submit(): void {
    if (!formOk) return;
    if (existing) {
      update.mutate({
        id: existing.id,
        name: name.trim(),
        emoji,
        stream_url: url.trim(),
        enabled,
      });
    } else {
      create.mutate({
        name: name.trim(),
        emoji,
        stream_url: url.trim(),
        enabled,
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
        <label className="hc-label" htmlFor="cam-url">Stream URL</label>
        <input
          id="cam-url"
          className="hc-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="rtsp://192.168.1.50:8554/wheel"
          required
          aria-invalid={!urlOk && url.length > 0}
        />
        {!urlOk && url.length > 0 && (
          <small style={{ color: 'var(--danger)' }}>Use rtsp://… or http(s)://…</small>
        )}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

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
            if (!urlOk) return;
            testStream.mutate({ stream_url: url.trim() }, { onSuccess: () => setShowPreview(true) });
          }}
          disabled={!urlOk || testStream.isLoading}
        >
          {testStream.isLoading ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className="hc-btn hc-btn-ghost" onClick={onDone} disabled={submitting}>
          Cancel
        </button>
      </div>

      {discover.data && discover.data.length > 0 && (
        <div className="hc-card-raised" style={{ padding: 10 }}>
          <p style={{ margin: '0 0 6px' }}>Detected cameras:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {discover.data.map((d) => (
              <button
                key={d.stream_url}
                type="button"
                className="hc-btn"
                onClick={() => {
                  setName(d.name);
                  setUrl(d.stream_url);
                }}
              >
                {d.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {discover.data && discover.data.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>No cameras found by Frigate.</p>
      )}

      {testStream.data && (
        <p style={{ color: testStream.data.ok ? 'var(--success)' : 'var(--danger)' }}>
          {testStream.data.ok ? '✅ Reachable.' : `❌ Probe failed${testStream.data.status ? ` (status ${testStream.data.status})` : ''}.`}
        </p>
      )}
      {testStream.error && (
        <p style={{ color: 'var(--danger)' }}>{testStream.error.message}</p>
      )}

      {showPreview && testStream.data?.ok && (
        <video
          src={url}
          controls
          muted
          playsInline
          style={{ width: '100%', maxHeight: 220, background: '#000', borderRadius: 10 }}
        />
      )}

      {(create.error || update.error) && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {(create.error ?? update.error)?.message}
        </p>
      )}
    </form>
  );
}
