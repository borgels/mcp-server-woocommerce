// Failure metadata on gateway error results: the upstream API's HTTP status and its request id (a UUID or hex id
// only), for a host that counts failures without reading their text. Never the body, the vendor's code or message.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failureMetadata, WooCommerceHttpError, requestIdFrom, vendorRequestId } from '../src/errors.js';
import { createWooCommerceGateway } from '../src/gateway.js';
import { BASE, SECRET, SHOP } from './helpers.js';

const KEY = 'tttt-gggg-wwww-vvvv-1';
const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('WOOCOMMERCE_')) delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function gatewayAnswering(status: number, headers: Record<string, string>, body: unknown = { message: 'Order of Jane Doe not found', code: 'E_NOPE' }) {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })) as typeof fetch;
  return createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl, retryBudgetMs: 0 });
}

describe('vendorRequestId', () => {
  it('keeps a UUID and a hex id', () => {
    expect(vendorRequestId(UUID)).toBe(UUID);
    expect(vendorRequestId(` ${UUID} `)).toBe(UUID);
    expect(vendorRequestId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718');
    expect(vendorRequestId('ABCDEF12-3456')).toBe('ABCDEF12-3456');
    expect(vendorRequestId('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('drops anything that could be text, and the shape of a personal number', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc123',
      'Jane Doe',
      'jane@example.com',
      'req_8f3a9c2d1e',
      'deadbeef deadbeef',
      '0101901234',
      'ab-010190-1234-cd',
      'f'.repeat(65),
      '-abcdef12',
      'abcdef12-',
      'a-------',
      'abc--def',
      'abcd--ef12',
      'abcdef12-ab',
      'abcdef1',
      'abcdef12-'.repeat(8),
    ]) {
      expect(vendorRequestId(value)).toBeUndefined();
    }
  });

  it('reads the first header that has an id in the right form', () => {
    expect(requestIdFrom(new Headers({ 'x-request-id': 'not an id', 'request-id': UUID }))).toBe(UUID);
    expect(requestIdFrom(new Headers({ 'x-correlation-id': 'deadbeefcafe' }))).toBe('deadbeefcafe');
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }))).toBeUndefined();
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }), ['x-vendor-id'])).toBe(UUID);
  });

  it('gives metadata for an HTTP error only', () => {
    expect(failureMetadata(new WooCommerceHttpError({ status: 404, url: `${BASE}/orders/1`, requestId: UUID }))).toEqual({
      httpStatus: 404,
      requestId: UUID,
    });
    expect(failureMetadata(new WooCommerceHttpError({ status: 500, url: `${BASE}/orders/1`, requestId: 'Jane Doe' }))).toEqual({
      httpStatus: 500,
    });
    expect(failureMetadata(new Error('boom'))).toBeUndefined();
    expect(failureMetadata('boom')).toBeUndefined();
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the request id, never the body', async () => {
    const result = await gatewayAnswering(404, { 'x-request-id': UUID }).callTool('get_order', { orderId: 1 });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('E_NOPE');
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const result = await gatewayAnswering(422, { 'x-request-id': 'Jane Doe <jane@example.com>' }).callTool('get_order', {
      orderId: 1,
    });
    expect(result.failure).toEqual({ httpStatus: 422 });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('drop a request id that holds a piece of the key', async () => {
    // The key's own hex-looking piece as the id: redaction changes it, and the changed value is no id.
    const fetchImpl = (async () =>
      new Response('{}', { status: 500, headers: { 'x-request-id': 'deadbeef00112233' } })) as typeof fetch;
    const gw = createWooCommerceGateway({ consumerKey: 'deadbeef00112233-key-0', consumerSecret: SECRET, shopUrl: SHOP, fetchImpl, retryBudgetMs: 0 });
    const result = await gw.callTool('get_order', { orderId: 1 });
    expect(result.failure).toEqual({ httpStatus: 500 });
    expect(JSON.stringify(result)).not.toContain('deadbeef0011');
  });

  it('have no metadata when the cause is not the upstream API', async () => {
    const gw = gatewayAnswering(200, {});
    expect((await gw.callTool('get_order', {})).failure).toBeUndefined();
    expect((await gw.callTool('no_such_tool', {})).failure).toBeUndefined();
    const offline = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      retryBudgetMs: 0,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect((await offline.callTool('get_order', { orderId: 1 })).failure).toBeUndefined();
  });

  it('are absent on a successful result', async () => {
    const result = await gatewayAnswering(200, { 'x-request-id': UUID }, { id: 1, status: 'processing' }).callTool('get_order', {
      orderId: 1,
    });
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});
