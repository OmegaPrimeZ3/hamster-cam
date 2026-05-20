// Unit tests for the SSRF guard in cameras.testStream (Security-Review F2).
//
// We don't bother spinning up Fastify here — testStream is a pure function
// modulo `fetch` + `dns.lookup`, and we inject both via the optional `deps`
// argument so we never touch the host's resolver or network.

import { describe, expect, it } from 'vitest';

import { isInternalHost, testStream } from '../src/frigate.js';

function makeFetchStub(impl: (url: string) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request): Promise<Response> => {
    let u: string;
    if (typeof input === 'string') u = input;
    else if (input instanceof URL) u = input.toString();
    else u = input.url;
    return Promise.resolve(impl(u));
  }) as typeof fetch;
}

describe('isInternalHost', () => {
  it('flags loopback literals', () => {
    expect(isInternalHost('localhost')).toBe(true);
    expect(isInternalHost('127.0.0.1')).toBe(true);
    expect(isInternalHost('127.55.55.55')).toBe(true);
    expect(isInternalHost('0.0.0.0')).toBe(true);
  });
  it('flags RFC1918 ranges', () => {
    expect(isInternalHost('10.0.0.1')).toBe(true);
    expect(isInternalHost('10.255.255.255')).toBe(true);
    expect(isInternalHost('172.16.0.1')).toBe(true);
    expect(isInternalHost('172.31.255.255')).toBe(true);
    expect(isInternalHost('172.32.0.1')).toBe(false); // outside /12
    expect(isInternalHost('172.15.0.1')).toBe(false); // outside /12
    expect(isInternalHost('192.168.1.1')).toBe(true);
  });
  it('flags link-local + metadata endpoint', () => {
    expect(isInternalHost('169.254.169.254')).toBe(true);
    expect(isInternalHost('169.254.0.0')).toBe(true);
  });
  it('flags CGNAT 100.64/10', () => {
    expect(isInternalHost('100.64.0.1')).toBe(true);
    expect(isInternalHost('100.127.255.255')).toBe(true);
    expect(isInternalHost('100.128.0.1')).toBe(false);
    expect(isInternalHost('100.63.255.255')).toBe(false);
  });
  it('flags IPv6 loopback + ULA + link-local', () => {
    expect(isInternalHost('::1')).toBe(true);
    expect(isInternalHost('::')).toBe(true);
    expect(isInternalHost('fc00::1')).toBe(true);
    expect(isInternalHost('fdab:1::1')).toBe(true);
    expect(isInternalHost('fe80::1')).toBe(true);
    expect(isInternalHost('fe80::1%en0')).toBe(true);
    expect(isInternalHost('febf::1')).toBe(true);
    // outside the /10 link-local boundary
    expect(isInternalHost('fec0::1')).toBe(false);
  });
  it('flags IPv4-mapped IPv6 internal addresses', () => {
    expect(isInternalHost('::ffff:127.0.0.1')).toBe(true);
    expect(isInternalHost('::ffff:10.1.2.3')).toBe(true);
    expect(isInternalHost('::ffff:8.8.8.8')).toBe(false);
  });
  it('passes ordinary public hosts/IPs through', () => {
    expect(isInternalHost('example.com')).toBe(false);
    expect(isInternalHost('cam.remy-hamster.com')).toBe(false);
    expect(isInternalHost('8.8.8.8')).toBe(false);
    expect(isInternalHost('1.1.1.1')).toBe(false);
    expect(isInternalHost('2606:4700:4700::1111')).toBe(false);
  });
});

describe('testStream', () => {
  const publicLookup = async () => ({ address: '93.184.216.34', family: 4 as const });

  it('passes a public host through and returns the status', async () => {
    const fetchFn = makeFetchStub(() => new Response(null, { status: 200 }));
    const out = await testStream('https://example.com/stream.mjpg', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: true, status: 200 });
  });

  it('rejects a 127.0.0.1 URL without dialing fetch', async () => {
    let called = false;
    const fetchFn = makeFetchStub(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const out = await testStream('http://127.0.0.1:5000/api', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: false, status: null });
    expect(called).toBe(false);
  });

  it('rejects RFC1918 literals without dialing fetch', async () => {
    let called = false;
    const fetchFn = makeFetchStub(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const out = await testStream('http://10.0.0.5/x', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: false, status: null });
    expect(called).toBe(false);
  });

  it('rejects link-local 169.254/16 (metadata endpoint)', async () => {
    const fetchFn = makeFetchStub(() => new Response(null, { status: 200 }));
    const out = await testStream('http://169.254.169.254/latest/meta-data/', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: false, status: null });
  });

  it('rejects DNS rebinding: public hostname resolves to loopback', async () => {
    // The hostname `evil.example` isn't literally internal, so we go to dns.
    // The injected lookup returns 127.0.0.1 → must reject.
    const lookup = async () => ({ address: '127.0.0.1', family: 4 as const });
    let called = false;
    const fetchFn = makeFetchStub(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const out = await testStream('http://evil.example/x', { lookup, fetchFn });
    expect(out).toEqual({ ok: false, status: null });
    expect(called).toBe(false);
  });

  it('rejects DNS rebinding into IPv6 ULA', async () => {
    const lookup = async () => ({ address: 'fc00::1', family: 6 as const });
    let called = false;
    const fetchFn = makeFetchStub(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const out = await testStream('http://rebind.example/x', { lookup, fetchFn });
    expect(out).toEqual({ ok: false, status: null });
    expect(called).toBe(false);
  });

  it('does not follow a 302 to an internal target — surfaces it as-is', async () => {
    // With redirect:'manual' undici returns the 3xx response and our function
    // surfaces status 302; it does NOT silently chase the Location header. The
    // attacker therefore gets the same "redirect happened, not following"
    // result whether or not the destination is internal.
    const fetchFn = makeFetchStub(() =>
      new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/' },
      }),
    );
    const out = await testStream('https://example.com/redir', {
      lookup: publicLookup,
      fetchFn,
    });
    // ok is false because 302 isn't 2xx, and we return the literal status so
    // the admin sees the redirect happened — but crucially we did not chase it.
    expect(out.ok).toBe(false);
    expect(out.status).toBe(302);
  });

  it('rtsp:// short-circuits as ok without fetch', async () => {
    let called = false;
    const fetchFn = makeFetchStub(() => {
      called = true;
      return new Response(null, { status: 200 });
    });
    const out = await testStream('rtsp://cam.local:8554/main', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: true, status: null });
    expect(called).toBe(false);
  });

  it('non-http/https/rtsp schemes are rejected', async () => {
    const fetchFn = makeFetchStub(() => new Response(null, { status: 200 }));
    const out = await testStream('file:///etc/passwd', {
      lookup: publicLookup,
      fetchFn,
    });
    expect(out).toEqual({ ok: false, status: null });
  });

  it('returns false on unresolvable hostnames', async () => {
    const lookup = async () => {
      throw new Error('ENOTFOUND');
    };
    const fetchFn = makeFetchStub(() => new Response(null, { status: 200 }));
    const out = await testStream('http://nonexistent.invalid/', { lookup, fetchFn });
    expect(out).toEqual({ ok: false, status: null });
  });

  it('malformed URLs are rejected', async () => {
    const out = await testStream('not-a-url');
    expect(out).toEqual({ ok: false, status: null });
  });
});
