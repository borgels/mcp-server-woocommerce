import { z } from 'zod/v4';
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
 * Every answer is parsed with a schema per resource, sub-objects and lists
 * included, after the property tables of the documentation. A field that is
 * present must have its documented type; a record must have the id that was
 * asked for; one entry of a list (or of a sub-list such as the order lines)
 * that does not fit refuses the whole answer. Fields not in a schema are
 * dropped by the parse, so only what a schema names is passed on.
 *
 * Every caller-supplied path segment goes through encodePathParam. Every
 * body passes nestedFailuresAsStatus before it is parsed.
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

// ---------------------------------------------------------------------------
// Schemas, after the documentation's property tables. Optional where a shop or plugin may leave a field out; never a
// different type.

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const idOrZero = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A decimal amount as WooCommerce writes it ("12.50", "-10.00"); some versions send a number. */
const amount = z.union([z.string().regex(/^-?\d{1,15}(\.\d{1,8})?$/), z.number().finite()]);
/** An amount that may be empty ("" for no sale price). */
const optionalAmount = z.union([amount, z.literal('')]);
/** A date-time as WooCommerce writes it (ISO 8601 without zone), or null when not set. */
const dateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/).max(40).nullable();
/** A slug value (status, type, stock status); plugins may add their own, so not a fixed list. */
const slug = z.string().regex(/^[a-z0-9_-]{1,64}$/);
const text = (max: number) => z.string().max(max);

const address = z.object({
  first_name: text(200).optional(),
  last_name: text(200).optional(),
  company: text(200).optional(),
  address_1: text(500).optional(),
  address_2: text(500).optional(),
  city: text(200).optional(),
  state: text(200).optional(),
  postcode: text(50).optional(),
  country: text(10).optional(),
});
const billing = address.extend({ email: text(320).optional(), phone: text(100).optional() });

const lineItem = z.object({
  id,
  name: text(1000).optional(),
  product_id: idOrZero.optional(),
  variation_id: idOrZero.optional(),
  sku: text(200).nullable().optional(),
  quantity: z.number().finite().optional(),
  price: amount.optional(),
  subtotal: amount.optional(),
  total: amount.optional(),
  total_tax: amount.optional(),
});
const shippingLine = z.object({ id, method_title: text(500).optional(), total: amount.optional(), total_tax: amount.optional() });
const feeLine = z.object({ id, name: text(500).optional(), total: amount.optional(), total_tax: amount.optional() });
const couponLine = z.object({ id, code: text(200).optional(), discount: amount.optional() });
const orderRefund = z.object({ id, reason: text(2000).optional(), total: amount });

const order = z.object({
  id,
  parent_id: idOrZero.optional(),
  number: text(100).optional(),
  status: slug,
  currency: text(10).optional(),
  prices_include_tax: z.boolean().optional(),
  date_created: dateTime.optional(),
  date_modified: dateTime.optional(),
  date_paid: dateTime.optional(),
  date_completed: dateTime.optional(),
  discount_total: amount.optional(),
  shipping_total: amount.optional(),
  total: amount.optional(),
  total_tax: amount.optional(),
  customer_id: idOrZero.optional(),
  customer_note: text(10_000).optional(),
  payment_method_title: text(500).optional(),
  created_via: text(100).optional(),
  billing: billing.optional(),
  shipping: address.optional(),
  line_items: z.array(lineItem).max(10_000).optional(),
  shipping_lines: z.array(shippingLine).max(1_000).optional(),
  fee_lines: z.array(feeLine).max(1_000).optional(),
  coupon_lines: z.array(couponLine).max(1_000).optional(),
  refunds: z.array(orderRefund).max(10_000).optional(),
});
type Order = z.infer<typeof order>;

const orderNote = z.object({
  id,
  date_created: dateTime.optional(),
  author: text(200).optional(),
  note: text(100_000).optional(),
  customer_note: z.boolean().optional(),
});

const refund = z.object({
  id,
  date_created: dateTime.optional(),
  amount: amount.optional(),
  reason: text(2000).optional(),
  refunded_payment: z.boolean().optional(),
});

