// app/web/test/push.test.ts
//
// Tests for the push.ts helper module.

import { describe, expect, it } from 'vitest';
import { urlBase64ToUint8Array } from '../src/lib/push';

describe('urlBase64ToUint8Array', () => {
  it('converts a standard VAPID public key to Uint8Array', () => {
    // A real VAPID public key is 65 bytes (uncompressed EC point).
    // We test with a short known string.
    const b64 = 'dGVzdA'; // "test" in base64 without padding
    const result = urlBase64ToUint8Array(b64);
    expect(result).toBeInstanceOf(Uint8Array);
    // "test" = [116, 101, 115, 116]
    expect(Array.from(result)).toEqual([116, 101, 115, 116]);
  });

  it('handles URL-safe characters (- and _)', () => {
    // Standard base64 uses + and /; URL-safe uses - and _.
    // "test" in standard base64 = "dGVzdA=="; ">" = 0x3e (as part of a longer sequence).
    // Create something that would have + or / in standard base64:
    // 0xfb 0xff → standard: +/ (URL-safe: -_) before padding
    const urlSafeB64 = '-_8'; // represents bytes [0xfb, 0xff] (partially)
    const result = urlBase64ToUint8Array(urlSafeB64);
    expect(result).toBeInstanceOf(Uint8Array);
    // We just verify it doesn't throw and returns a Uint8Array.
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles empty string without throwing', () => {
    expect(() => urlBase64ToUint8Array('')).not.toThrow();
    const result = urlBase64ToUint8Array('');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });
});
