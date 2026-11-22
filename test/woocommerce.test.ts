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
import { REDACTION_MARKER } from '../src/errors.js';
import { fixedOutputs, RESULT_WITHHELD } from '../src/fallbacks.js';
import { FIXED_CORPUS } from '../src/fixed-corpus.generated.js';

const KEY = 'ck_tttt-gggg-wwww-vvvv-1';
// Pseudonym keys: 32 or more random printable characters that share no piece with any text of ours.
const PSEUDONYM_KEY_1 = 'Qh7Vz2Lr9Xw4Nc8Tp3Yk6Bm1Fs5Jd0Ga'; // gitleaks:allow (a test value, not a key)
const PSEUDONYM_KEY_2 = 'Wy3Rk8Pq1Zt6Hv9Lc2Xn5Bg7Md4Js0Fe'; // gitleaks:allow (a test value, not a key)
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

/** A write answer as the documentation shows it: the record with the values sent. */
const echoBody = (id: number) => (_url: URL, init: RequestInit) => ({ id, ...(JSON.parse(String(init.body)) as object) });

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
    'POST /orders/727/refunds': (_url: URL, init: RequestInit) => ({
      id: 9,
      amount: (JSON.parse(String(init.body)) as { amount: string }).amount,
      reason: '',
      refunded_payment: false,
    }),
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

  it('refunds a payment through the payment gateway (api_refund true), without restocking, and checks the answer says so', async () => {
    const paid = {
      'GET /orders/727': ORDER,
      'POST /orders/727/refunds': (_url: URL, init: RequestInit) => ({
        id: 9,
        amount: (JSON.parse(String(init.body)) as { amount: string }).amount,
        reason: '',
        refunded_payment: true,
      }),
    };
    const { gw, calls } = shop(paid);
    const result = await call(gw, 'refund_payment', { orderId: 727, amount: 50, currency: 'DKK', reason: 'Defekt' });
    expect(result.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/orders/727/refunds',
      body: { amount: '50.00', reason: 'Defekt', api_refund: true, api_restock: false },
    });
    expect(result.structuredContent).toEqual({ id: 9, amount: '50.00', reason: '', refunded_payment: true });

    // An answer that says the gateway did not pay it back is not reported as done; nor is a recorded refund that did.
    const { gw: unpaid } = shop(refundRoutes({}));
    expect((await call(unpaid, 'refund_payment', { orderId: 727, amount: 50, currency: 'DKK' })).isError).toBe(true);
    const { gw: moved } = shop(paid);
    expect((await call(moved, 'record_refund', { orderId: 727, amount: 50, currency: 'DKK' })).isError).toBe(true);
  });

  it('refuses a payment refund of more than is left, or in another currency, without sending it', async () => {
    for (const [order, amount] of [
      [{ refunds: [{ id: 1, total: '-60.00' }] }, 50.01],
      [{ currency: 'EUR' }, 10],
      [{ status: 'pending' }, 10],
    ] as const) {
      const { gw, calls } = shop(refundRoutes(order));
      expect((await call(gw, 'refund_payment', { orderId: 727, amount, currency: 'DKK' })).isError).toBe(true);
      expect(calls.some(c => c.method === 'POST')).toBe(false);
    }
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
        return { id: posts.length, amount: '100.00', refunded_payment: false };
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
    const { gw, calls } = shop({ 'PUT /products/31': echoBody(31) });
    expect((await call(gw, 'update_product', { productId: 31, stock_quantity: 4, manage_stock: true })).isError).toBeUndefined();
    expect(calls[0]?.body).toEqual({ manage_stock: true, stock_quantity: 4 });
    expect((await call(gw, 'update_product', { productId: 31 })).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('updates a customer’s name and addresses, never the e-mail, password or role', async () => {
    const { gw, calls } = shop({ 'PUT /customers/21': echoBody(21) });
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
        requiresConfirmation: false,
        values: { orderId: 727, amount: 50.5, currency: 'DKK' },
      },
    });
    expect(resolveWooCommerceChange('refund_payment', { orderId: 727, amount: 50.5, currency: 'DKK', reason: 'Jens Jensen ringede' })).toEqual({
      ok: true,
      change: {
        tool: 'refund_payment',
        action: 'refund_payment',
        record: 'refund',
        movesMoney: true,
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

  it('marks only refund_payment, which moves money, as needing a person to confirm', () => {
    expect(wooCommerceToolCatalog.filter(entry => entry.requiresConfirmation).map(entry => entry.name)).toEqual(['refund_payment']);
    expect(wooCommerceToolCatalog.filter(entry => entry.change?.movesMoney).map(entry => entry.name)).toEqual(['refund_payment']);
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
        if (init?.method === 'POST') return Response.json({ id: 9, amount: '50.00', refunded_payment: false });
        if (path.endsWith('/orders/727')) return Response.json(ORDER);
        return Response.json([]);
      }) as typeof fetch,
      policy: { enableWrites: true, audit: record => void records.push({ ...record }) },
    });
    expect((await gw.callTool('record_refund', { orderId: 727, amount: 50, currency: 'DKK', reason: 'Jens Jensen ringede' })).isError).toBeUndefined();
    expect((await gw.callTool('list_customers', { search: 'Anna Hansen' })).isError).toBeUndefined();
    expect(records.filter(record => record.action === 'finish')).toHaveLength(2);
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

  it('keeps no name or address of the caller or the request id in the audit', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: (async () => Response.json({ id: 21 })) as typeof fetch,
      policy: { audit: record => void records.push({ ...record }), pseudonymKey: PSEUDONYM_KEY_1 }, // gitleaks:allow (a test constant, not a key)
    });
    await gw.callTool('get_customer', { customerId: 21 }, { caller: 'jens.jensen@example.test', requestId: 'Jens Jensen, Aarhus' });
    await gw.callTool('get_customer', { customerId: 21 }, { caller: 'jens.jensen@example.test', requestId: 'req-42' });
    const text = JSON.stringify(records);
    expect(text).not.toMatch(/jens|Jensen|Aarhus/i);
    expect(records[0]?.caller).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(records[0]?.caller).toBe(records.at(-1)?.caller);
    expect(records[0]?.requestId).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(records.at(-1)?.requestId).toMatch(/^hmac:[0-9a-f]{16}$/);
    expect(text).not.toContain('req-42');
    expect(() =>
      createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, policy: { pseudonymKey: 'short' } }),
    ).toThrow(/pseudonymKey/);
  });
});