const category = z.object({ id, name: text(500).optional() });
const product = z.object({
  id,
  name: text(1000).optional(),
  sku: text(200).optional(),
  type: slug.optional(),
  status: slug.optional(),
  price: optionalAmount.optional(),
  regular_price: optionalAmount.optional(),
  sale_price: optionalAmount.optional(),
  manage_stock: z.boolean().optional(),
  stock_quantity: z.number().int().nullable().optional(),
  stock_status: slug.optional(),
  total_sales: z.union([z.number().int().min(0), z.string().regex(/^\d{1,15}$/)]).optional(),
  categories: z.array(category).max(1_000).optional(),
  permalink: text(2000).optional(),
  short_description: text(100_000).optional(),
  description: text(1_000_000).optional(),
  date_modified: dateTime.optional(),
  variations: z.array(id).max(10_000).optional(),
});

const customer = z.object({
  id,
  email: text(320).optional(),
  first_name: text(200).optional(),
  last_name: text(200).optional(),
  date_created: dateTime.optional(),
  is_paying_customer: z.boolean().optional(),
  billing: billing.optional(),
  shipping: address.optional(),
});

const salesTotals = z.object({
  sales: amount.optional(),
  orders: z.number().int().min(0).optional(),
  items: z.number().int().min(0).optional(),
  tax: amount.optional(),
  shipping: amount.optional(),
  discount: amount.optional(),
  customers: z.number().int().min(0).optional(),
});
const salesReport = z.object({
  total_sales: amount,
  net_sales: amount.optional(),
  average_sales: amount.optional(),
  total_orders: z.number().int().min(0).optional(),
  total_items: z.number().int().min(0).optional(),
  total_tax: amount.optional(),
  total_shipping: amount.optional(),
  total_refunds: amount.optional(),
  total_discount: amount.optional(),
  totals_grouped_by: slug.optional(),
  totals: z.record(z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/), salesTotals).optional(),
});

/** The answer parsed with the schema, or UnexpectedAnswerError. With `expectedId`, the record must be that one. */
function parse<S extends z.ZodType>(schema: S, body: unknown, expectedId?: number): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw new UnexpectedAnswerError();
  if (expectedId !== undefined && (result.data as { id?: unknown }).id !== expectedId) throw new UnexpectedAnswerError();
  return result.data;
}

/** A list: a JSON array whose every entry fits the schema. */
function parseList<S extends z.ZodType>(schema: S, body: unknown): Array<z.infer<S>> {
  return parse(z.array(schema).max(10_000), body);
}

function idPath(resource: string, recordId: number, name: string): string {
  return `/${resource}/${encodePathParam(String(recordId), name)}`;
}

async function get(client: UpstreamClient, path: string, query?: Record<string, QueryValue>): Promise<unknown> {
  return nestedFailuresAsStatus(await client.get(path, query));
}

