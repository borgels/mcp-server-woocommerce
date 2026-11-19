import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, ExampleClient } from '../src/example/client.js';
import { ExampleHttpError, parseRetryAfterMs, redactSecrets, SecretRedactor } from '../src/errors.js';
import { USER_AGENT } from '../src/version.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const BASE = 'https://api.vendor.test/v1';

type Handler = (url: string, init?: RequestInit) => Response | unknown | Promise<Response | unknown>;

function makeFetch(handler: Handler) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const result = await handler(String(input), init);
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

const noSleep = vi.fn(async (_ms: number) => undefined);

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof ExampleClient>[0]> = {}) {
  return new ExampleClient({ apiKey: 'k', baseUrl: BASE, fetchImpl, sleep: noSleep, ...extra });
}

describe('ExampleClient', () => {
  it('sends the API key and User-Agent headers and never follows redirects', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return { id: '1' };
    });

    await new ExampleClient({ apiKey: 'secret-key', baseUrl: `${BASE}/`, fetchImpl }).get('/items/1', { q: 'x' });

    expect(seenUrl).toBe(`${BASE}/items/1?q=x`);
    expect(headersOf(seenInit)[API_KEY_HEADER]).toBe('secret-key');
    expect(headersOf(seenInit)['User-Agent']).toBe(USER_AGENT);
    expect(seenInit?.redirect).toBe('manual');
  });

  it('throws before sending anything when the API key or base URL is missing', async () => {
    const fetchImpl = makeFetch(() => ({}));
    delete process.env.EXAMPLE_API_KEY;
    delete process.env.EXAMPLE_BASE_URL;

    await expect(new ExampleClient({ baseUrl: BASE, fetchImpl }).get('/x')).rejects.toThrow('EXAMPLE_API_KEY');
    await expect(new ExampleClient({ apiKey: 'k', fetchImpl }).get('/x')).rejects.toThrow('EXAMPLE_BASE_URL');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses unsafe base URLs without echoing credentials', () => {
    expect(() => new ExampleClient({ apiKey: 'k', baseUrl: 'http://api.vendor.test' })).toThrow('https://');
    expect(() => new ExampleClient({ apiKey: 'k', baseUrl: 'not a url' })).toThrow('not a valid URL');
    expect(() => new ExampleClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:8080/api' })).not.toThrow();
    expect(() => new ExampleClient({ apiKey: 'k', baseUrl: 'http://localhost:8080/api' })).not.toThrow();
    expect(() => new ExampleClient({ apiKey: 'k', baseUrl: 'http://[::1]:8080/api' })).not.toThrow();

    for (const baseUrl of [
      'https://user:hunter2@api.vendor.test/v1',
      'https://api.vendor.test/v1?x=1',
      'https://api.vendor.test/v1#frag',
    ]) {
      let message = '';
      try {
        new ExampleClient({ apiKey: 'k', baseUrl });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('credentials, a query string or a fragment');
      expect(message).not.toContain('hunter2');
    }
  });

  it('validates numeric environment variables and options instead of producing NaN', () => {
    process.env.EXAMPLE_TIMEOUT_MS = '30s';
    expect(() => new ExampleClient({ apiKey: 'k' })).toThrow('EXAMPLE_TIMEOUT_MS');
    process.env.EXAMPLE_TIMEOUT_MS = '3000000000';
    expect(() => new ExampleClient({ apiKey: 'k' })).toThrow('EXAMPLE_TIMEOUT_MS');
    delete process.env.EXAMPLE_TIMEOUT_MS;
    process.env.EXAMPLE_MAX_CONCURRENCY = 'many';
    expect(() => new ExampleClient({ apiKey: 'k' })).toThrow('EXAMPLE_MAX_CONCURRENCY');
    delete process.env.EXAMPLE_MAX_CONCURRENCY;
    process.env.EXAMPLE_MAX_RESPONSE_BYTES = '10MB';
    expect(() => new ExampleClient({ apiKey: 'k' })).toThrow('EXAMPLE_MAX_RESPONSE_BYTES');
    delete process.env.EXAMPLE_MAX_RESPONSE_BYTES;
    process.env.EXAMPLE_ALLOW_CUSTOM_BASE_URL = 'perhaps';
    expect(() => new ExampleClient({ apiKey: 'k', baseUrl: BASE })).toThrow('EXAMPLE_ALLOW_CUSTOM_BASE_URL');

    expect(() => new ExampleClient({ apiKey: 'k', maxConcurrency: 0 })).toThrow('maxConcurrency');
    expect(() => new ExampleClient({ apiKey: 'k', maxConcurrency: Number.NaN })).toThrow('maxConcurrency');
    expect(() => new ExampleClient({ apiKey: 'k', timeoutMs: 2 ** 31 })).toThrow('timeoutMs');
    expect(() => new ExampleClient({ apiKey: 'k', maxAttempts: 0 })).toThrow('maxAttempts');
  });
});

