// WooCommerce-specific behaviour, against answers shaped as the WooCommerce REST API v3 documentation shows them
// (https://woocommerce.github.io/woocommerce-rest-api-docs/: integer ids, money as strings, X-WP-Total headers,
// negative refund totals on an order). These are recorded from the documentation, not from a live shop: no
// WooCommerce shop was used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWooCommerceGateway,
  resolveWooCommerceChange,
  wooCommerceToolCatalog,
  type GatewayJsonObject,
} from '../src/gateway.js';
import { BASE, SECRET, SHOP } from './helpers.js';

const KEY = 'ck_tttt-gggg-wwww-vvvv-1';
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('WOOCOMMERCE_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

type Handler = (url: URL, init: RequestInit) => unknown;

/** A shop stand-in: routes by "METHOD /path" (path below /wp-json/wc/v3). An unknown route answers 404. */
function shop(routes: Record<string, unknown>, key = KEY) {
  const calls: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.slice(new URL(BASE).pathname.length);
    calls.push({ method, path, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    if (route === undefined) return Response.json({ code: 'woocommerce_rest_invalid_id', message: 'Invalid ID.' }, { status: 404 });
    const value = typeof route === 'function' ? (route as Handler)(url, init ?? {}) : route;
    if (value instanceof Response) return value;
    return Response.json(value);
  });
  const gw = createWooCommerceGateway({
    consumerKey: key,
    consumerSecret: SECRET,
    shopUrl: SHOP,
    maxAttempts: 1,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    policy: { enableWrites: true },
  });
  return { gw, calls, fetchImpl };
}

const withHeaders = (body: unknown, headers: Record<string, string>) => () => Response.json(body, { headers });

const call = (gw: ReturnType<typeof shop>['gw'], tool: string, input: GatewayJsonObject = {}) => gw.callTool(tool, input);

/** An order as the documentation shows one, with the fields this server leaves out. */
const ORDER = {
  id: 727,
  parent_id: 0,
  number: '727',
  order_key: 'wc_order_58d2d042d1d',
  created_via: 'rest-api',
  status: 'processing',
  currency: 'DKK',
  total: '100.00',
  total_tax: '20.00',
  customer_id: 21,
  customer_ip_address: '203.0.113.7',
  customer_user_agent: 'Mozilla/5.0',
  customer_note: 'Ring på',
  billing: { first_name: 'Jens', last_name: 'Jensen', email: 'jens@example.test', phone: '12345678', city: 'Aarhus' },
  shipping: { first_name: 'Jens', last_name: 'Jensen', city: 'Aarhus' },
  payment_method_title: 'Kort',
  transaction_id: 'txn_000000',
  cart_hash: 'abc',
  meta_data: [{ id: 1, key: '_secret_plugin_value', value: 'x' }],
  line_items: [{ id: 1, name: 'Kop', product_id: 31, quantity: 2, total: '80.00', meta_data: [{ key: 'k', value: 'v' }] }],
  shipping_lines: [],
  fee_lines: [],
  coupon_lines: [],
  refunds: [],
};

describe('reads', () => {
  it('checks the connection with one order and reports the total from X-WP-Total', async () => {
    const { gw, calls } = shop({ 'GET /orders': withHeaders([{ id: 1, status: 'processing' }], { 'X-WP-Total': '42', 'X-WP-TotalPages': '42' }) });
    const result = await call(gw, 'check_connection');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ connected: true, orders: 42 });
    expect(calls[0]?.query.get('per_page')).toBe('1');
  });

  it('lists orders with the documented filters, dates as the start of the day, 20 per page and the totals', async () => {
    const { gw, calls } = shop({ 'GET /orders': withHeaders([ORDER], { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' }) });
    const result = await call(gw, 'list_orders', { status: 'processing', customer: 21, after: '2026-11-01', orderby: 'date' });
    expect(result.isError).toBeUndefined();
    expect(Object.fromEntries(calls[0]!.query)).toEqual({
      status: 'processing',
      customer: '21',
      orderby: 'date',
      after: '2026-11-01T00:00:00',
      per_page: '20',
    });
    const { orders, paging } = result.structuredContent as { orders: Array<Record<string, unknown>>; paging: unknown };
    expect(paging).toEqual({ page: 1, perPage: 20, total: 1, totalPages: 1 });
    expect(orders[0]).toMatchObject({ id: 727, status: 'processing', total: '100.00', items: 1, billing: { first_name: 'Jens' } });
    expect(JSON.stringify(orders)).not.toMatch(/203\.0\.113|Mozilla|wc_order_|txn_|_secret_plugin|jens@/);
  });

  it('gives one order without IP address, browser, order key, cart hash, transaction id or meta data', async () => {
    const { gw } = shop({ 'GET /orders/727': ORDER });
    const result = await call(gw, 'get_order', { orderId: 727 });
    expect(result.isError).toBeUndefined();
    const text = JSON.stringify(result.structuredContent);
    expect(text).toContain('"customer_note":"Ring på"');
    expect(text).toContain('"line_items":[{"id":1,"name":"Kop","product_id":31,"quantity":2,"total":"80.00"}]');
    expect(text).not.toMatch(/203\.0\.113|Mozilla|wc_order_|txn_|cart_hash|_secret_plugin|meta_data/);
  });

  it('takes ids only as positive integers', async () => {
    const { gw, calls } = shop({});
    for (const orderId of ['727', 0, -1, 1.5, '../customers']) {
      expect((await call(gw, 'get_order', { orderId } as GatewayJsonObject)).isError, String(orderId)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('gives the sales report for a period or two dates, never both', async () => {
    const report = [{ total_sales: '1200.00', net_sales: '1000.00', total_orders: 12, totals_grouped_by: 'day', totals: {} }];
    const { gw, calls } = shop({ 'GET /reports/sales': report });
    expect((await call(gw, 'get_sales_report', { period: 'month' })).structuredContent).toMatchObject({ total_sales: '1200.00' });
    expect(calls.at(-1)?.query.get('period')).toBe('month');
    await call(gw, 'get_sales_report', { dateMin: '2026-11-01', dateMax: '2026-11-19' });
    expect(Object.fromEntries(calls.at(-1)!.query)).toEqual({ date_min: '2026-11-01', date_max: '2026-11-19' });
    const before = calls.length;
    for (const input of [{}, { period: 'month', dateMin: '2026-11-01' }, { dateMin: '2026-11-19', dateMax: '2026-11-01' }, { dateMin: '2026-11-01' }] as GatewayJsonObject[]) {
      expect((await call(gw, 'get_sales_report', input)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(before);
  });

  it('refuses an answer that is not shaped as documented, instead of leaving out what does not fit', async () => {
    const bad: Array<[string, GatewayJsonObject, Record<string, unknown>]> = [
      ['get_order', { orderId: 727 }, { 'GET /orders/727': {} }],
      ['get_order', { orderId: 727 }, { 'GET /orders/727': { id: '727' } }],
      ['get_order', { orderId: 727 }, { 'GET /orders/727': [ORDER] }],
      ['list_orders', {}, { 'GET /orders': [ORDER, null] }],
      ['list_orders', {}, { 'GET /orders': [ORDER, {}] }],
      ['list_orders', {}, { 'GET /orders': [null, 'bad', {}] }],
      ['list_orders', {}, { 'GET /orders': { orders: [] } }],
      ['list_order_notes', { orderId: 727 }, { 'GET /orders/727/notes': [{ note: 'x' }] }],
      ['get_sales_report', { period: 'week' }, { 'GET /reports/sales': [] }],
      ['get_sales_report', { period: 'week' }, { 'GET /reports/sales': [{}] }],
      ['add_order_note', { orderId: 727, note: 'x' }, { 'POST /orders/727/notes': {} }],
    ];
    for (const [tool, input, routes] of bad) {
      const result = await call(shop(routes).gw, tool, input);
      expect(result.isError, `${tool} ${JSON.stringify(routes)}`).toBe(true);
      expect(result.content[0]?.text).toContain('without the expected data');
    }
    expect((await call(shop({ 'GET /orders': [] }).gw, 'list_orders')).isError).toBeUndefined();
  });

  it('gives a customer without username, role or meta data', async () => {
    const { gw } = shop({
      'GET /customers/21': { id: 21, email: 'jens@example.test', first_name: 'Jens', username: 'jens', role: 'customer', meta_data: [{ key: 'k' }] },
    });
    const result = await call(gw, 'get_customer', { customerId: 21 });
    expect(result.structuredContent).toEqual({ id: 21, email: 'jens@example.test', first_name: 'Jens' });
  });
});

describe('writes', () => {
  it('are off unless the host enables them', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: 1 }));
    const gw = createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await gw.callTool('add_order_note', { orderId: 727, note: 'x' })).isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('adds a private note and never notifies the customer', async () => {
    const { gw, calls } = shop({ 'POST /orders/727/notes': { id: 5, note: 'Pakket', customer_note: false } });
    expect((await call(gw, 'add_order_note', { orderId: 727, note: 'Pakket' })).isError).toBeUndefined();
    expect(calls[0]?.body).toEqual({ note: 'Pakket', customer_note: false });
    expect((await call(gw, 'add_order_note', { orderId: 727, note: 'x', customer_note: true } as GatewayJsonObject)).isError).toBe(true);
  });

  it('changes an order status after reading it, and refuses the same status or a refunded, failed or deleted order', async () => {
    const { gw, calls } = shop({ 'GET /orders/727': ORDER, 'PUT /orders/727': { ...ORDER, status: 'completed' } });
    const result = await call(gw, 'update_order_status', { orderId: 727, status: 'completed' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ id: 727, number: '727', status: 'completed' });
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /orders/727', 'PUT /orders/727']);
    expect(calls[1]?.body).toEqual({ status: 'completed' });

    for (const status of ['processing', 'refunded', 'failed', 'trash']) {
      const { gw: other, calls: made } = shop({ 'GET /orders/727': { ...ORDER, status } });
      expect((await call(other, 'update_order_status', { orderId: 727, status: 'processing' })).isError, status).toBe(true);
      expect(made.some(c => c.method === 'PUT'), status).toBe(false);
    }
    for (const status of ['refunded', 'pending', 'failed', 'trash']) {
      expect((await call(gw, 'update_order_status', { orderId: 727, status })).isError, status).toBe(true);
    }
  });

  const refundRoutes = (order: Record<string, unknown>) => ({
    'GET /orders/727': { ...ORDER, ...order },
    'POST /orders/727/refunds': { id: 9, amount: '50.00', reason: '', refunded_payment: false },
  });

  it('records a refund in the shop without asking the payment gateway to pay it back, and without restocking', async () => {
    const { gw, calls } = shop(refundRoutes({}));
    const result = await call(gw, 'record_refund', { orderId: 727, amount: 50, currency: 'DKK', reason: 'Defekt' });
    expect(result.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/orders/727/refunds',
      body: { amount: '50.00', reason: 'Defekt', api_refund: false, api_restock: false },
    });
    expect(result.structuredContent).toEqual({ id: 9, amount: '50.00', reason: '', refunded_payment: false });
  });

  it.each([
    ['more than is left after earlier refunds', { refunds: [{ id: 1, total: '-60.00' }] }, 50.01],
    ['more than the order total', {}, 100.01],
    ['a pending order', { status: 'pending' }, 10],
    ['a refunded order', { status: 'refunded' }, 10],
    ['another currency', { currency: 'EUR' }, 10],
    ['an order without a known currency', { currency: undefined }, 10],
    ['an order without a total', { total: undefined }, 10],
    ['an order without its refunds list', { refunds: undefined }, 10],
    ['an order with a refund that is not one', { refunds: [{ id: 1 }] }, 10],
    ['an order with a refund entry that is not a record', { refunds: [null] }, 10],
  ])('refuses a refund of %s without sending it', async (_name, order, amount) => {
    const { gw, calls } = shop(refundRoutes(order));
    const result = await call(gw, 'record_refund', { orderId: 727, amount, currency: 'DKK' });
    expect(result.isError).toBe(true);
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('accepts a refund of exactly what is left', async () => {
    const { gw, calls } = shop(refundRoutes({ refunds: [{ id: 1, total: '-60.00' }] }));
    expect((await call(gw, 'record_refund', { orderId: 727, amount: 40, currency: 'DKK' })).isError).toBeUndefined();
    expect(calls.at(-1)?.body).toMatchObject({ amount: '40.00' });
  });

  it('refuses amounts that are not positive with at most two decimals, and an api_refund given by the caller', async () => {
    const { gw, calls } = shop(refundRoutes({}));
    for (const input of [
      { orderId: 727, amount: 0, currency: 'DKK' },
      { orderId: 727, amount: -5, currency: 'DKK' },
      { orderId: 727, amount: 1.005, currency: 'DKK' },
      { orderId: 727, amount: 5, currency: 'dkk' },
      { orderId: 727, amount: 5, currency: 'DKK', api_refund: true },
      { orderId: 727, amount: 5, currency: 'DKK', api_restock: true },
    ] as GatewayJsonObject[]) {
      expect((await call(gw, 'record_refund', input)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('records one refund of an order at a time per shop, whichever key the call came through', async () => {
    let refunded = 0;
    const posts: unknown[] = [];
    const routes = {
      'GET /orders/727': () => ({ ...ORDER, refunds: refunded ? [{ id: 1, total: `-${refunded.toFixed(2)}` }] : [] }),
      'POST /orders/727/refunds': (_url: URL, init: RequestInit) => {
        posts.push(init.body);
        refunded += 100;
        return { id: posts.length, amount: '100.00' };
      },
    };
    const one = shop(routes, 'ck_one_aaaa-bbbb-cccc');
    const two = shop(routes, 'ck_two_dddd-eeee-ffff');
    const input = { orderId: 727, amount: 100, currency: 'DKK' };
    const results = await Promise.all([call(one.gw, 'record_refund', input), call(two.gw, 'record_refund', input)]);
    expect(results.map(result => result.isError).sort()).toEqual([true, undefined]);
    expect(posts).toHaveLength(1);
  });

  it('creates a product only as a simple draft', async () => {
    const { gw, calls } = shop({ 'POST /products': { id: 31, name: 'Kop', status: 'draft', type: 'simple', regular_price: '49.00' } });
    const result = await call(gw, 'create_draft_product', { name: 'Kop', regular_price: '49.00', sku: 'KOP-1' });
    expect(result.isError).toBeUndefined();
    expect(calls[0]?.body).toEqual({ name: 'Kop', sku: 'KOP-1', regular_price: '49.00', type: 'simple', status: 'draft' });
    expect((await call(gw, 'create_draft_product', { name: 'Kop', status: 'publish' } as GatewayJsonObject)).isError).toBe(true);
    expect((await call(gw, 'create_draft_product', { name: 'Kop', regular_price: '49,00' })).isError).toBe(true);
  });

  it('updates only the product fields given, and needs at least one', async () => {
    const { gw, calls } = shop({ 'PUT /products/31': { id: 31, stock_quantity: 4 } });
    expect((await call(gw, 'update_product', { productId: 31, stock_quantity: 4, manage_stock: true })).isError).toBeUndefined();
    expect(calls[0]?.body).toEqual({ manage_stock: true, stock_quantity: 4 });
    expect((await call(gw, 'update_product', { productId: 31 })).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('updates a customer’s name and addresses, never the e-mail, password or role', async () => {
    const { gw, calls } = shop({ 'PUT /customers/21': { id: 21, first_name: 'Jens' } });
    expect((await call(gw, 'update_customer', { customerId: 21, billing: { phone: '87654321', city: 'Aarhus' } })).isError).toBeUndefined();
    expect(calls[0]?.body).toEqual({ billing: { city: 'Aarhus', phone: '87654321' } });
    for (const input of [
      { customerId: 21, email: 'new@example.test' },
      { customerId: 21, password: 'x' },
      { customerId: 21, role: 'administrator' },
      { customerId: 21, billing: { email: 'new@example.test' } },
      { customerId: 21 },
    ] as GatewayJsonObject[]) {
      expect((await call(gw, 'update_customer', input)).isError, JSON.stringify(input)).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });

  it('declares only writes the client allows, and no delete, batch, coupon or setting', () => {
    const writes = wooCommerceToolCatalog.flatMap(entry => entry.upstream.filter(op => op.access === 'write'));
    for (const operation of writes) {
      expect(['POST', 'PUT']).toContain(operation.method);
      expect(operation.path).toMatch(/^\/(orders\/\{orderId\}(\/notes|\/refunds)?|products(\/\{productId\})?|customers\/\{customerId\})$/);
    }
  });
});

describe('change resolution for a host log', () => {
  it('gives ids, amounts and the currency in clear, the SKU as a pseudonym, and no note, reason or name', () => {
    const refund = resolveWooCommerceChange('record_refund', { orderId: 727, amount: 50.5, currency: 'DKK', reason: 'Jens Jensen ringede' });
    expect(refund).toEqual({
      ok: true,
      change: {
        tool: 'record_refund',
        action: 'record_refund',
        record: 'refund',
        movesMoney: false,
        requiresConfirmation: true,
        values: { orderId: 727, amount: 50.5, currency: 'DKK' },
      },
    });

    const product = resolveWooCommerceChange('create_draft_product', { name: 'Hemmelig kop', sku: 'KOP-1' }, { pseudonymKey: 'host-key' });
    expect(product.ok && product.change.values).toEqual({ sku: expect.stringMatching(/^hmac:[0-9a-f]{16}$/) });
    expect(JSON.stringify(product)).not.toMatch(/Hemmelig|KOP-1/);

    const note = resolveWooCommerceChange('add_order_note', { orderId: 727, note: 'Jens Jensen' });
    expect(note.ok && note.change.values).toEqual({ orderId: 727 });

    const customer = resolveWooCommerceChange('update_customer', { customerId: 21, first_name: 'Jens' });
    expect(JSON.stringify(customer)).not.toContain('Jens');

    expect(resolveWooCommerceChange('list_orders', {})).toEqual({ ok: false, reason: 'list_orders is not a write tool.' });
    expect(resolveWooCommerceChange('update_product', { productId: 31 })).toEqual({ ok: false, reason: 'Invalid input for update_product.' });
    expect(resolveWooCommerceChange('get_sales_report', {}).ok).toBe(false);
    expect(resolveWooCommerceChange('delete_order', {}).ok).toBe(false);
  });

  it('marks only record_refund as needing a person to confirm', () => {
    expect(wooCommerceToolCatalog.filter(entry => entry.requiresConfirmation).map(entry => entry.name)).toEqual(['record_refund']);
  });
});

describe('audit', () => {
  it('logs a rejected call with a fixed code, known field names and a pseudonym for an unknown tool', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: (async () => Response.json({})) as typeof fetch,
      policy: { audit: record => void records.push({ ...record }) },
    });
    await gw.callTool('Jens Jensen', { 'Anna Hansen': 1 });
    await gw.callTool('get_customer', { customerId: 21, 'Anna Hansen': 1 });
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/Jens|Anna/);
    expect(records[0]).toMatchObject({ tool: 'unknown', action: 'rejected', reason: 'unknown_tool', target: { fields: [], otherFields: 1 } });
    expect((records[0]?.target as Record<string, unknown>).toolPseudonym).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(records[1]).toMatchObject({ tool: 'woocommerce_get_customer', reason: 'invalid_input', target: { fields: ['customerId'], otherFields: 1 } });
  });

  it('logs ids and amounts of a refund, never its reason, and hashes a search', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      maxAttempts: 1,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (init?.method === 'POST') return Response.json({ id: 9, amount: '50.00' });
        if (path.endsWith('/orders/727')) return Response.json(ORDER);
        return Response.json([]);
      }) as typeof fetch,
      policy: { enableWrites: true, audit: record => void records.push({ ...record }) },
    });
    await gw.callTool('record_refund', { orderId: 727, amount: 50, currency: 'DKK', reason: 'Jens Jensen ringede' });
    await gw.callTool('list_customers', { search: 'Anna Hansen' });
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/Jens|Anna/);
    expect(records[0]?.target).toEqual({ orderId: 727, amount: 50, currency: 'DKK' });
    const search = records.find(record => record.tool === 'woocommerce_list_customers')?.target as Record<string, unknown>;
    expect(search.searchSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('after review 1', () => {
  it('refuses a record with another id than asked for, a field of the wrong type, and an invalid sub-item', async () => {
    const bad: Array<[string, GatewayJsonObject, Record<string, unknown>]> = [
      ['get_order', { orderId: 727 }, { 'GET /orders/727': { ...ORDER, id: 728 } }],
      ['get_order', { orderId: 727 }, { 'GET /orders/727': { ...ORDER, status: { nested: 'x', more: { deeper: 1 } } } }],
      ['get_order', { orderId: 727 }, { 'GET /orders/727': { ...ORDER, total: { amount: 1 } } }],
      ['get_order', { orderId: 727 }, { 'GET /orders/727': { ...ORDER, billing: { first_name: { x: 1 } } } }],
      ['get_order', { orderId: 727 }, { 'GET /orders/727': { ...ORDER, line_items: [ORDER.line_items[0], { name: 'no id' }] } }],
      ['get_order', { orderId: 727 }, { 'GET /orders/727': { ...ORDER, line_items: [ORDER.line_items[0], null] } }],
      ['get_order', { orderId: 727 }, { 'GET /orders/727': { ...ORDER, refunds: [{ id: 1, total: 'many' }] } }],
      ['get_product', { productId: 31 }, { 'GET /products/31': { id: 32 } }],
      ['get_product', { productId: 31 }, { 'GET /products/31': { id: 31, categories: [{ name: 'no id' }] } }],
      ['get_customer', { customerId: 21 }, { 'GET /customers/21': { id: 22 } }],
      ['get_customer', { customerId: 21 }, { 'GET /customers/21': { id: 21, email: ['a'] } }],
      ['update_order_status', { orderId: 727, status: 'completed' }, { 'GET /orders/727': ORDER, 'PUT /orders/727': { ...ORDER, id: 1 } }],
      ['update_order_status', { orderId: 727, status: 'completed' }, { 'GET /orders/727': ORDER, 'PUT /orders/727': ORDER }],
      ['update_product', { productId: 31, name: 'x' }, { 'PUT /products/31': { id: 30 } }],
      ['create_draft_product', { name: 'x' }, { 'POST /products': { id: 31, status: 'publish' } }],
      ['list_orders', {}, { 'GET /orders': [ORDER, { ...ORDER, id: 1, status: 7 }] }],
      ['get_sales_report', { period: 'week' }, { 'GET /reports/sales': [{ total_sales: '1.00' }, { total_sales: '2.00' }] }],
      ['get_sales_report', { period: 'week' }, { 'GET /reports/sales': [{ total_sales: '1.00', totals: { '2026-11-01': { sales: {} } } }] }],
    ];
    for (const [tool, input, routes] of bad) {
      const result = await call(shop(routes).gw, tool, input);
      expect(result.isError, `${tool} ${JSON.stringify(routes)}`).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/nested|deeper|no id/);
    }
  });

  it('passes on only the fields its schema names, sub-objects included', async () => {
    const { gw } = shop({
      'GET /orders/727': { ...ORDER, billing: { ...ORDER.billing, plugin_field: 'x' }, line_items: [{ ...ORDER.line_items[0], plugin: { a: 1 } }] },
    });
    const text = JSON.stringify((await call(gw, 'get_order', { orderId: 727 })).structuredContent);
    expect(text).not.toMatch(/plugin|meta_data/);
  });

  it('keeps no name or address of the caller in the audit, and replaces a request id that is not an opaque token', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: (async () => Response.json({ id: 21 })) as typeof fetch,
      policy: { audit: record => void records.push({ ...record }), pseudonymKey: 'host-pseudonym-key-0001' },
    });
    await gw.callTool('get_customer', { customerId: 21 }, { caller: 'jens.jensen@example.test', requestId: 'Jens Jensen, Aarhus' });
    await gw.callTool('get_customer', { customerId: 21 }, { caller: 'jens.jensen@example.test', requestId: 'req-42' });
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/jens|Jensen|Aarhus/i);
    expect(records[0]?.caller).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(records[0]?.caller).toBe(records.at(-1)?.caller);
    expect(records[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(records.at(-1)?.requestId).toBe('req-42');
    expect(() =>
      createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, policy: { pseudonymKey: 'short' } }),
    ).toThrow(/pseudonymKey/);
  });
});
