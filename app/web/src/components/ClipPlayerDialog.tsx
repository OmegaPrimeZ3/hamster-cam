// app/web/src/components/ClipPlayerDialog.tsx
//
// In-app video player for a diary entry clip. Opened from DiaryEntry's
// "View clip" button and from clicking the narrative thumbnail.
//
// Pattern mirrors ShareDialog: Radix dialog shell, same overlay/content
// styles, query gated on `open` so we only hit the server when the user
// actually asks to watch.
//
// clip.get is a QUERY (not a mutation). It resolves or extracts the clip on
// the server side (Frigate extraction can take ~2 s on first call), so we
// show a loading state backed by the thumbnail as a poster image.
//
// Autoplay decision: NO autoPlay. The dialog opens with controls visible; the
// user presses play. This avoids the jarring surprise of sound/motion on open
// and is the safest choice for a kid-facing screen. The <video> is muted by
// default per the "clips are silent/short" contract, but muted is not set
// programmatically since the user may have audio; let the browser decide.

import * as Dialog from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import { TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@hamster-cam/server/trpc';
import { trpc } from '../trpc';
import type { RouterOutputs } from '../trpc';

type Entry = RouterOutputs['activity']['today'][number];
type ClipData = RouterOutputs['clip']['get'];

export interface ClipPlayerDialogProps {
  entry: Entry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog title. Defaults to "Watch clip". */
  title?: string;
}

export function ClipPlayerDialog({ entry, open, onOpenChange, title = 'Watch clip' }: ClipPlayerDialogProps): JSX.Element {
  const clip = trpc.clip.get.useQuery(
    { diary_entry_id: entry.id },
    {
      enabled: open,
      // Do not re-fetch on window focus — the clip URL is stable once extracted.
      refetchOnWindowFocus: false,
      // Never auto-retry for PRECONDITION_FAILED (412) — the clip simply doesn't
      // exist and retrying would just spam the server with doomed requests.
      retry: (failureCount, error) => {
        if (error instanceof TRPCClientError) {
          const code = (error as TRPCClientError<AppRouter>).data?.code;
          if (code === 'PRECONDITION_FAILED') return false;
        }
        return failureCount < 2;
      },
    },
  );

  // Detect 412 PRECONDITION_FAILED specifically so we show a friendly no-clip
  // message instead of a generic error + retry button.
  const isPreconditionFailed =
    clip.isError &&
    clip.error instanceof TRPCClientError &&
    (clip.error as TRPCClientError<AppRouter>).data?.code === 'PRECONDITION_FAILED';

  const petName = entry.pet_name ?? 'your pet';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay style={overlayStyle} />
        <Dialog.Content style={contentStyle} aria-describedby="clip-help">
          <Dialog.Title className="display" style={{ marginTop: 0 }}>
            {title}
          </Dialog.Title>
          <p id="clip-help" style={{ color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
            {petName} on camera
          </p>

          <ClipBody
            isLoading={clip.isLoading}
            isError={clip.isError}
            isPreconditionFailed={isPreconditionFailed}
            errorMessage={clip.error?.message ?? null}
            data={clip.isSuccess ? clip.data : null}
            thumbnailUrl={entry.thumbnail_url}
            onRetry={() => { void clip.refetch(); }}
          />

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <Dialog.Close asChild>
              <button type="button" className="hc-btn">
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Body — three states: loading / error / success
// ---------------------------------------------------------------------------

interface ClipBodyProps {
  isLoading: boolean;
  isError: boolean;
  isPreconditionFailed: boolean;
  errorMessage: string | null;
  data: ClipData | null;
  thumbnailUrl: string | null;
  onRetry: () => void;
}

function ClipBody({
  isLoading,
  isError,
  isPreconditionFailed,
  errorMessage,
  data,
  thumbnailUrl,
  onRetry,
}: ClipBodyProps): JSX.Element {
  if (isLoading) {
    return (
      <div style={videoWrapperStyle}>
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt=""
            aria-hidden
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.35 }}
          />
        ) : null}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            color: '#fff',
          }}
        >
          <Loader2 aria-hidden size={32} style={{ animation: 'spin 1s linear infinite' }} />
          <span style={{ fontSize: 15 }}>Getting the clip ready…</span>
        </div>
      </div>
    );
  }

  if (isError) {
    // 412 PRECONDITION_FAILED: no video exists for this entry — show a gentle
    // kid-friendly message with no retry button (retrying won't help).
    if (isPreconditionFailed) {
      return (
        <div
          style={{
            ...videoWrapperStyle,
            background: 'var(--surface-raised, #1a1a1a)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
          }}
        >
          <span style={{ fontSize: 36 }} aria-hidden>
            🐹
          </span>
          <p
            role="status"
            style={{ color: 'var(--text-muted)', textAlign: 'center', margin: 0, fontSize: 15 }}
          >
            No video for this moment
          </p>
        </div>
      );
    }

    const message = errorMessage ?? 'Could not load the clip right now.';
    return (
      <div
        style={{
          ...videoWrapperStyle,
          background: 'var(--surface-raised, #1a1a1a)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 24,
        }}
      >
        <span style={{ fontSize: 28 }} aria-hidden>
          😿
        </span>
        <p
          role="alert"
          style={{ color: 'var(--text-muted)', textAlign: 'center', margin: 0, fontSize: 14 }}
        >
          {message}
        </p>
        <button
          type="button"
          className="hc-btn"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    );
  }

  // data is non-null when !isLoading && !isError (query succeeded)
  const url = data?.url ?? '';
  return (
    <div style={videoWrapperStyle}>
      <video
        controls
        playsInline
        preload="metadata"
        src={url}
        poster={thumbnailUrl ?? undefined}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  zIndex: 60,
};

const contentStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  // ~2× the old 540px cap; never wider than the viewport minus 32px gutters.
  width: 'min(960px, calc(100vw - 32px))',
  // Never taller than the viewport minus safe-area insets and 32px breathing room.
  maxHeight:
    'calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))',
  overflowY: 'auto',
  padding: 22,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  color: 'var(--text)',
  zIndex: 61,
  boxShadow: '0 18px 36px rgba(0,0,0,0.22)',
};

// 16:9 aspect-ratio container, black bg so the poster/video fills it cleanly.
const videoWrapperStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  aspectRatio: '16 / 9',
  background: '#000',
  borderRadius: 10,
  overflow: 'hidden',
};