describe('error handling', () => {
  it('gives the status and our own hint, never the vendor body or code', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ code: 'invalid_key', message: 'Unrecognized key' }, 401));
    const error = await makeClient(fetchImpl).get('/x').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExampleHttpError);
    expect((error as ExampleHttpError).status).toBe(401);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).toContain('EXAMPLE_API_KEY');
    expect((error as Error).message).not.toContain('Unrecognized key');
    expect((error as Error).message).not.toContain('invalid_key');
  });

  it('never puts an error body in the error', async () => {
    const html = `<html>${'x'.repeat(5000)}</html>`;
    const fetchImpl = makeFetch(() => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }));
    const error = (await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: unknown) => e)) as ExampleHttpError;
    expect(error.message).toBe('Example API request failed with HTTP 502');
  });

  it('reads at most 64 KB of an error body', async () => {
    let pulled = 0;
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new TextEncoder().encode('e'.repeat(16 * 1024)));
            },
          }),
          { status: 500, headers: { 'content-type': 'text/html' } },
        ),
    );
    const error = (await makeClient(fetchImpl)
      .get('/x')
      .catch((e: unknown) => e)) as ExampleHttpError;
    expect(error).toBeInstanceOf(ExampleHttpError);
    expect(pulled).toBeLessThan(10);
    expect(error.message.length).toBeLessThan(700);
  });

  it('redacts the configured API key wherever it appears, before truncating', async () => {
    const apiKey = 'live-key-0123456789abcdef';
    const respond = (body: string, type = 'text/plain') =>
      new ExampleClient({
        apiKey,
        baseUrl: BASE,
        fetchImpl: makeFetch(() => new Response(body, { status: 400, headers: { 'content-type': type } })),
      });

    const echoed = (await respond(`proxy error: ${apiKey} and ${encodeURIComponent(apiKey)}`)
      .get('/x')
      .catch((e: unknown) => e)) as ExampleHttpError;
    expect(echoed.message).not.toContain(apiKey);
    expect(echoed.message).not.toContain('proxy error');

    const boundary = (await respond(`${'x'.repeat(490)}${apiKey}`)
      .get('/x')
      .catch((e: unknown) => e)) as ExampleHttpError;
    expect(boundary.message).not.toContain(apiKey.slice(0, 6));

    const nested = (await respond(JSON.stringify({ message: 'bad', nested: { echo: apiKey } }), 'application/json')
      .get('/x')
      .catch((e: unknown) => e)) as ExampleHttpError;
    expect(JSON.stringify(nested)).not.toContain(apiKey);

    expect(redactSecrets('X-API-KEY: abc123')).not.toContain('abc123');
    expect(redactSecrets('Authorization: Bearer abc123')).not.toContain('abc123');
    expect(redactSecrets('EXAMPLE_API_KEY=abc123')).not.toContain('abc123');
  });

  it('redacts the configured key header by name', () => {
    const redactor = new SecretRedactor().addHeader('X-Vendor-Token').addHeader(API_KEY_HEADER);
    const redactSecrets = (text: string) => redactor.redact(text);
    expect(redactSecrets('sent x-vendor-token: abc123, ok')).toBe('sent x-vendor-token: ‹redacted›, ok');
    expect(redactSecrets(`${API_KEY_HEADER}: abc123`)).not.toContain('abc123');
    for (const text of [
      '{"X-Vendor-Token":"abc123"}',
      "{'x-vendor-token': 'abc123'}",
      'x-vendor-token=abc123',
      `{"${API_KEY_HEADER}": "abc123"}`,
      '{"authorization":"Bearer abc123"}',
      'authorization=abc123',
      'x-api-key=abc123:def',
      'X-Vendor-Token=abc123=def',
      'authorization=abc123:pass',
      'Authorization: Basic abc123',
      'Authorization: Token abc123',
      '"Authorization": "Digest abc123"',
    ]) {
      expect(redactSecrets(text), text).not.toContain('abc123');
    }
  });

  it('keeps query strings out of error URLs', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 400));
    const error = (await makeClient(fetchImpl)
      .get('/items', { cursor: 'secret-cursor' })
      .catch((e: unknown) => e)) as ExampleHttpError;
    expect(error.url).toBe(`${BASE}/items`);
    expect(error.message).not.toContain('secret-cursor');
  });

  it('parses Retry-After as seconds or an HTTP date', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('5', now)).toBe(5000);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    for (const value of ['0', 'Wed, 31 Dec 2025 23:59:00 GMT', 'soon', '1.5', '-1', '+5', '']) {
      expect(parseRetryAfterMs(value, now)).toBeUndefined();
    }
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it('names only the system error code of a network error, never its message', async () => {
    const fetchImpl = makeFetch(() => {
      throw new TypeError('fetch failed somewhere odd', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.vendor.test'), { code: 'ENOTFOUND' }),
      });
    });
    const message = await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: Error) => e.message);
    expect(message).toMatch(/Network error calling the Example API \(GET\) \(ENOTFOUND\)\./);
    expect(message).not.toMatch(/odd|getaddrinfo/);
  });

  it('reports timeouts clearly', async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(makeClient(fetchImpl).get('/items?cursor=c')).rejects.toThrow(
      /timed out after \d+ ms \(GET\)/,
    );
  });

  it('caps successful response bodies', async () => {
    const big = makeFetch(
      () => new Response('x'.repeat(100), { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(makeClient(big, { maxResponseBytes: 10 }).get('/x')).rejects.toThrow('exceeds the 10 byte limit');
    await expect(makeClient(big, { maxResponseBytes: 1000 }).get('/x')).resolves.toBe('x'.repeat(100));
  });
});

describe('redirects', () => {
  it('never follows redirects and names the target without its query', async () => {
    const fetchImpl = makeFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://other.vendor.test/v1/items?t=1' } }),
    );
    const message = await makeClient(fetchImpl)
      .get('/items')
      .catch((e: Error) => e.message);
    expect(message).toContain('redirect (HTTP 302) for GET');
    expect(message).toContain('EXAMPLE_BASE_URL');
    // The Location is the vendor's text: never quoted.
    expect(message).not.toContain('other.vendor.test');
    await expect(makeClient(fetchImpl).post('/items', {})).rejects.toThrow(/redirect/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('other.vendor.test'))).toBe(true);
  });
});