async function page<S extends z.ZodType>(
  client: UpstreamClient,
  path: string,
  schema: S,
  query: Record<string, QueryValue>,
): Promise<{ rows: Array<z.infer<S>>; paging: { page: number; perPage: number; total?: number; totalPages?: number } }> {
  const answer = await client.getPage(path, query);
  const rows = parseList(schema, nestedFailuresAsStatus(answer.body));
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

/** The fields of `value` that are listed, leaving out absent ones. */
function pick<T extends object>(value: T, fields: readonly (keyof T & string)[]): Json {
  const out: Json = {};
  for (const field of fields) {
    if (value[field] !== undefined) out[field] = value[field];
  }
  return out;
}

const ADDRESS_FIELDS = ['first_name', 'last_name', 'company', 'address_1', 'address_2', 'city', 'state', 'postcode', 'country'] as const;

// ---------------------------------------------------------------------------
// Connection and reports

/** One cheap read: the first page of orders with one row, for the total. Returns only that the key works. */
export async function checkConnection(client: UpstreamClient): Promise<Json> {
  const { paging } = await page(client, '/orders', order, { per_page: 1 });
  return { connected: true, ...(paging.total === undefined ? {} : { orders: paging.total }) };
}

/**
 * GET /reports/sales: totals for a period (week, month, last_month, year)
 * or between two dates. The documentation answers an array with one report
 * object, which has no id.
 */
export async function getSalesReport(
  client: UpstreamClient,
  input: { period?: string; dateMin?: string; dateMax?: string },
): Promise<Json> {
  const query: Record<string, QueryValue> = input.period
    ? { period: input.period }
    : { date_min: input.dateMin, date_max: input.dateMax };
  const [report, ...rest] = parse(z.array(salesReport).length(1), await get(client, '/reports/sales', query));
  if (!report || rest.length > 0) throw new UnexpectedAnswerError();
  return report;
}

// ---------------------------------------------------------------------------
// Orders

export const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;

function orderRow(value: Order): Json {
  return {
    ...pick(value, [
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
    ]),
    ...(value.billing ? { billing: pick(value.billing, ['first_name', 'last_name', 'company']) } : {}),
    items: value.line_items?.length ?? 0,
  };
}

export const ORDER_FILTERS = ['status', 'customer', 'product', 'search'] as const;

export async function listOrders(client: UpstreamClient, input: Json): Promise<Json> {
  const { rows, paging } = await page(client, '/orders', order, listQuery(input, ORDER_FILTERS, ['after', 'before']));
  return { orders: rows.map(orderRow), paging };
}

/**
 * One order with its lines, addresses, the customer's note and its refunds.
 * Left out (not in the schema): meta data (plugins keep anything there), the
 * customer's IP address and user agent, the order key, the cart hash and the
 * payment provider's transaction id.
 */
export async function getOrder(client: UpstreamClient, input: { orderId: number }): Promise<Json> {
  return parse(order, await get(client, idPath('orders', input.orderId, 'orderId')), input.orderId);
}

export async function listOrderNotes(client: UpstreamClient, input: { orderId: number; type?: string }): Promise<Json> {
  return { notes: parseList(orderNote, await get(client, `${idPath('orders', input.orderId, 'orderId')}/notes`, { type: input.type })) };
}

export async function listOrderRefunds(client: UpstreamClient, input: { orderId: number }): Promise<Json> {
  return { refunds: parseList(refund, await get(client, `${idPath('orders', input.orderId, 'orderId')}/refunds`)) };
}

/** Statuses an order may be moved to here. Not refunded, failed, pending or trash. */
export const SETTABLE_ORDER_STATUSES = ['processing', 'on-hold', 'completed', 'cancelled'] as const;

/**
 * Move an order to another status. Reads it first and refuses, without
 * sending anything, an order that is refunded, failed or in the trash, or
 * that already has the status. The answer must be the same order with the
 * new status.
 */
export async function updateOrderStatus(client: UpstreamClient, input: { orderId: number; status: string }): Promise<Json> {
  const path = idPath('orders', input.orderId, 'orderId');
  return serialised(`${client.shopIdentity()}:order:${input.orderId}`, async () => {
    const current = parse(order, await get(client, path), input.orderId);
    if (current.status === input.status) throw new Error('Refused: the order already has that status. Nothing was sent.');
    if (current.status === 'refunded' || current.status === 'failed' || current.status === 'trash') {
      throw new Error('Refused: a refunded, failed or deleted order is not changed here. Nothing was sent.');
    }
    const changed = parse(order, nestedFailuresAsStatus(await client.put(path, { status: input.status })), input.orderId);
    if (changed.status !== input.status) throw new UnexpectedAnswerError();
    return pick(changed, ['id', 'number', 'status', 'date_modified']);
  });
}

/** A private note: `customer_note` is always false, so the customer is never notified. */
export async function addOrderNote(client: UpstreamClient, input: { orderId: number; note: string }): Promise<Json> {
  const body = nestedFailuresAsStatus(
    await client.post(`${idPath('orders', input.orderId, 'orderId')}/notes`, { note: input.note, customer_note: false }),
  );
  return parse(orderNote, body);
}

/**
 * Record a refund on an order in the shop, without refunding any money:
 * `api_refund` is sent as false (its documented default is true, which asks
 * the payment gateway to pay the money back) and `api_restock` as false.
 * The money is refunded by a person in the payment provider.
 *
 * Reads the order first and refuses, without sending anything, when it is
 * not processing, on-hold or completed, the currency differs or is not
 * known, the order has no refunds list, or the amount is more than the
 * total less what is already refunded. One refund at a time per shop and
 * order in this process.
 */
export async function recordRefund(
  client: UpstreamClient,
  input: { orderId: number; amount: number; currency: string; reason?: string },
): Promise<Json> {
  const path = idPath('orders', input.orderId, 'orderId');
  return serialised(`${client.shopIdentity()}:refund:${input.orderId}`, async () => {
    const current = parse(order, await get(client, path), input.orderId);
    if (!['processing', 'on-hold', 'completed'].includes(current.status)) {
      throw new Error('Refused: only a processing, on-hold or completed order can get a refund here. Nothing was sent.');
    }
    if (!isCurrency(current.currency) || current.currency !== input.currency) {
      throw new Error('Refused: the currency is not the order\'s, or the order\'s currency is not known. Nothing was sent.');
    }
    const total = money(current.total);
    if (total === undefined || total <= 0) throw new Error('Refused: the order has no positive total. Nothing was sent.');
    // Every earlier refund counts: an order without its refunds list is refused (each entry was checked by the parse).
    if (!current.refunds) throw new UnexpectedAnswerError();
    const refunds = current.refunds.map(entry => money(entry.total));
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
    return parse(refund, body);
  });
}

// ---------------------------------------------------------------------------
// Products

type Product = z.infer<typeof product>;

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
  'categories',
] as const;

