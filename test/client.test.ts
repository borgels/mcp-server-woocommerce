import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, WooCommerceClient } from '../src/woocommerce/client.js';
import { WooCommerceHttpError, parseRetryAfterMs, redactSecrets, SecretRedactor } from '../src/errors.js';
import { USER_AGENT } from '../src/version.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const SHOP = 'https://shop.example.com';
const SECRET = 'cs_test_secret';
const BASE = `${SHOP}/wp-json/wc/v3`;

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

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof WooCommerceClient>[0]> = {}) {
  return new WooCommerceClient({ consumerKey: 'k', consumerSecret: SECRET, shopUrl: SHOP, fetchImpl, sleep: noSleep, ...extra });
}

describe('WooCommerceClient', () => {
  it('sends Basic auth with key and secret and the User-Agent, below the documented API path, and never follows redirects', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return { id: 1 };
    });

    await new WooCommerceClient({ consumerKey: 'ck_key', consumerSecret: 'cs_secret', shopUrl: `${SHOP}/`, fetchImpl }).get('/customers/1', {
      q: 'x',
    });

    expect(seenUrl).toBe(`${SHOP}/wp-json/wc/v3/customers/1?q=x`);
    expect(headersOf(seenInit)[API_KEY_HEADER]).toBe(`Basic ${Buffer.from('ck_key:cs_secret').toString('base64')}`);
    expect(headersOf(seenInit)['User-Agent']).toBe(USER_AGENT);
    expect(seenInit?.redirect).toBe('manual');
  });

  it('keeps a shop in a subfolder', async () => {
    const client = new WooCommerceClient({ consumerKey: 'k', consumerSecret: 's', shopUrl: `${SHOP}/butik`, fetchImpl: makeFetch(() => ({})) });
    expect(client.baseUrl).toBe(`${SHOP}/butik/wp-json/wc/v3`);
  });

  it('throws before sending anything when the key, the secret or the shop address is missing', async () => {
    const fetchImpl = makeFetch(() => ({}));
    delete process.env.WOOCOMMERCE_CONSUMER_KEY;
    delete process.env.WOOCOMMERCE_CONSUMER_SECRET;
    delete process.env.WOOCOMMERCE_SHOP_URL;

    await expect(new WooCommerceClient({ consumerSecret: 's', shopUrl: SHOP, fetchImpl }).get('/x')).rejects.toThrow('WOOCOMMERCE_CONSUMER_KEY');
    await expect(new WooCommerceClient({ consumerKey: 'k', shopUrl: SHOP, fetchImpl }).get('/x')).rejects.toThrow('WOOCOMMERCE_CONSUMER_SECRET');
    await expect(new WooCommerceClient({ consumerKey: 'k', consumerSecret: 's', fetchImpl }).get('/x')).rejects.toThrow('WOOCOMMERCE_SHOP_URL');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts the key, the secret and their Basic form', () => {
    const client = new WooCommerceClient({ consumerKey: 'ck_abcdefghijklmnop', consumerSecret: 'cs_qrstuvwxyz012345', shopUrl: SHOP }); // gitleaks:allow (a test value, not a key)
    const basic = Buffer.from('ck_abcdefghijklmnop:cs_qrstuvwxyz012345').toString('base64');
    const text = client.redactor.redact(`a ck_abcdefghijklmnop b cs_qrstuvwxyz012345 c ${basic}`);
    expect(text).not.toContain('ck_abcdefghijklmnop');
    expect(text).not.toContain('cs_qrstuvwxyz012345');
    expect(text).not.toContain(basic);
  });

  it('sends only the writes on its fixed list, and never a DELETE', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ id: 1 }, 200));
    const client = makeClient(fetchImpl);
    await expect(client.post('/orders', {})).rejects.toThrow('Refused');
    await expect(client.post('/orders/1/refunds/2', {})).rejects.toThrow('Refused');
    await expect(client.post('/orders/batch', {})).rejects.toThrow('Refused');
    await expect(client.post('/coupons', {})).rejects.toThrow('Refused');
    await expect(client.put('/settings/general/x', {})).rejects.toThrow('Refused');
    await expect(client.post('/customers', {})).rejects.toThrow('Refused');
    await expect(client.post('/payment_gateways/x', {})).rejects.toThrow('Refused');
    await expect(client.put('/orders/abc', {})).rejects.toThrow('Refused');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.post('/orders/1/notes', {})).resolves.toEqual({ id: 1 });
    await expect(client.put('/customers/21', {})).resolves.toEqual({ id: 1 });
    expect('delete' in client).toBe(false);
  });

  it('refuses unsafe shop addresses without echoing credentials', () => {
    delete process.env.WOOCOMMERCE_ALLOW_PRIVATE_HOST;
    const make = (shopUrl: string) => () => new WooCommerceClient({ consumerKey: 'k', consumerSecret: 's', shopUrl });
    expect(make('http://shop.example.com')).toThrow('https://');
    expect(make('not a url')).toThrow('not a valid URL');
    for (const shopUrl of [
      'https://127.0.0.1',
      'https://10.1.2.3/shop',
      'https://[::1]',
      'https://localhost',
      'https://intranet',
      'https://shop.local',
      'https://shop.internal',
    ]) {
      expect(make(shopUrl), shopUrl).toThrow('public host name');
    }
    expect(make(SHOP)).not.toThrow();

    for (const shopUrl of ['https://user:hunter2@shop.example.com', `${SHOP}?x=1`, `${SHOP}#frag`]) {
      let message = '';
      try {
        make(shopUrl)();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('credentials, a query string or a fragment');
      expect(message).not.toContain('hunter2');
    }
  });

  it('allows a loopback shop only with allowPrivateHost, for local development', () => {
    const make = (shopUrl: string, allowPrivateHost?: boolean) => () =>
      new WooCommerceClient({ consumerKey: 'k', consumerSecret: 's', shopUrl, allowPrivateHost });
    expect(make('http://127.0.0.1:8080')).toThrow();
    expect(make('http://127.0.0.1:8080', true)).not.toThrow();
    expect(make('http://localhost:8080', true)).not.toThrow();
    expect(make('http://shop.example.com', true)).toThrow('https://');
  });

  it('refuses a shop name that resolves to a private address, before sending anything', async () => {
    const fetchImpl = makeFetch(() => ({ id: 1 }));
    for (const addresses of [['10.0.0.5'], ['203.0.113.10', '192.168.1.1'], ['::1'], ['fd00::1'], ['169.254.169.254'], []]) {
      const client = new WooCommerceClient({
        consumerKey: 'k',
        consumerSecret: 's',
        shopUrl: SHOP,
        fetchImpl,
        resolveHost: async () => addresses,
      });
      await expect(client.get('/orders'), addresses.join()).rejects.toThrow(/private or local|could not be resolved|Refused/);
    }
    const failing = new WooCommerceClient({
      consumerKey: 'k',
      consumerSecret: 's',
      shopUrl: SHOP,
      fetchImpl,
      resolveHost: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await expect(failing.get('/orders')).rejects.toThrow('could not be resolved');
    expect(fetchImpl).not.toHaveBeenCalled();

    const ok = new WooCommerceClient({ consumerKey: 'k', consumerSecret: 's', shopUrl: SHOP, fetchImpl, resolveHost: async () => ['203.0.113.10'] });
    await expect(ok.get('/orders')).resolves.toEqual({ id: 1 });
  });

  it('gives the same shop identity for every key of a shop, and holds no credential', () => {
    const a = new WooCommerceClient({ consumerKey: 'ck_one_000000000', consumerSecret: 'cs_one', shopUrl: SHOP });
    const b = new WooCommerceClient({ consumerKey: 'ck_two_000000000', consumerSecret: 'cs_two', shopUrl: 'https://WWW.Shop.Example.com/' });
    const other = new WooCommerceClient({ consumerKey: 'ck_one_000000000', consumerSecret: 'cs_one', shopUrl: 'https://other.example.com' });
    expect(a.shopIdentity()).toBe(b.shopIdentity());
    expect(a.shopIdentity()).not.toBe(other.shopIdentity());
    expect(a.shopIdentity()).not.toContain('ck_one');
  });

  it('reads the list totals from X-WP-Total and X-WP-TotalPages', async () => {
    const fetchImpl = makeFetch(() => jsonResponse([{ id: 1 }], 200, { 'X-WP-Total': '42', 'X-WP-TotalPages': '3' }));
    await expect(makeClient(fetchImpl).getPage('/orders')).resolves.toEqual({ body: [{ id: 1 }], total: 42, totalPages: 3 });
    const odd = makeFetch(() => jsonResponse([], 200, { 'X-WP-Total': 'many' }));
    await expect(makeClient(odd).getPage('/orders')).resolves.toEqual({ body: [], total: undefined, totalPages: undefined });
  });

  it('validates numeric environment variables and options instead of producing NaN', () => {
    const make = (extra: Partial<ConstructorParameters<typeof WooCommerceClient>[0]> = {}) => () =>
      new WooCommerceClient({ consumerKey: 'k', consumerSecret: 's', shopUrl: SHOP, ...extra });
    process.env.WOOCOMMERCE_TIMEOUT_MS = '30s';
    expect(make()).toThrow('WOOCOMMERCE_TIMEOUT_MS');
    process.env.WOOCOMMERCE_TIMEOUT_MS = '3000000000';
    expect(make()).toThrow('WOOCOMMERCE_TIMEOUT_MS');
    delete process.env.WOOCOMMERCE_TIMEOUT_MS;
    process.env.WOOCOMMERCE_MAX_CONCURRENCY = 'many';
    expect(make()).toThrow('WOOCOMMERCE_MAX_CONCURRENCY');
    delete process.env.WOOCOMMERCE_MAX_CONCURRENCY;
    process.env.WOOCOMMERCE_MAX_RESPONSE_BYTES = '10MB';
    expect(make()).toThrow('WOOCOMMERCE_MAX_RESPONSE_BYTES');
    delete process.env.WOOCOMMERCE_MAX_RESPONSE_BYTES;
    process.env.WOOCOMMERCE_ALLOW_PRIVATE_HOST = 'perhaps';
    expect(make()).toThrow('WOOCOMMERCE_ALLOW_PRIVATE_HOST');
    delete process.env.WOOCOMMERCE_ALLOW_PRIVATE_HOST;

    expect(make({ maxConcurrency: 0 })).toThrow('maxConcurrency');
    expect(make({ maxConcurrency: Number.NaN })).toThrow('maxConcurrency');
    expect(make({ timeoutMs: 2 ** 31 })).toThrow('timeoutMs');
    expect(make({ maxAttempts: 0 })).toThrow('maxAttempts');
  });
});

describe('error handling', () => {
  it('gives the status and our own hint, never the vendor body or code', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ code: 'invalid_key', message: 'Unrecognized key' }, 401));
    const error = await makeClient(fetchImpl).get('/x').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WooCommerceHttpError);
    expect((error as WooCommerceHttpError).status).toBe(401);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).toContain('Settings -> Advanced -> REST API');
    expect((error as Error).message).not.toContain('Unrecognized key');
    expect((error as Error).message).not.toContain('invalid_key');
  });

  it('never puts an error body in the error', async () => {
    const html = `<html>${'x'.repeat(5000)}</html>`;
    const fetchImpl = makeFetch(() => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }));
    const error = (await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: unknown) => e)) as WooCommerceHttpError;
    expect(error.message).toBe('WooCommerce API request failed with HTTP 502');
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
      .catch((e: unknown) => e)) as WooCommerceHttpError;
    expect(error).toBeInstanceOf(WooCommerceHttpError);
    expect(pulled).toBeLessThan(10);
    expect(error.message.length).toBeLessThan(700);
  });

  it('redacts the configured access token wherever it appears, before truncating', async () => {
    const accessToken = 'live-key-0123456789abcdef'; // gitleaks:allow (a test value, not a key)
    const respond = (body: string, type = 'text/plain') =>
      new WooCommerceClient({
        consumerKey: accessToken,
        consumerSecret: SECRET,
        shopUrl: SHOP,
        fetchImpl: makeFetch(() => new Response(body, { status: 400, headers: { 'content-type': type } })),
      });

    const echoed = (await respond(`proxy error: ${accessToken} and ${encodeURIComponent(accessToken)}`)
      .get('/x')
      .catch((e: unknown) => e)) as WooCommerceHttpError;
    expect(echoed.message).not.toContain(accessToken);
    expect(echoed.message).not.toContain('proxy error');

    const boundary = (await respond(`${'x'.repeat(490)}${accessToken}`)
      .get('/x')
      .catch((e: unknown) => e)) as WooCommerceHttpError;
    expect(boundary.message).not.toContain(accessToken.slice(0, 6));

    const nested = (await respond(JSON.stringify({ message: 'bad', nested: { echo: accessToken } }), 'application/json')
      .get('/x')
      .catch((e: unknown) => e)) as WooCommerceHttpError;
    expect(JSON.stringify(nested)).not.toContain(accessToken);

    expect(redactSecrets('X-API-KEY: abc123')).not.toContain('abc123');
    expect(redactSecrets('Authorization: Bearer abc123')).not.toContain('abc123');
    expect(redactSecrets('WOOCOMMERCE_CONSUMER_SECRET=abc123')).not.toContain('abc123');
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
      .get('/customers', { cursor: 'secret-cursor' })
      .catch((e: unknown) => e)) as WooCommerceHttpError;
    expect(error.url).toBe(`${BASE}/customers`);
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
    expect(message).toMatch(/Network error calling the WooCommerce API \(GET\) \(ENOTFOUND\)\./);
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
      .get('/customers')
      .catch((e: Error) => e.message);
    expect(message).toContain('redirect (HTTP 302) for GET');
    expect(message).toContain('WOOCOMMERCE_SHOP_URL');
    // The Location is the vendor's text: never quoted.
    expect(message).not.toContain('other.vendor.test');
    await expect(makeClient(fetchImpl).post('/orders/1/notes', {})).rejects.toThrow(/redirect/);
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
      .catch((e: unknown) => e)) as WooCommerceHttpError;

    expect(error).toBeInstanceOf(WooCommerceHttpError);
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

  it('never retries POST or PUT', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503));
    const client = makeClient(fetchImpl);
    await expect(client.post('/orders/1/notes', {})).rejects.toBeInstanceOf(WooCommerceHttpError);
    await expect(client.put('/customers/21', {})).rejects.toBeInstanceOf(WooCommerceHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const failing = makeFetch(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    });
    await expect(makeClient(failing).post('/orders/1/notes', {})).rejects.toThrow('Network error');
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
    await expect(client.get('/x')).rejects.toBeInstanceOf(WooCommerceHttpError);
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

  /** A local shop; the client is given its address with allowPrivateHost, and talks to `${shop}/wp-json/wc/v3`. */
  async function startUpstream(handler: Parameters<typeof createHttpServer>[1]): Promise<string> {
    upstream = createHttpServer(handler);
    await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  }

  it('sends the key, refuses a redirect and does not contact the redirect target', async () => {
    const seen: Array<{ url?: string; key?: string }> = [];
    const base = await startUpstream((req, res) => {
      seen.push({ url: req.url, key: req.headers[API_KEY_HEADER.toLowerCase()] as string | undefined });
      if (req.url === '/wp-json/wc/v3/customers/1') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":1}');
        return;
      }
      res.writeHead(302, { location: `${base}/wp-json/wc/v3/customers/1` }).end();
    });
    const client = new WooCommerceClient({ consumerKey: 'local-key-123456', consumerSecret: 'local-secret', shopUrl: base, allowPrivateHost: true });
    const basic = `Basic ${Buffer.from('local-key-123456:local-secret').toString('base64')}`;

    await expect(client.get('/customers/1')).resolves.toEqual({ id: 1 });
    await expect(client.get('/moved')).rejects.toThrow('redirects are not followed');
    expect(seen).toEqual([
      { url: '/wp-json/wc/v3/customers/1', key: basic },
      { url: '/wp-json/wc/v3/moved', key: basic },
    ]);
  });

  it('times out a stalled upstream', async () => {
    const base = await startUpstream(() => {
      // never answers
    });
    const client = new WooCommerceClient({ consumerKey: 'k', consumerSecret: 's', shopUrl: base, allowPrivateHost: true, timeoutMs: 100, maxAttempts: 1 });
    await expect(client.get('/slow')).rejects.toThrow(/timed out after 100 ms/);
    upstream?.closeAllConnections();
  });
});
