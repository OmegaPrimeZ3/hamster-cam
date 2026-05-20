// app/web/src/components/NotificationSettings.tsx
//
// Web Push subscription management panel. Consumes the notifications.* tRPC
// router (publicKey, subscribe, unsubscribe, preferences.get/set, test).

import { useCallback, useEffect, useState } from 'react';
import { trpc, type RouterOutputs } from '../trpc';
import { urlBase64ToUint8Array, getExistingSubscription } from '../lib/push';

// ---------------------------------------------------------------------------
// Activity list — must match the backend's pushActivitySchema enum.
// ---------------------------------------------------------------------------

const PUSH_ACTIVITIES = [
  'wheel', 'food', 'water', 'bathroom', 'resting', 'tunnel', 'exploring', 'hiding',
] as const;
type PushActivity = (typeof PUSH_ACTIVITIES)[number];

const ACTIVITY_LABELS: Record<PushActivity, string> = {
  wheel:     'Wheel',
  food:      'Food',
  water:     'Water',
  bathroom:  'Bathroom',
  resting:   'Resting',
  tunnel:    'Tunnel',
  exploring: 'Exploring',
  hiding:    'Hiding',
};

type Prefs = RouterOutputs['notifications']['preferences']['get'];

// Minute-of-day → "HH:MM" in local 24h time.
function minuteToTime(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function timeToMinute(t: string): number {
  const [h = '0', m = '0'] = t.split(':');
  return parseInt(h, 10) * 60 + parseInt(m, 10);
}

// ---------------------------------------------------------------------------
// Browser support gate
// ---------------------------------------------------------------------------

function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'PushManager' in window &&
    'serviceWorker' in navigator
  );
}

function isIOSNonStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = ('standalone' in navigator)
    ? (navigator as unknown as { standalone: boolean }).standalone
    : false;
  return ios && !standalone;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function NotificationSettings(): JSX.Element {
  if (!isPushSupported()) {
    return (
      <div
        style={{
          padding: '20px 16px',
          background: 'var(--surface-raised)',
          borderRadius: 14,
          color: 'var(--text-muted)',
          textAlign: 'center',
        }}
      >
        Push notifications are not supported on this browser.
      </div>
    );
  }

  if (isIOSNonStandalone()) {
    return (
      <div
        role="note"
        style={{
          padding: '14px 16px',
          background: 'color-mix(in srgb, #E8A020 12%, var(--surface))',
          border: '1px solid color-mix(in srgb, #E8A020 40%, transparent)',
          borderRadius: 14,
          fontSize: 15,
          lineHeight: 1.5,
        }}
      >
        <strong>Add to Home Screen first</strong> to enable push notifications on this device.
        Tap the Share button in Safari, then "Add to Home Screen", then open from your home screen.
      </div>
    );
  }

  return <PushPanel />;
}

