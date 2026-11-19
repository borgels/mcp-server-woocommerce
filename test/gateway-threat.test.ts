// The rest of the threat model (README, "Threat model"), through callTool: a key that is a number and pieces of it in
// numbers, an error while reading a successful body, failures reported inside a successful body, and a result too
// deep to serialise naively. Every result must still be valid JSON.
import { describe, expect, it, vi } from 'vitest';
import { createWooCommerceGateway } from '../src/gateway.js';
import { BASE, SECRET, SHOP } from './helpers.js';

const KEY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const DEEP = 20_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failingBody = (message: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(new Error(message));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function stub(key: string): typeof fetch {
  return async input => {
    const path = (String(input).split('?')[0] ?? '').slice(BASE.length);
    switch (path) {
      case '/orders/13':
        return json({ id: 13, status: 'processing', line_items: [{ id: 1, quantity: Number(key) }, { id: 2, quantity: Number(key.slice(1, 7)) }] });
      case '/customers/14':
        // The vendor's text and a piece of the key shorter than six characters.
        return failingBody(`Vendor diagnostic ${key.slice(0, 5)}`);
      case '/customers/9':
        return json({
          id: 9,
          first_name: {
              metadata: { status: 401, error: `Vendor diagnostic ${key}` },
              failures: [{ status: 403, error: 'Vendor detail' }, { error: 'Vendor text' }],
            },
        });
      case '/customers/10':
        return new Response(`{"id":10,"extra":${'['.repeat(DEEP)}1${']'.repeat(DEEP)}}`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      default:
        return json({ message: 'no stub' }, 404);
    }
  };
}

describe('the threat model, through callTool', () => {
  it('redacts a numeric key and its pieces in numbers, and the result stays valid JSON', async () => {
    const key = '1234567890123456';
    const records: unknown[] = [];
    const gw = createWooCommerceGateway({ consumerKey: key, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: stub(key), maxAttempts: 1, policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('get_order', { orderId: 13 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      id: 13,
      status: 'processing',
      line_items: [{ id: 1, quantity: '‹redacted›' }, { id: 2, quantity: '‹redacted›' }],
    });
    const serialised = JSON.stringify(result);
    expect(JSON.parse(serialised)).toEqual(result);
    expect(serialised).not.toMatch(/234567|12345678/);
    expect(JSON.stringify(records)).not.toMatch(/234567|12345678/);
  });

  it('turns an error while reading a successful body into a fixed text, for the host and the audit', async () => {
    const records: unknown[] = [];
    const gw = createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: stub(KEY), maxAttempts: 1, policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('get_customer', { customerId: 14 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('The WooCommerce API response could not be read.');
    for (const value of [result, records]) {
      expect(JSON.stringify(value)).not.toContain('Vendor');
      expect(JSON.stringify(value)).not.toContain(JSON.stringify(KEY.slice(0, 5)).slice(1, -1));
    }
  });

  it('refuses a failure object where data should be, with our own text and nothing of the vendor', async () => {
    const gw = createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: stub(KEY), maxAttempts: 1 });
    const result = await gw.callTool('get_customer', { customerId: 9 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('without the expected data');
    expect(JSON.stringify(result)).not.toContain('Vendor');
  });

  it('answers a very deep result without exhausting the stack', async () => {
    const gw = createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: stub(KEY), maxAttempts: 1, maxResponseBytes: 1_000_000 });
    const result = await gw.callTool('get_customer', { customerId: 10 });
    expect(result.isError).toBeUndefined();
    // The deep field is not in the customer schema and is dropped.
    expect(result.structuredContent).toEqual({ id: 10 });
  });
});

describe('round 5 of the threat model, through callTool', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses a key that overlaps the redaction marker, and redacts one that looks like the old marker', async () => {
    for (const accessToken of ['‹redacted›-0123456789', 'my-redacted-value', 'xx-dacted›-yy']) {
      expect(() => createWooCommerceGateway({ consumerKey: accessToken, consumerSecret: SECRET, shopUrl: SHOP }), accessToken).toThrow(/key was refused/);
    }
    const LOOKALIKE = '[REDACTED]-0123456789';
    const records: unknown[] = [];
    const gw = createWooCommerceGateway({
      consumerKey: LOOKALIKE,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      maxAttempts: 1,
      fetchImpl: async () => json({ echo: LOOKALIKE, [LOOKALIKE]: 1 }),
      policy: { audit: r => void records.push(r) },
    });
    const result = await gw.callTool('get_customer', { customerId: LOOKALIKE }, { caller: LOOKALIKE });
    const text = JSON.stringify([result, records]);
    for (const piece of pieces(LOOKALIKE)) expect(text, piece).not.toContain(piece);
  });

  it('keeps only the status of a failure object, on reads and on add_order_note', async () => {
    const body = {
      metadata: { status: 401, error: 'Vendor diagnostic', message: 'Vendor message', code: 'VENDOR_CODE', detail: { more: 'Vendor' } },
      failures: [{ error: 'Vendor text', hint: 'Vendor hint' }],
    };
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      maxAttempts: 1,
      fetchImpl: async (_input, init) =>
        init?.method === 'POST' ? json({ ...body, id: 2, note: 'ok', customer_note: false }, 201) : json({ ...body, id: 11, first_name: 'ok' }),
      policy: { enableWrites: true },
    });
    for (const result of [await gw.callTool('get_customer', { customerId: 11 }), await gw.callTool('add_order_note', { orderId: 1, note: 'n' })]) {
      expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(/Vendor|VENDOR|metadata|failures/);
    }
  });

  it('gives our own text when the body of a failed response cannot be read', async () => {
    const records: unknown[] = [];
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`Vendor diagnostic ${KEY.slice(0, 5)}`));
            },
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      policy: { audit: r => void records.push(r) },
    });
    const result = await gw.callTool('get_customer', { customerId: 11 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^WooCommerce API request failed with HTTP 500/);
    expect(JSON.stringify([result, records])).not.toContain('Vendor');
  });

  it('redacts an audit sink failure before it reaches stderr', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      written.push(String(chunk));
      return true;
    });
    try {
      const gw = createWooCommerceGateway({
        consumerKey: KEY,
        consumerSecret: SECRET,
        shopUrl: SHOP,
        maxAttempts: 1,
        fetchImpl: async () => json({ id: 11, first_name: 'ok' }),
        policy: {
          audit: () => {
            throw new Error(`sink failed for ${KEY}`);
          },
        },
      });
      const result = await gw.callTool('get_customer', { customerId: 11 });
      expect(result.isError).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const text = written.join('');
    expect(text).toContain('audit log write failed');
    for (const piece of pieces(KEY)) expect(text, piece).not.toContain(piece);
  });
});

