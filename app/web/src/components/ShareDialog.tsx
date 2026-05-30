// app/web/src/components/ShareDialog.tsx
//
// "Send a clip" modal opened from a diary entry. Lists the admin-managed
// recipient allowlist; tap a pill → share.send mutates; we poll share.status
// until queued → sent | failed.

import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { trpc, RouterOutputs } from '../trpc';

type Entry = RouterOutputs['activity']['today'][number];

export interface ShareDialogProps {
  entry: Entry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareDialog({ entry, open, onOpenChange }: ShareDialogProps): JSX.Element {
  const recipients = trpc.recipients.list.useQuery(undefined, { enabled: open });
  const sendMut = trpc.share.send.useMutation();
  const [pendingId, setPendingId] = useState<number | null>(null);

  const status = trpc.share.status.useQuery(
    { id: pendingId ?? 0 },
    {
      enabled: pendingId != null,
      // Stop polling once a terminal state is reached (sent or failed).
      // While still queued, poll at 1500ms. The refetchInterval callback
      // receives the last data, returning false stops the interval.
      refetchInterval: (data) => {
        if (data?.status === 'sent' || data?.status === 'failed') return false;
        return 1500;
      },
    },
  );

  // Keep a ref to the latest reset fn so the effect below never needs to list
  // sendMut in its deps (sendMut is a new object on every render).
  const sendMutResetRef = useRef(sendMut.reset);
  sendMutResetRef.current = sendMut.reset;
  useEffect(() => {
    if (!open) {
      setPendingId(null);
      sendMutResetRef.current();
    }
  }, [open]);

  const lastStatus = status.data;
  const closeable = !sendMut.isLoading && !(pendingId != null && lastStatus?.status === 'queued');

  return (
    <Dialog.Root open={open} onOpenChange={(v) => closeable && onOpenChange(v)}>
      <Dialog.Portal>
        <Dialog.Overlay style={overlayStyle} />
        <Dialog.Content
          style={contentStyle}
          aria-describedby="share-help"
        >
          <Dialog.Title className="display" style={{ marginTop: 0 }}>Send a clip</Dialog.Title>
          <p id="share-help" style={{ color: 'var(--text-muted)', marginTop: 0 }}>
            Pick someone from the list. They'll get a video by email.
          </p>

          {recipients.isLoading && <p>Loading recipients…</p>}
          {recipients.data && recipients.data.length === 0 && (
            <p>No recipients yet. A grown-up can add one in Settings → Sharing.</p>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {(recipients.data ?? []).map((r) => (
              <button
                key={r.id}
                type="button"
                className="hc-btn"
                disabled={sendMut.isLoading || pendingId != null}
                onClick={() =>
                  sendMut.mutate(
                    { diary_entry_id: entry.id, recipient_id: r.id },
                    {
                      onSuccess: (row) => setPendingId(row.id),
                    },
                  )
                }
              >
                💌 {r.display_name}
              </button>
            ))}
          </div>

          {sendMut.error && (
            <p role="alert" style={{ color: 'var(--danger)', marginTop: 12 }}>
              {sendMut.error.message}
            </p>
          )}

          {pendingId != null && (
            <p style={{ marginTop: 12 }} role="status" aria-live="polite">
              {lastStatus?.status === 'sent' && '✅ Sent!'}
              {lastStatus?.status === 'failed' && `❌ ${lastStatus.error ?? 'Failed.'}`}
              {(!lastStatus || lastStatus.status === 'queued') && '⏳ Sending…'}
            </p>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <Dialog.Close asChild>
              <button type="button" className="hc-btn" disabled={!closeable}>Close</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  zIndex: 60,
};

const contentStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(420px, calc(100vw - 24px))',
  padding: 22,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  color: 'var(--text)',
  zIndex: 61,
  boxShadow: '0 18px 36px rgba(0,0,0,0.18)',
};