describe('after review 2', () => {
  const PSEUDONYM_KEY = PSEUDONYM_KEY_2; // gitleaks:allow (a test constant, not a key)

  it('never keeps a request id from the host in clear, whatever characters it uses', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: (async () => Response.json({ id: 21 })) as typeof fetch,
      policy: { audit: record => void records.push({ ...record }), pseudonymKey: PSEUDONYM_KEY },
    });
    // A name with a hyphen, a phone number, a private address and an internal host name: all within the old
    // character filter. Made up for the test.
    const given = ['Anne-Marie.Hansen', '+4512345678', '10.0.0.5', 'intra-01.corp.example:8443'];
    for (const requestId of given) await gw.callTool('get_customer', { customerId: 21 }, { requestId });
    await gw.callTool('get_customer', { customerId: 21 });
    const text = JSON.stringify(records);
    for (const value of given) expect(text).not.toContain(value);
    expect(text).not.toMatch(/Anne|4512345678|10\.0\.0|corp/);
    const ids = records.map(record => record.requestId);
    for (const id of ids.slice(0, 8)) expect(id).toMatch(/^hmac:[0-9a-f]{16}$/);
    // The lines of one call share their id; another call does not.
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[2]);
    // Without a request id the audit makes its own.
    expect(ids.at(-1)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the pseudonym key out of results, audit records and errors', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      maxAttempts: 1,
      fetchImpl: (async (input: string | URL | Request) =>
        String(input).includes('/customers/21')
          ? Response.json({ id: 21, first_name: `Navn ${PSEUDONYM_KEY}` })
          : Response.json({ code: 'x', message: `Fejl ${PSEUDONYM_KEY}` }, { status: 400 })) as typeof fetch,
      policy: { audit: record => void records.push({ ...record }), pseudonymKey: PSEUDONYM_KEY },
    });
    const results = [await gw.callTool('get_customer', { customerId: 21 }), await gw.callTool('get_customer', { customerId: 22 })];
    expect(results[0]?.isError).toBeUndefined();
    expect(results[1]?.isError).toBe(true);
    const text = JSON.stringify([results, records]);
    expect(text).not.toContain(PSEUDONYM_KEY);
    expect(text).not.toContain(PSEUDONYM_KEY.slice(4, 16));
  });

  it('keeps a pseudonym key given as bytes out of results', async () => {
    const bytes = new TextEncoder().encode(PSEUDONYM_KEY);
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      maxAttempts: 1,
      fetchImpl: (async () =>
        Response.json({ id: 21, first_name: PSEUDONYM_KEY, last_name: Buffer.from(bytes).toString('hex') })) as typeof fetch,
      policy: { pseudonymKey: bytes },
    });
    const text = JSON.stringify(await gw.callTool('get_customer', { customerId: 21 }));
    expect(text).not.toContain(PSEUDONYM_KEY);
    expect(text).not.toContain(Buffer.from(bytes).toString('hex'));
  });

  it('reports a note as added only when the answer says it is private', async () => {
    for (const answer of [
      { id: 5, note: 'x', customer_note: true },
      { id: 5, note: 'x' },
    ]) {
      const { gw } = shop({ 'POST /orders/727/notes': answer });
      expect((await call(gw, 'add_order_note', { orderId: 727, note: 'x' })).isError, JSON.stringify(answer)).toBe(true);
    }
  });

  it('reports a refund as recorded only with the amount asked for and no money moved', async () => {
    for (const answer of [
      { id: 9, amount: '60.00', refunded_payment: false },
      { id: 9, amount: '50.00', refunded_payment: true },
      { id: 9, amount: '50.00' },
      { id: 9, refunded_payment: false },
    ]) {
      const { gw } = shop({ 'GET /orders/727': ORDER, 'POST /orders/727/refunds': answer });
      const result = await call(gw, 'record_refund', { orderId: 727, amount: 50, currency: 'DKK' });
      expect(result.isError, JSON.stringify(answer)).toBe(true);
    }
    const { gw } = shop({ 'GET /orders/727': ORDER, 'POST /orders/727/refunds': { id: 9, amount: '50.00', refunded_payment: false } });
    expect((await call(gw, 'record_refund', { orderId: 727, amount: 50, currency: 'DKK' })).isError).toBeUndefined();
  });

  it('reports a product as created only when the answer says draft', async () => {
    for (const answer of [{ id: 31, name: 'Kop' }, { id: 31, name: 'Kop', status: 'publish' }]) {
      const { gw } = shop({ 'POST /products': answer });
      expect((await call(gw, 'create_draft_product', { name: 'Kop' })).isError, JSON.stringify(answer)).toBe(true);
    }
  });

  it('keeps a status with a hyphen in the change resolution', () => {
    const resolved = resolveWooCommerceChange('update_order_status', { orderId: 727, status: 'on-hold' });
    expect(resolved.ok && resolved.change.values).toEqual({ orderId: 727, status: 'on-hold' });
  });
});