describe('round 6 of the threat model', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses keys that collide with our own texts, without repeating them', () => {
    for (const accessToken of ['[nested too deep]-0123456789', 'woocommerce-mcp-0123456789', 'WOOCOMMERCE_SHOP_URL-0123456789']) {
      let message = '';
      try {
        createWooCommerceGateway({ consumerKey: accessToken, consumerSecret: SECRET, shopUrl: SHOP });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, accessToken).toMatch(/key was refused/);
      for (const piece of pieces(accessToken)) expect(message, piece).not.toContain(piece);
    }
  });

  it('sends a construction error through the redactor, configuration values included', () => {
    const HOSTLIKE = 'qz7hn4vb8lw2jx6pz9';
    let message = '';
    try {
      createWooCommerceGateway({ consumerKey: HOSTLIKE, consumerSecret: SECRET, shopUrl: `https://${HOSTLIKE}.vendor.example/x?y=${HOSTLIKE}`, policy: {} });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const piece of pieces(HOSTLIKE)) expect(message, piece).not.toContain(piece);
  });

  it('reduces failures without an error field, by status or in a failure context', async () => {
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      maxAttempts: 1,
      fetchImpl: async () =>
        json({
          id: 11,
          first_name: 'ok',
          failures: [{ status: 403, message: 'Vendor diagnostic' }],
          metadata: { status: 401, error: null, message: 'Vendor diagnostic' },
          errors: [{ message: 'Vendor diagnostic' }],
        }),
    });
    const result = await gw.callTool('get_customer', { customerId: 11 });
    expect(result.structuredContent).toEqual({ id: 11, first_name: 'ok' });
    expect(JSON.stringify(result)).not.toContain('Vendor');
  });

  it('names a network error code only from the fixed list', async () => {
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      maxAttempts: 1,
      fetchImpl: async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'VENDOR_DIAGNOSTIC' }) });
      },
    });
    const result = await gw.callTool('get_customer', { customerId: 11 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('VENDOR_DIAGNOSTIC');
  });
});