function PushPanel(): JSX.Element {
  const publicKeyQuery = trpc.notifications.publicKey.useQuery();
  const prefsQuery = trpc.notifications.preferences.get.useQuery();
  const prefsMutation = trpc.notifications.preferences.set.useMutation();
  const subscribeMutation = trpc.notifications.subscribe.useMutation();
  const unsubscribeMutation = trpc.notifications.unsubscribe.useMutation();
  const testMutation = trpc.notifications.test.useMutation();

  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'sent' | 'error'>('idle');
  const [permissionDenied, setPermissionDenied] = useState(false);

  // Read the current device's PushSubscription on mount (browser-local state).
  useEffect(() => {
    let cancelled = false;
    void getExistingSubscription().then((existing) => {
      if (cancelled) return;
      setSubscription(existing);
      setSubscribed(existing !== null);
    });
    return () => { cancelled = true; };
  }, []);

  const vapidKey = publicKeyQuery.data?.vapidPublicKey ?? null;
  const prefs: Prefs | undefined = prefsQuery.data;

  const handleSubscribeToggle = useCallback(async () => {
    setBusy(true);
    try {
      if (subscribed && subscription) {
        await subscription.unsubscribe();
        try {
          await unsubscribeMutation.mutateAsync({ endpoint: subscription.endpoint });
        } catch {
          // Local unsubscribe still succeeded.
        }
        setSubscription(null);
        setSubscribed(false);
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPermissionDenied(true);
        return;
      }
      setPermissionDenied(false);

      const reg = await navigator.serviceWorker.ready;
      const subOptions: PushSubscriptionOptionsInit = { userVisibleOnly: true };
      if (vapidKey) {
        subOptions.applicationServerKey = urlBase64ToUint8Array(vapidKey);
      }
      const sub = await reg.pushManager.subscribe(subOptions);
      setSubscription(sub);
      setSubscribed(true);

      const rawKey = sub.getKey('p256dh');
      const rawAuth = sub.getKey('auth');
      const p256dh = rawKey
        ? btoa(String.fromCharCode(...new Uint8Array(rawKey)))
        : '';
      const auth = rawAuth
        ? btoa(String.fromCharCode(...new Uint8Array(rawAuth)))
        : '';

      await subscribeMutation.mutateAsync({
        endpoint: sub.endpoint,
        p256dh,
        auth,
        userAgent: navigator.userAgent,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setPermissionDenied(true);
      }
    } finally {
      setBusy(false);
    }
  }, [subscribed, subscription, vapidKey, subscribeMutation, unsubscribeMutation]);

  const handlePrefChange = useCallback(async (partial: Partial<Prefs>) => {
    if (!prefs) return;
    const next: Prefs = { ...prefs, ...partial };
    try {
      await prefsMutation.mutateAsync(next);
      await prefsQuery.refetch();
    } catch {
      // Optimistic UI — next refetch will reconcile.
    }
  }, [prefs, prefsMutation, prefsQuery]);

  const handleTest = useCallback(async () => {
    setTestStatus('idle');
    try {
      await testMutation.mutateAsync();
      setTestStatus('sent');
    } catch {
      setTestStatus('error');
    }
    setTimeout(() => setTestStatus('idle'), 4000);
  }, [testMutation]);

  if (publicKeyQuery.isLoading || prefsQuery.isLoading || !prefs) {
    return <p style={{ color: 'var(--text-muted)' }}>Loading notification settings…</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '14px 16px',
          background: subscribed
            ? 'color-mix(in srgb, var(--accent) 10%, var(--surface))'
            : 'var(--surface-raised)',
          border: `1.5px solid ${subscribed ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 14,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 16 }}>
            Send me notifications on this device
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
            {subscribed
              ? 'Subscribed — you will receive push notifications when the hamster is active.'
              : 'Not subscribed on this device.'}
          </div>
        </div>
        <button
          type="button"
          className={`hc-btn${subscribed ? '' : ' hc-btn-primary'}`}
          disabled={busy}
          onClick={() => void handleSubscribeToggle()}
          aria-pressed={subscribed}
          style={{ minHeight: 44, padding: '8px 18px', fontSize: 15 }}
        >
          {busy ? '…' : subscribed ? 'Unsubscribe' : 'Enable'}
        </button>
      </div>

      {permissionDenied && (
        <div
          role="alert"
          style={{
            padding: '10px 14px',
            background: 'color-mix(in srgb, var(--danger) 10%, var(--surface))',
            border: '1px solid var(--danger)',
            borderRadius: 10,
            fontSize: 14,
            color: 'var(--danger)',
          }}
        >
          Notification permission was denied. Please enable it in your browser settings.
        </div>
      )}

      <Field label="Notify me about">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {PUSH_ACTIVITIES.map((a) => {
            const checked = prefs.activities.includes(a);
            return (
              <label
                key={a}
                style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...prefs.activities, a]
                      : prefs.activities.filter((x) => x !== a);
                    void handlePrefChange({ activities: next });
                  }}
                  style={{ width: 20, height: 20 }}
                />
                <span>{ACTIVITY_LABELS[a]}</span>
              </label>
            );
          })}
        </div>
      </Field>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={prefs.rare_only}
          onChange={(e) => void handlePrefChange({ rare_only: e.target.checked })}
          style={{ width: 22, height: 22, marginTop: 2, flexShrink: 0 }}
        />
        <div>
          <div style={{ fontWeight: 500 }}>Only notify on rare moments</div>
          <small style={{ color: 'var(--text-muted)' }}>
            First time today / waking up / long wheel runs
          </small>
        </div>
      </label>

      <Field label="Quiet hours (no notifications)">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>From</span>
            <input
              type="time"
              className="hc-input"
              value={minuteToTime(prefs.quiet_start_minute)}
              onChange={(e) => void handlePrefChange({ quiet_start_minute: timeToMinute(e.target.value) })}
              style={{ width: 'auto', minHeight: 44, padding: '8px 12px' }}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>To</span>
            <input
              type="time"
              className="hc-input"
              value={minuteToTime(prefs.quiet_end_minute)}
              onChange={(e) => void handlePrefChange({ quiet_end_minute: timeToMinute(e.target.value) })}
              style={{ width: 'auto', minHeight: 44, padding: '8px 12px' }}
            />
          </label>
        </div>
      </Field>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          className="hc-btn"
          disabled={!subscribed}
          onClick={() => void handleTest()}
          aria-label="Send a test notification to this device"
        >
          Send test notification
        </button>
        {testStatus === 'sent' && (
          <span style={{ color: 'var(--success)', fontSize: 14 }}>Test sent!</span>
        )}
        {testStatus === 'error' && (
          <span role="alert" style={{ color: 'var(--danger)', fontSize: 14 }}>
            Test failed — check server logs.
          </span>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="hc-label">{label}</div>
      {children}
    </div>
  );
}