describe('retries and concurrency', () => {
  it('retries idempotent GETs on 429/502/503/504 honouring Retry-After', async () => {
    const statuses = [503, 429];
    const fetchImpl = makeFetch(() => {
      const status = statuses.shift();
      if (status === 429) {
        return jsonResponse({}, 429, { 'retry-after': '2' });
      }
      if (status) {
        return jsonResponse({}, status);
      }
      return { ok: true };
    });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = makeClient(fetchImpl, { sleep, retryBaseDelayMs: 10 });

    await expect(client.get('/x')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1]).toEqual([2000]);
  });

  it('does not wait for a Retry-After beyond the retry budget and surfaces it', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503, { 'retry-after': '3600' }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const error = (await makeClient(fetchImpl, { sleep })
      .get('/x')
      .catch((e: unknown) => e)) as ExampleHttpError;

    expect(error).toBeInstanceOf(ExampleHttpError);
    expect(error.message).toContain('retry-after=3600s');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries GETs on transient network errors only', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      }
      return { ok: true };
    });
    await expect(makeClient(fetchImpl).get('/x')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);

    const permanent = makeFetch(() => {
      throw new TypeError('Headers.append: invalid header value');
    });
    await expect(makeClient(permanent).get('/x')).rejects.toThrow('Network error');
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it('never retries POST or PATCH', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503));
    const client = makeClient(fetchImpl);
    await expect(client.post('/x', {})).rejects.toBeInstanceOf(ExampleHttpError);
    await expect(client.patch('/x', {})).rejects.toBeInstanceOf(ExampleHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const failing = makeFetch(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    });
    await expect(makeClient(failing).post('/x', {})).rejects.toThrow('Network error');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('releases the concurrency slot after failures', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new DOMException('timeout', 'TimeoutError');
      }
      if (calls === 2) {
        return jsonResponse({}, 500);
      }
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 1 });
    await expect(client.get('/x')).rejects.toThrow('timed out');
    await expect(client.get('/x')).rejects.toBeInstanceOf(ExampleHttpError);
    await expect(client.get('/x')).resolves.toEqual({ ok: true });
  });

  it('limits concurrent requests per client', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = makeFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 2 });

    await Promise.all(Array.from({ length: 8 }, () => client.get('/x')));
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(peak).toBe(2);
  });
});

describe('against a local upstream (real sockets)', () => {
  let upstream: Server | undefined;

  afterEach(async () => {
    await new Promise<void>(resolve => (upstream ? upstream.close(() => resolve()) : resolve()));
    upstream = undefined;
  });

  async function startUpstream(handler: Parameters<typeof createHttpServer>[1]): Promise<string> {
    upstream = createHttpServer(handler);
    await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  }

  it('sends the key, refuses a redirect and does not contact the redirect target', async () => {
    const seen: Array<{ url?: string; key?: string }> = [];
    const base = await startUpstream((req, res) => {
      seen.push({ url: req.url, key: req.headers[API_KEY_HEADER.toLowerCase()] as string | undefined });
      if (req.url === '/v1/items/1') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"1"}');
        return;
      }
      res.writeHead(302, { location: `${base}/items/1` }).end();
    });
    const client = new ExampleClient({ apiKey: 'local-key-123456', baseUrl: base });

    await expect(client.get('/items/1')).resolves.toEqual({ id: '1' });
    await expect(client.get('/moved')).rejects.toThrow('redirects are not followed');
    expect(seen).toEqual([
      { url: '/v1/items/1', key: 'local-key-123456' },
      { url: '/v1/moved', key: 'local-key-123456' },
    ]);
  });

  it('times out a stalled upstream', async () => {
    const base = await startUpstream(() => {
      // never answers
    });
    const client = new ExampleClient({ apiKey: 'k', baseUrl: base, timeoutMs: 100, maxAttempts: 1 });
    await expect(client.get('/slow')).rejects.toThrow(/timed out after 100 ms/);
    upstream?.closeAllConnections();
  });
});
