// app/web/src/lib/push.ts
//
// Web Push helpers. No React — pure browser API wrappers.

/**
 * Convert a URL-safe base64 VAPID public key string to a Uint8Array
 * suitable for `pushManager.subscribe({ applicationServerKey })`.
 *
 * Standard algorithm from the Push API examples in the MDN docs.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  // Pad to a multiple of 4 characters.
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  // Swap URL-safe chars back to standard base64.
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Return the existing PushSubscription for this browser, or null if the
 * user is not currently subscribed. Resolves to null when the Push API is
 * unavailable (old browser, HTTP-only origin, etc.).
 */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}
