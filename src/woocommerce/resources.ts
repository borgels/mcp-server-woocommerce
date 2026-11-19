import { nestedFailuresAsStatus } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { QueryValue, UpstreamClient } from './client.js';
import { isCurrency, money } from './values.js';

/**
 * Calls to the WooCommerce REST API v3 (https://woocommerce.github.io/woocommerce-rest-api-docs/).
 * From the documentation:
 *
 * - A record is answered as a JSON object, a list as a JSON array; lists are
 *   paginated with `page` and `per_page` and carry X-WP-Total and
 *   X-WP-TotalPages.
 * - "Resource IDs are returned as integers"; money is a string with two
 *   decimals.
 *
 * Every caller-supplied path segment goes through encodePathParam. Every
 * body passes nestedFailuresAsStatus before it is shaped, and an answer
 * that is not shaped as documented is refused rather than shown as empty.
 */

export const MAX_PER_PAGE = 100;

type Json = Record<string, unknown>;

/** An answer that is not shaped as the documentation says: our own text, nothing of the answer. */
export class UnexpectedAnswerError extends Error {
  constructor() {
    super('The shop answered without the expected data. Nothing in the answer was used.');
    this.name = 'UnexpectedAnswerError';
  }
}

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value.map(asRecord).filter(Boolean) as Json[]) : [];
}

/** One record: an object with an integer id. Anything else is refused. */
function record(body: unknown): Json {
  const value = asRecord(body);
  if (!value || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) throw new UnexpectedAnswerError();
  return value;
}

/** A list: a JSON array. Anything else is refused. */
function list(body: unknown): Json[] {
  if (!Array.isArray(body)) throw new UnexpectedAnswerError();
  const records = body.map(asRecord);
  // One entry that is not a record with an integer id refuses the whole answer, rather than being left out silently.
  if (!records.every(entry => entry !== undefined && typeof entry.id === 'number' && Number.isSafeInteger(entry.id) && entry.id > 0)) {
    throw new UnexpectedAnswerError();
  }
  return records as Json[];
}

/** The fields of `value` that are listed, in that order, leaving out absent ones. */
function pick(value: Json, fields: readonly string[]): Json {
  const out: Json = {};
  for (const field of fields) {
    if (Object.hasOwn(value, field) && value[field] !== undefined) out[field] = value[field];
  }
  return out;
}

function idPath(resource: string, id: number, name: string): string {
  return `/${resource}/${encodePathParam(String(id), name)}`;
}

async function get(client: UpstreamClient, path: string, query?: Record<string, QueryValue>): Promise<unknown> {
  return nestedFailuresAsStatus(await client.get(path, query));
}

async function page(
  client: UpstreamClient,
  path: string,
  query: Record<string, QueryValue>,
): Promise<{ rows: Json[]; paging: { page: number; perPage: number; total?: number; totalPages?: number } }> {
  const answer = await client.getPage(path, query);
  const rows = list(nestedFailuresAsStatus(answer.body));
  return {
    rows,
    paging: {
      page: Number(query.page ?? 1),
      perPage: Number(query.per_page),
      ...(answer.total === undefined ? {} : { total: answer.total }),
      ...(answer.totalPages === undefined ? {} : { totalPages: answer.totalPages }),
    },
  };
}

/** The documented filters given, plus page and per_page (default 20, at most 100). Dates become the start of the day. */
function listQuery(input: Json, filters: readonly string[], dates: readonly string[] = []): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const name of [...filters, 'page', 'order', 'orderby']) {
    const value = input[name];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') query[name] = value;
  }
  for (const name of dates) {
    if (typeof input[name] === 'string') query[name] = `${input[name] as string}T00:00:00`;
  }
  query.per_page = typeof input.perPage === 'number' ? input.perPage : 20;
  return query;
}

