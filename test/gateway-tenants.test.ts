import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_KEY_HEADER, WooCommerceClient } from '../src/woocommerce/client.js';
import { createWooCommerceGateway, wooCommerceGatewayTools, wooCommerceToolCatalog, type GatewayJsonObject } from '../src/gateway.js';
import { WOOCOMMERCE_TOOLS, pseudonym } from '../src/tools/woocommerce.js';
import { BASE, auditLines, connect, stubFetch, texts, SECRET, SHOP } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'woocommerce-mcp-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('WOOCOMMERCE_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Placeholder credentials, built at runtime: long enough to be redacted by value. */
const fakeKey = (label: string) => `${label}-${'x'.repeat(12)}`;
// Keys with no piece of six characters in common: the redactor also removes any such piece of its own key.
const KEY_A = 'omega-0123456789-kq'; // gitleaks:allow (a test value, not a key)
const KEY_B = 'bravo-zyxwvutsrq-MP';
const ENV_KEY = 'envkey-ABCDEFGHIJ-77';

/** Upstream that answers every request with an error body echoing `echo`. */
function echoingFetch(echo: string) {
  return vi.fn(
    async () =>
      new Response(`upstream rejected credentials ${echo}`, { status: 400, headers: { 'content-type': 'text/plain' } }),
  ) as unknown as typeof fetch;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('explicit gateway credentials', () => {
  it('requires the key, the secret and the shop address, and ignores the environment', () => {
    process.env.WOOCOMMERCE_CONSUMER_KEY = ENV_KEY;
    process.env.WOOCOMMERCE_CONSUMER_SECRET = SECRET;
    process.env.WOOCOMMERCE_SHOP_URL = SHOP;

    expect(() => createWooCommerceGateway({ consumerSecret: SECRET, shopUrl: SHOP } as never)).toThrow(/requires options\.consumerKey/);
    expect(() => createWooCommerceGateway({ consumerKey: '  ', consumerSecret: SECRET, shopUrl: SHOP })).toThrow(/requires options\.consumerKey/);
    expect(() => createWooCommerceGateway({ consumerKey: KEY_A, shopUrl: SHOP } as never)).toThrow(/requires options\.consumerSecret/);
    expect(() => createWooCommerceGateway({ consumerKey: KEY_A, consumerSecret: SECRET } as never)).toThrow(/requires options\.shopUrl/);
    expect(() => createWooCommerceGateway(undefined as never)).toThrow(/requires options\.consumerKey/);
  });

  it('never lets an embedded instance reach a private address, whatever its options say', () => {
    expect(() =>
      createWooCommerceGateway({ consumerKey: KEY_A, consumerSecret: SECRET, shopUrl: 'http://127.0.0.1:8080', allowPrivateHost: true } as never),
    ).toThrow();
  });

  it('never reads credential variables from process.env, even when they are set', async () => {
    const reads = new Set<string>();
    const env = { ...process.env, WOOCOMMERCE_CONSUMER_KEY: ENV_KEY, WOOCOMMERCE_CONSUMER_SECRET: SECRET, WOOCOMMERCE_SHOP_URL: SHOP };
    process.env = new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.add(property);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => createWooCommerceGateway({ shopUrl: SHOP } as never)).toThrow(/requires options\.consumerKey/);

    const fetchImpl = stubFetch({ [`GET ${BASE}/customers/12`]: { body: { id: 12 } } });
    const gw = createWooCommerceGateway({ consumerKey: KEY_A, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await gw.callTool('get_customer', { customerId: 12 });
    expect(result.isError).toBeUndefined();
    expect(headersOf(fetchImpl.mock.calls[0]?.[1])[API_KEY_HEADER]).toBe(`Basic ${Buffer.from(`${KEY_A}:${SECRET}`).toString('base64')}`);

    for (const name of ['WOOCOMMERCE_CONSUMER_KEY', 'WOOCOMMERCE_CONSUMER_SECRET', 'WOOCOMMERCE_SHOP_URL']) expect(reads.has(name)).toBe(false);
  });

  it('still reads credentials from the environment in the standalone client', async () => {
    process.env.WOOCOMMERCE_CONSUMER_KEY = ENV_KEY;
    process.env.WOOCOMMERCE_CONSUMER_SECRET = SECRET;
    process.env.WOOCOMMERCE_SHOP_URL = SHOP;
    const fetchImpl = vi.fn(async () => Response.json({})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    await new WooCommerceClient({ fetchImpl }).get('/customers/1');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${BASE}/customers/1`);
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit)[API_KEY_HEADER]).toBe(`Basic ${Buffer.from(`${ENV_KEY}:${SECRET}`).toString('base64')}`);
  });
});

describe('per-instance redaction', () => {
  it('redacts each instance’s own key in its tool results', async () => {
    const a = createWooCommerceGateway({ consumerKey: KEY_A, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: echoingFetch(KEY_A) });
    const b = createWooCommerceGateway({ consumerKey: KEY_B, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: echoingFetch(KEY_B) });

    const resultA = texts(await a.callTool('get_customer', { customerId: 12 })).join(' ');
    const resultB = texts(await b.callTool('get_customer', { customerId: 12 })).join(' ');
    // The echoing error body is never read into the result; the key is not there in any form.
    expect(resultA).not.toContain(KEY_A);
    expect(resultB).not.toContain(KEY_B);
  });

  it('keeps redactors separate: an instance holds only its own secrets', () => {
    const a = new WooCommerceClient({ consumerKey: KEY_A, consumerSecret: SECRET, shopUrl: SHOP, credentialEnv: {} });
    const b = new WooCommerceClient({ consumerKey: KEY_B, consumerSecret: SECRET, shopUrl: SHOP, credentialEnv: {} });
    expect(a.redactor.hasSecret(KEY_A)).toBe(true);
    expect(a.redactor.hasSecret(KEY_B)).toBe(false);
    expect(b.redactor.hasSecret(KEY_B)).toBe(true);
    expect(b.redactor.hasSecret(KEY_A)).toBe(false);
    // B neither knows nor needs A's key: its text is only redacted for its own.
    expect(b.redactor.redact(`a=${KEY_A} b ${KEY_B}`)).toBe(`a=${KEY_A} b ‹redacted›`);
  });

  it('does not accumulate keys of earlier instances', () => {
    for (let index = 0; index < 200; index += 1) {
      createWooCommerceGateway({ consumerKey: `short-lived-key-${index}`, consumerSecret: SECRET, shopUrl: SHOP });
    }
    const fresh = new WooCommerceClient({ consumerKey: KEY_A, consumerSecret: SECRET, shopUrl: SHOP, credentialEnv: {} });
    expect(fresh.redactor.redact('short-lived-key-7')).toBe('short-lived-key-7');
  });

  it('redacts audit records with the key of the instance that ran the call', async () => {
    process.env.WOOCOMMERCE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const failing = (key: string) =>
      vi.fn(async () => {
        throw new TypeError(`connection refused while sending ${key}`);
      }) as unknown as typeof fetch;
    const a = createWooCommerceGateway({ consumerKey: KEY_A, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: failing(KEY_A), maxAttempts: 1 });
    const b = createWooCommerceGateway({ consumerKey: KEY_B, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: failing(KEY_B), maxAttempts: 1 });
    await a.callTool('get_customer', { customerId: 12 }, { requestId: 'a' });
    await b.callTool('get_customer', { customerId: 12 }, { requestId: 'b' });

    const errors = auditLines(process.env.WOOCOMMERCE_AUDIT_LOG).filter(line => line.action === 'error');
    expect(errors.map(line => line.requestId)).toEqual([pseudonym('a'), pseudonym('b')]);
    const log = JSON.stringify(errors);
    expect(log).not.toContain(KEY_A);
    expect(log).not.toContain(KEY_B);
  });

  it('redacts with the server client’s key on the MCP path', async () => {
    const tool = WOOCOMMERCE_TOOLS.find(t => t.name === 'woocommerce_get_customer')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed with test-api-key');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'woocommerce_get_customer', arguments: { customerId: 12 } });
      expect(texts(result).join(' ')).not.toContain('test-api-key');
    } finally {
      tool.handler = original;
    }
  });

  it('lets a dropped instance and its key be garbage collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let gateway: ReturnType<typeof createWooCommerceGateway> | undefined = createWooCommerceGateway({
      consumerKey: fakeKey('collectable'),
      consumerSecret: SECRET,
      shopUrl: SHOP,
    });
    const ref = new WeakRef(gateway);
    gateway = undefined;
    for (let attempt = 0; attempt < 10 && ref.deref(); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

/** Sample input per tool, used to check each tool's declared upstream requests. */
const SAMPLE_INPUTS: Record<string, GatewayJsonObject> = {
  check_connection: {},
  get_sales_report: { period: 'month' },
  list_orders: { status: 'processing', after: '2026-11-01' },
  get_order: { orderId: 12 },
  list_order_notes: { orderId: 12 },
  list_order_refunds: { orderId: 12 },
  list_products: { stock_status: 'outofstock' },
  get_product: { productId: 31 },
  list_customers: { search: 'a' },
  get_customer: { customerId: 21 },
  update_order_status: { orderId: 12, status: 'completed' },
  add_order_note: { orderId: 12, note: 'Packed' },
  record_refund: { orderId: 12, amount: 50, currency: 'DKK' },
  create_draft_product: { name: 'New product', regular_price: '100.00' },
  update_product: { productId: 31, stock_quantity: 4, manage_stock: true },
  update_customer: { customerId: 21, billing: { phone: '12345678' } },
};

/** Answers that let every tool run to its end: a processing order of 100 DKK, a sales report, the record asked for. */
async function catalogFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input)).pathname;
  const method = init?.method ?? 'GET';
  if (path.endsWith('/reports/sales')) return Response.json([{ total_sales: '100.00', net_sales: '80.00' }]);
  const orderId = /\/orders\/(\d+)$/.exec(path)?.[1];
  if (orderId) {
    const status = method === 'PUT' ? (JSON.parse(String(init?.body)) as { status: string }).status : 'processing';
    return Response.json({ id: Number(orderId), status, currency: 'DKK', total: '100.00', refunds: [], line_items: [] });
  }
  if (method === 'GET' && /\/orders$/.test(path)) return Response.json([{ id: 1, status: 'processing' }]);
  if (method === 'GET' && /\/(products|customers|notes|refunds)$/.test(path)) return Response.json([{ id: 1 }]);
  const recordId = /\/(\d+)$/.exec(path)?.[1];
  if (method === 'POST' && path.endsWith('/products')) return Response.json({ id: 1, status: 'draft' });
  if (method === 'POST' && path.endsWith('/notes')) return Response.json({ id: 1, customer_note: false });
  if (method === 'POST' && path.endsWith('/refunds')) {
    const { amount } = JSON.parse(String(init?.body)) as { amount: string };
    return Response.json({ id: 1, amount, refunded_payment: false });
  }
  return Response.json({ id: recordId ? Number(recordId) : 1 });
}

describe('tool catalog', () => {
  it('lists every registered tool, matching the gateway definitions', async () => {
    expect(wooCommerceToolCatalog.map(entry => entry.name)).toEqual(wooCommerceGatewayTools.map(tool => tool.name));
    for (const entry of wooCommerceToolCatalog) {
      const { upstream, broad, requiresConfirmation, change, ...definition } = entry;
      expect(typeof requiresConfirmation).toBe('boolean');
      expect(change === undefined).toBe(entry.riskLevel === 'read');
      if (requiresConfirmation) expect(entry.riskLevel).toBe('write');
      expect(typeof broad).toBe('boolean');
      if (broad) expect(entry.riskLevel).toBe('read');
      expect(definition).toEqual(wooCommerceGatewayTools.find(tool => tool.name === entry.name));
      expect(upstream.length).toBeGreaterThan(0);
      for (const operation of upstream) {
        expect(operation.access === 'read' ? operation.method === 'GET' : true).toBe(true);
        if (entry.riskLevel === 'read') {
          expect(operation.access).toBe('read');
        }
      }
    }

    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      wooCommerceToolCatalog.map(entry => `woocommerce_${entry.name}`).sort(),
    );
    for (const tool of tools) {
      const entry = wooCommerceToolCatalog.find(e => `woocommerce_${e.name}` === tool.name)!;
      expect(entry.title).toBe(tool.title);
      expect(entry.description).toBe(tool.description);
      expect(Object.keys(entry.inputSchema.properties as object).sort()).toEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
      );
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(wooCommerceToolCatalog)).toBe(true);
    const visit = (value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(visit);
      }
    };
    visit(wooCommerceToolCatalog);
    expect(() => {
      (wooCommerceToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow(TypeError);
  });

  it('declares exactly the upstream requests each tool makes', async () => {
    process.env.WOOCOMMERCE_ENABLE_WRITES = 'true';
    for (const entry of wooCommerceToolCatalog) {
      const input = SAMPLE_INPUTS[entry.name];
      expect(input, `sample input for ${entry.name}`).toBeDefined();
      const fetchImpl = vi.fn(catalogFetch);
      const gw = createWooCommerceGateway({ consumerKey: KEY_A, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: fetchImpl as unknown as typeof fetch });
      const result = await gw.callTool(entry.name, input!);
      expect(result.isError, `${entry.name}: ${texts(result).join(" ")}`).toBeUndefined();

      const declared = entry.upstream.map(op => ({
        method: op.method,
        path: op.path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(input![name] ?? ''))),
      }));
      const made = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => ({
        method: init.method,
        path: new URL(url).pathname.slice(new URL(BASE).pathname.length),
      }));
      for (const request of made) {
        expect(declared, `${entry.name} made ${request.method} ${request.path}`).toContainEqual(request);
      }
    }
  });
});