function productRow(value: Product): Json {
  return pick(value, PRODUCT_ROW);
}

export const PRODUCT_FILTERS = ['search', 'sku', 'status', 'stock_status', 'category', 'type'] as const;

export async function listProducts(client: UpstreamClient, input: Json): Promise<Json> {
  const { rows, paging } = await page(client, '/products', product, listQuery(input, PRODUCT_FILTERS));
  return { products: rows.map(productRow), paging };
}

export async function getProduct(client: UpstreamClient, input: { productId: number }): Promise<Json> {
  return parse(product, await get(client, idPath('products', input.productId, 'productId')), input.productId);
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

function given(input: Json, fields: readonly string[]): Json {
  const out: Json = {};
  for (const field of fields) if (input[field] !== undefined) out[field] = input[field];
  return out;
}

/** A new simple product, always as a draft (the documented default status is publish). The answer must be a draft. */
export async function createDraftProduct(client: UpstreamClient, input: Json): Promise<Json> {
  const body = nestedFailuresAsStatus(
    await client.post('/products', { ...given(input, PRODUCT_WRITABLE), type: 'simple', status: 'draft' }),
  );
  const created = parse(product, body);
  if (created.status !== undefined && created.status !== 'draft') throw new UnexpectedAnswerError();
  return productRow(created);
}

/** Change the fields given on a product; fields left out stay as they are. */
export async function updateProduct(client: UpstreamClient, input: Json & { productId: number }): Promise<Json> {
  const body = nestedFailuresAsStatus(
    await client.put(idPath('products', input.productId, 'productId'), given(input, [...PRODUCT_WRITABLE, 'status'])),
  );
  return productRow(parse(product, body, input.productId));
}

// ---------------------------------------------------------------------------
// Customers

type Customer = z.infer<typeof customer>;

function customerRow(value: Customer): Json {
  return {
    ...pick(value, ['id', 'email', 'first_name', 'last_name', 'date_created', 'is_paying_customer']),
    ...(value.billing ? { billing: pick(value.billing, ['company', 'city', 'postcode', 'country', 'phone']) } : {}),
  };
}

export const CUSTOMER_FILTERS = ['search', 'email'] as const;

/** Customers (WordPress users with the customer role, the documented default). Username, role and meta data are left out. */
export async function listCustomers(client: UpstreamClient, input: Json): Promise<Json> {
  const { rows, paging } = await page(client, '/customers', customer, listQuery(input, CUSTOMER_FILTERS));
  return { customers: rows.map(customerRow), paging };
}

export async function getCustomer(client: UpstreamClient, input: { customerId: number }): Promise<Json> {
  return parse(customer, await get(client, idPath('customers', input.customerId, 'customerId')), input.customerId);
}

/**
 * Change a customer's name and addresses. The login e-mail, the billing
 * e-mail, the password and the role are never sent.
 */
export async function updateCustomer(client: UpstreamClient, input: Json & { customerId: number }): Promise<Json> {
  const changes: Json = given(input, ['first_name', 'last_name']);
  const asObject = (value: unknown) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined);
  const billingInput = asObject(input.billing);
  const shippingInput = asObject(input.shipping);
  if (billingInput) changes.billing = given(billingInput, [...ADDRESS_FIELDS, 'phone']);
  if (shippingInput) changes.shipping = given(shippingInput, ADDRESS_FIELDS);
  const body = nestedFailuresAsStatus(await client.put(idPath('customers', input.customerId, 'customerId'), changes));
  return parse(customer, body, input.customerId);
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