const ADDRESS_FIELDS = ['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'state', 'postcode', 'country'] as const;
const BILLING_FIELDS = [...ADDRESS_FIELDS, 'email', 'phone'] as const;

function address(value: unknown, fields: readonly string[]): Json | undefined {
  const record_ = asRecord(value);
  return record_ ? pick(record_, fields) : undefined;
}

// ---------------------------------------------------------------------------
// Connection and reports

/** One cheap read: the first page of orders with one row, for the total. Returns only that the key works. */
export async function checkConnection(client: UpstreamClient): Promise<Json> {
  const { paging } = await page(client, '/orders', { per_page: 1 });
  return { connected: true, ...(paging.total === undefined ? {} : { orders: paging.total }) };
}

/**
 * GET /reports/sales: totals for a period (week, month, last_month, year)
 * or between two dates. The documentation's example answers a list with one
 * object.
 */
export async function getSalesReport(
  client: UpstreamClient,
  input: { period?: string; dateMin?: string; dateMax?: string },
): Promise<Json> {
  const query: Record<string, QueryValue> = input.period
    ? { period: input.period }
    : { date_min: input.dateMin, date_max: input.dateMax };
  // The documentation answers an array with one report object, which has no id.
  const body = await get(client, '/reports/sales', query);
  const report = Array.isArray(body) && body.length === 1 ? asRecord(body[0]) : undefined;
  if (!report || money(report.total_sales) === undefined) throw new UnexpectedAnswerError();
  return pick(report, [
    'total_sales',
    'net_sales',
    'average_sales',
    'total_orders',
    'total_items',
    'total_tax',
    'total_shipping',
    'total_refunds',
    'total_discount',
    'totals_grouped_by',
    'totals',
  ]);
}

// ---------------------------------------------------------------------------
// Orders

export const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;

const ORDER_ROW = [
  'id',
  'number',
  'status',
  'currency',
  'total',
  'total_tax',
  'date_created',
  'date_paid',
  'date_completed',
  'customer_id',
  'payment_method_title',
] as const;

function orderRow(order: Json): Json {
  const billing = address(order.billing, ['first_name', 'last_name', 'company']);
  return { ...pick(order, ORDER_ROW), ...(billing ? { billing } : {}), items: asArray(order.line_items).length };
}

export const ORDER_FILTERS = ['status', 'customer', 'product', 'search'] as const;

export async function listOrders(client: UpstreamClient, input: Json): Promise<Json> {
  const { rows, paging } = await page(client, '/orders', listQuery(input, ORDER_FILTERS, ['after', 'before']));
  return { orders: rows.map(orderRow), paging };
}

const LINE_ITEM_FIELDS = ['id', 'name', 'product_id', 'variation_id', 'sku', 'quantity', 'price', 'subtotal', 'total', 'total_tax'] as const;

/**
 * One order with its lines, addresses, the customer's note and its refunds.
 * Left out: meta data (plugins keep anything there), the customer's IP
 * address and user agent, the order key, the cart hash and the payment
 * provider's transaction id.
 */
export async function getOrder(client: UpstreamClient, input: { orderId: number }): Promise<Json> {
  const order = record(await get(client, idPath('orders', input.orderId, 'orderId')));
  return shapeOrder(order);
}

function shapeOrder(order: Json): Json {
  return {
    ...pick(order, [
      'id',
      'parent_id',
      'number',
      'status',
      'currency',
      'prices_include_tax',
      'date_created',
      'date_modified',
      'date_paid',
      'date_completed',
      'discount_total',
      'shipping_total',
      'total',
      'total_tax',
      'customer_id',
      'customer_note',
      'payment_method_title',
      'created_via',
    ]),
    ...(asRecord(order.billing) ? { billing: address(order.billing, BILLING_FIELDS) } : {}),
    ...(asRecord(order.shipping) ? { shipping: address(order.shipping, ADDRESS_FIELDS) } : {}),
    line_items: asArray(order.line_items).map(line => pick(line, LINE_ITEM_FIELDS)),
    shipping_lines: asArray(order.shipping_lines).map(line => pick(line, ['id', 'method_title', 'total', 'total_tax'])),
    fee_lines: asArray(order.fee_lines).map(line => pick(line, ['id', 'name', 'total', 'total_tax'])),
    coupon_lines: asArray(order.coupon_lines).map(line => pick(line, ['id', 'code', 'discount'])),
    refunds: asArray(order.refunds).map(refund => pick(refund, ['id', 'reason', 'total'])),
  };
}

export async function listOrderNotes(client: UpstreamClient, input: { orderId: number; type?: string }): Promise<Json> {
  const rows = list(await get(client, `${idPath('orders', input.orderId, 'orderId')}/notes`, { type: input.type }));
  return { notes: rows.map(note => pick(note, ['id', 'date_created', 'author', 'note', 'customer_note'])) };
}

export async function listOrderRefunds(client: UpstreamClient, input: { orderId: number }): Promise<Json> {
  const rows = list(await get(client, `${idPath('orders', input.orderId, 'orderId')}/refunds`));
  return { refunds: rows.map(refund => pick(refund, ['id', 'date_created', 'amount', 'reason', 'refunded_payment'])) };
}

/** Statuses an order may be moved to here. Not refunded, failed, pending or trash. */
export const SETTABLE_ORDER_STATUSES = ['processing', 'on-hold', 'completed', 'cancelled'] as const;

/**
 * Move an order to another status. Reads it first and refuses, without
 * sending anything, an order that is refunded, failed or in the trash, or
 * that already has the status.
 */
export async function updateOrderStatus(client: UpstreamClient, input: { orderId: number; status: string }): Promise<Json> {
  const path = idPath('orders', input.orderId, 'orderId');
  return serialised(`${client.shopIdentity()}:order:${input.orderId}`, async () => {
    const current = record(await get(client, path));
    if (current.status === input.status) throw new Error('Refused: the order already has that status. Nothing was sent.');
    if (current.status === 'refunded' || current.status === 'failed' || current.status === 'trash') {
      throw new Error('Refused: a refunded, failed or deleted order is not changed here. Nothing was sent.');
    }
    const order = record(nestedFailuresAsStatus(await client.put(path, { status: input.status })));
    return pick(order, ['id', 'number', 'status', 'date_modified']);
  });
}

/** A private note on the order: `customer_note` is always false, so the customer is not notified. */
export async function addOrderNote(client: UpstreamClient, input: { orderId: number; note: string }): Promise<Json> {
  const body = nestedFailuresAsStatus(
    await client.post(`${idPath('orders', input.orderId, 'orderId')}/notes`, { note: input.note, customer_note: false }),
  );
  return pick(record(body), ['id', 'date_created', 'note', 'customer_note']);
}

/**
 * Record a refund on an order in the shop, without refunding any money:
 * `api_refund` is sent as false (its documented default is true, which asks
 * the payment gateway to pay the money back) and `api_restock` as false.
 * The money is refunded by a person in the payment provider.
 *
 * Reads the order first and refuses, without sending anything, when it is
 * not processing, on-hold or completed, the currency differs or is not
 * known, or the amount is more than the total less what is already
 * refunded. One refund at a time per shop and order in this process.
 */
export async function recordRefund(
  client: UpstreamClient,
  input: { orderId: number; amount: number; currency: string; reason?: string },
): Promise<Json> {
  const path = idPath('orders', input.orderId, 'orderId');
  return serialised(`${client.shopIdentity()}:refund:${input.orderId}`, async () => {
    const order = record(await get(client, path));
    if (!['processing', 'on-hold', 'completed'].includes(String(order.status))) {
      throw new Error('Refused: only a processing, on-hold or completed order can get a refund here. Nothing was sent.');
    }
    if (!isCurrency(order.currency) || order.currency !== input.currency) {
      throw new Error('Refused: the currency is not the order\'s, or the order\'s currency is not known. Nothing was sent.');
    }
    const total = money(order.total);
    if (total === undefined || total <= 0) throw new Error('Refused: the order has no positive total. Nothing was sent.');
    // Every earlier refund counts: an order without its refunds list, or with an entry that is not one, is refused.
    if (!Array.isArray(order.refunds)) throw new UnexpectedAnswerError();
    const refunds = order.refunds.map(refund => money(asRecord(refund)?.total));
    if (refunds.some(value => value === undefined)) throw new UnexpectedAnswerError();
    const refunded = refunds.reduce<number>((sum, value) => sum + Math.abs(value as number), 0);
    if (input.amount > total - refunded + 0.005) {
      throw new Error('Refused: the amount is more than what is left to refund on the order. Nothing was sent.');
    }
    const body = nestedFailuresAsStatus(
      await client.post(`${path}/refunds`, {
        amount: input.amount.toFixed(2),
        ...(input.reason ? { reason: input.reason } : {}),
        api_refund: false,
        api_restock: false,
      }),
    );
    return pick(record(body), ['id', 'date_created', 'amount', 'reason', 'refunded_payment']);
  });
}

// ---------------------------------------------------------------------------
// Products

const PRODUCT_ROW = [
  'id',
  'name',
  'sku',
  'type',
  'status',
  'price',
  'regular_price',
  'sale_price',
  'manage_stock',
  'stock_quantity',
  'stock_status',
  'total_sales',
] as const;

function shapeProduct(product: Json, full = false): Json {
  const categories = asArray(product.categories).map(category => pick(category, ['id', 'name']));
  return {
    ...pick(product, full ? [...PRODUCT_ROW, 'permalink', 'short_description', 'description', 'date_modified', 'variations'] : PRODUCT_ROW),
    categories,
  };
}

export const PRODUCT_FILTERS = ['search', 'sku', 'status', 'stock_status', 'category', 'type'] as const;

export async function listProducts(client: UpstreamClient, input: Json): Promise<Json> {
  const { rows, paging } = await page(client, '/products', listQuery(input, PRODUCT_FILTERS));
  return { products: rows.map(product => shapeProduct(product)), paging };
}

export async function getProduct(client: UpstreamClient, input: { productId: number }): Promise<Json> {
  return shapeProduct(record(await get(client, idPath('products', input.productId, 'productId'))), true);
}

const PRODUCT_WRITABLE = [
  'name',
  'sku',
  'regular_price',
  'sale_price',
  'description',
  'short_description',
  'manage_stock',
  'stock_quantity',
  'stock_status',
] as const;

/** A new simple product, always as a draft (the documented default status is publish). */
export async function createDraftProduct(client: UpstreamClient, input: Json): Promise<Json> {
  const body = nestedFailuresAsStatus(
    await client.post('/products', { ...pick(input, PRODUCT_WRITABLE), type: 'simple', status: 'draft' }),
  );
  return shapeProduct(record(body));
}

/** Change the fields given on a product; fields left out stay as they are. */
export async function updateProduct(client: UpstreamClient, input: Json & { productId: number }): Promise<Json> {
  const body = nestedFailuresAsStatus(
    await client.put(idPath('products', input.productId, 'productId'), pick(input, [...PRODUCT_WRITABLE, 'status'])),
  );
  return shapeProduct(record(body));
}

// ---------------------------------------------------------------------------
// Customers

function shapeCustomer(customer: Json, full = false): Json {
  return {
    ...pick(customer, ['id', 'email', 'first_name', 'last_name', 'date_created', 'is_paying_customer']),
    ...(asRecord(customer.billing)
      ? { billing: address(customer.billing, full ? BILLING_FIELDS : ['company', 'city', 'postcode', 'country', 'phone']) }
      : {}),
    ...(full && asRecord(customer.shipping) ? { shipping: address(customer.shipping, ADDRESS_FIELDS) } : {}),
  };
}

export const CUSTOMER_FILTERS = ['search', 'email'] as const;

/** Customers (WordPress users with the customer role, the documented default). Username, role and meta data are left out. */
export async function listCustomers(client: UpstreamClient, input: Json): Promise<Json> {
  const { rows, paging } = await page(client, '/customers', listQuery(input, CUSTOMER_FILTERS));
  return { customers: rows.map(customer => shapeCustomer(customer)), paging };
}

export async function getCustomer(client: UpstreamClient, input: { customerId: number }): Promise<Json> {
  return shapeCustomer(record(await get(client, idPath('customers', input.customerId, 'customerId'))), true);
}

/**
 * Change a customer's name and addresses. The login e-mail, the billing
 * e-mail, the password and the role are never sent.
 */
export async function updateCustomer(client: UpstreamClient, input: Json & { customerId: number }): Promise<Json> {
  const changes: Json = pick(input, ['first_name', 'last_name']);
  const billing = asRecord(input.billing);
  const shipping = asRecord(input.shipping);
  if (billing) changes.billing = pick(billing, [...ADDRESS_FIELDS, 'phone']);
  if (shipping) changes.shipping = pick(shipping, ADDRESS_FIELDS);
  const body = nestedFailuresAsStatus(await client.put(idPath('customers', input.customerId, 'customerId'), changes));
  return shapeCustomer(record(body), true);
}

// ---------------------------------------------------------------------------

/** Work in flight per key (shop identity, kind, order id), in this process only. A key is dropped when done. */
const inFlight = new Map<string, Promise<unknown>>();

async function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = inFlight.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(work);
  const tail = run.catch(() => undefined);
  inFlight.set(key, tail);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === tail) inFlight.delete(key);
  }
}