describe('after review 3: the pseudonym key anywhere', () => {
  /** Every piece of six characters of a key (the redactor's fragment length). */
  const pieces = (key: string) => Array.from({ length: Math.max(0, key.length - 5) }, (_, i) => key.slice(i, i + 6));
  /** The pieces of any form of the key found in any of the values, raw or serialised. */
  const leaked = (forms: string[], values: unknown[]) => {
    const texts = values.map(value => (typeof value === 'string' ? value : JSON.stringify(value) ?? ''));
    return forms.flatMap(pieces).filter(piece => texts.some(text => text.includes(piece)));
  };
  const formsOf = (key: string | Uint8Array) =>
    typeof key === 'string' ? [key] : ['hex', 'base64', 'base64url', 'latin1'].map(form => Buffer.from(key).toString(form as BufferEncoding));
  const construct = (options: Record<string, unknown>): Error | undefined => {
    try {
      createWooCommerceGateway(options as never);
      return undefined;
    } catch (error) {
      return error as Error;
    }
  };

  // Every fixed text of ours long enough to be a key, the fallback texts joined, and texts of ours inside a key.
  const OWN_TEXTS = [
    ...FIXED_CORPUS.filter(text => text.length >= 32),
    `${RESULT_WITHHELD}${REDACTION_MARKER}`,
    `policy.enableWrites must be a boolean ${'z'.repeat(10)}`,
    `WOOCOMMERCE_SHOP_URL-${'7'.repeat(12)}`,
  ];
  const BROKEN: Array<Record<string, unknown>> = [
    {},
    { shopUrl: 'not a url' },
    { shopUrl: 'https://10.0.0.1/shop' },
    { consumerKey: 'short' },
    { policy: { enableWrites: 'yes' } },
    { policy: { disabledTools: ['no_such_tool'] } },
  ];

  it('refuses a pseudonym key that shares text with ours, and no construction error shows a piece of it', () => {
    let checked = 0;
    for (const text of OWN_TEXTS) {
      for (const key of [text, new TextEncoder().encode(text)]) {
        for (const broken of BROKEN) {
          const { policy: brokenPolicy, ...rest } = broken as { policy?: Record<string, unknown> };
          const error = construct({
            consumerKey: KEY,
            consumerSecret: SECRET,
            shopUrl: SHOP,
            ...rest,
            policy: { ...brokenPolicy, pseudonymKey: key },
          });
          expect(error, text).toBeInstanceOf(Error);
          expect(leaked(formsOf(key), [error!.message, error!.stack, error!.name, error]), text).toEqual([]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('keeps an admitted pseudonym key out of construction errors, the tool list and every fixed output', () => {
    for (const key of [PSEUDONYM_KEY_1, Buffer.from('a7f3c91e5b2d8046f1e9c3a7b5d20864d18b6e2f4a9c07e35b1d8f62c4a09e17', 'hex')]) {
      for (const broken of BROKEN.slice(1)) {
        const { policy: brokenPolicy, ...rest } = broken as { policy?: Record<string, unknown> };
        const error = construct({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, ...rest, policy: { ...brokenPolicy, pseudonymKey: key } });
        expect(error).toBeInstanceOf(Error);
        expect(leaked(formsOf(key), [error!.message, error!.stack, error])).toEqual([]);
      }
      const gw = createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, policy: { pseudonymKey: key } });
      expect(leaked(formsOf(key), [gw.tools, wooCommerceToolCatalog, fixedOutputs()])).toEqual([]);
    }
  });

  it('refuses a pseudonym key that is too short, as text or bytes', () => {
    for (const key of ['Qh7Vz2Lr9Xw4Nc8Tp3Yk6Bm', new Uint8Array(31)]) {
      const error = construct({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, policy: { pseudonymKey: key } });
      expect(error?.message).toMatch(/pseudonymKey/);
    }
  });

  it('keeps an admitted pseudonym key out of results, errors and audit records wherever the shop or the host puts it', async () => {
    const key = PSEUDONYM_KEY_1; // gitleaks:allow (a test constant, not a key)
    const records: unknown[] = [];
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      maxAttempts: 1,
      fetchImpl: (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/customers/21')) return Response.json({ id: 21, first_name: key, last_name: key.slice(3, 20), billing: { city: `x${key}x` } });
        if (path.endsWith('/customers/22')) return Response.json({ code: key, message: key }, { status: 400 });
        if (path.endsWith('/customers/23')) return new Response(null, { status: 302, headers: { location: `https://elsewhere.test/${key}` } });
        throw new TypeError(`fetch failed ${key}`);
      }) as typeof fetch,
      policy: { audit: record => void records.push(record), pseudonymKey: key },
    });
    const results = [];
    for (const customerId of [21, 22, 23, 24]) {
      results.push(await gw.callTool('get_customer', { customerId }, { caller: key, requestId: key }));
    }
    results.push(await gw.callTool(`get_${key}`, { [key]: key }, { caller: key }));
    results.push(await gw.callTool('get_customer', { customerId: 21, [key]: 1 }));
    results.push(await gw.callTool('list_customers', { search: key }));
    expect(results[0]?.isError).toBeUndefined();
    expect(leaked([key], [results, records])).toEqual([]);
  });
});

describe('after review 3: updates are confirmed by the answer', () => {
  it('reports a product as updated only when the answer has every value sent', async () => {
    const bad: Array<[GatewayJsonObject, Record<string, unknown>]> = [
      [{ productId: 31, status: 'draft' }, { id: 31, status: 'publish' }],
      [{ productId: 31, status: 'draft' }, { id: 31 }],
      [{ productId: 31, regular_price: '49.00' }, { id: 31, regular_price: '59.00' }],
      [{ productId: 31, sale_price: '' }, { id: 31, sale_price: '10.00' }],
      [{ productId: 31, stock_quantity: 4 }, { id: 31, stock_quantity: 3 }],
      [{ productId: 31, manage_stock: true }, { id: 31, manage_stock: false }],
      [{ productId: 31, name: 'Kop' }, { id: 31, name: 'Krus' }],
    ];
    for (const [input, answer] of bad) {
      const records: Array<Record<string, unknown>> = [];
      const fetchImpl = (async () => Response.json(answer)) as typeof fetch;
      const gw = createWooCommerceGateway({
        consumerKey: KEY,
        consumerSecret: SECRET,
        shopUrl: SHOP,
        maxAttempts: 1,
        fetchImpl,
        policy: { enableWrites: true, audit: record => void records.push({ ...record }) },
      });
      const result = await gw.callTool('update_product', input);
      expect(result.isError, JSON.stringify([input, answer])).toBe(true);
      expect(records.at(-1)?.action).toBe('error');
    }
    const { gw } = shop({ 'PUT /products/31': { id: 31, status: 'draft', regular_price: '49', sale_price: '', name: ' Kop ' } });
    const ok = await call(gw, 'update_product', { productId: 31, status: 'draft', regular_price: '49.00', sale_price: '', name: 'Kop' });
    expect(ok.isError).toBeUndefined();
  });

  it('reports a customer as updated only when the answer has every value sent, in the addresses too', async () => {
    const bad: Array<[GatewayJsonObject, Record<string, unknown>]> = [
      [{ customerId: 21, first_name: 'Anna' }, { id: 21, first_name: 'Jens' }],
      [{ customerId: 21, first_name: 'Anna' }, { id: 21 }],
      [{ customerId: 21, billing: { city: 'Aarhus' } }, { id: 21, billing: { city: 'Odense' } }],
      [{ customerId: 21, shipping: { postcode: '8000' } }, { id: 21, billing: { postcode: '8000' } }],
    ];
    for (const [input, answer] of bad) {
      const { gw } = shop({ 'PUT /customers/21': answer });
      expect((await call(gw, 'update_customer', input)).isError, JSON.stringify([input, answer])).toBe(true);
    }
  });
});

describe('after review 4', () => {
  it('reads every page of an order\'s refunds, and says so when there are more than it reads', async () => {
    const refundPage = (pages: number) => (url: URL) => {
      const n = Number(url.searchParams.get('page'));
      const rows = Array.from({ length: n < pages ? 100 : 3 }, (_, i) => ({ id: n * 1000 + i, amount: '1.00', refunded_payment: false }));
      return Response.json(rows, { headers: { 'X-WP-Total': String((pages - 1) * 100 + 3), 'X-WP-TotalPages': String(pages) } });
    };
    const { gw, calls } = shop({ 'GET /orders/727/refunds': refundPage(3) });
    const result = await call(gw, 'list_order_refunds', { orderId: 727 });
    expect(result.isError).toBeUndefined();
    const content = result.structuredContent as { refunds: unknown[]; complete: boolean };
    expect(content.refunds).toHaveLength(203);
    expect(content.complete).toBe(true);
    expect(calls.map(c => [c.query.get('page'), c.query.get('per_page')])).toEqual([
      ['1', '100'],
      ['2', '100'],
      ['3', '100'],
    ]);

    const many = shop({ 'GET /orders/727/refunds': refundPage(12) });
    const partial = (await call(many.gw, 'list_order_refunds', { orderId: 727 })).structuredContent as { refunds: unknown[]; complete: boolean };
    expect(partial.complete).toBe(false);
    expect(partial.refunds).toHaveLength(1000);
    expect(many.calls).toHaveLength(10);
  });

  it('compares a price exactly at the precision sent', async () => {
    for (const [sent, answered] of [
      ['0.0049', '0.00'],
      ['0.0049', '0.0050'],
      ['49.95', '49.9'],
      ['49.9501', '49.95'],
    ] as Array<[string, string]>) {
      const { gw } = shop({ 'PUT /products/31': { id: 31, regular_price: answered } });
      expect((await call(gw, 'update_product', { productId: 31, regular_price: sent })).isError, `${sent} ${answered}`).toBe(true);
    }
    for (const [sent, answered] of [
      ['49', '49.00'],
      ['49.50', '49.5'],
      ['0.0049', '0.004900'],
    ] as Array<[string, string]>) {
      const { gw } = shop({ 'PUT /products/31': { id: 31, regular_price: answered } });
      expect((await call(gw, 'update_product', { productId: 31, regular_price: sent })).isError, `${sent} ${answered}`).toBeUndefined();
    }
  });

  it('refuses a pseudonym key that is not valid UTF-16, with the sealed refusal and no piece of it', () => {
    const pieces = (key: string) => Array.from({ length: key.length - 5 }, (_, i) => key.slice(i, i + 6));
    for (const key of [`Qh7Vz2Lr9Xw4Nc8T\uD800p3Yk6Bm1Fs5Jd0Ga`, `\uDC00Wy3Rk8Pq1Zt6Hv9Lc2Xn5Bg7Md4Js0Fe`, `Zr8qLw2Xv7NcT4pK9mYb3HsD6fJgQ1aE\uDBFF`]) {
      for (const broken of [{}, { shopUrl: 'not a url' }, { consumerKey: 'short' }]) {
        let caught: Error | undefined;
        try {
          createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, ...broken, policy: { pseudonymKey: key } } as never);
        } catch (error) {
          caught = error as Error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught!.name).toBe('ConfigError');
        expect(String(caught!.stack)).toBe(`${caught!.name}: ${caught!.message}`);
        const text = [caught!.message, caught!.stack, JSON.stringify(caught)].join(' ');
        for (const piece of pieces(key)) expect(text, piece).not.toContain(piece);
      }
    }
  });
});
