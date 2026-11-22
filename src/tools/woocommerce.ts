import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHmac, createHash } from 'node:crypto';
import { z } from 'zod/v4';
import {
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WRITE_TOOL_ANNOTATIONS,
} from '../woocommerce/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../woocommerce/audit.js';
import { readOnlyClient, type UpstreamClient } from '../woocommerce/client.js';
import { formatUnknownError, redactDeep, type SecretRedactor } from '../errors.js';
import { withheldResult } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import {
  addOrderNote,
  checkConnection,
  createDraftProduct,
  getCustomer,
  getOrder,
  getProduct,
  getSalesReport,
  listCustomers,
  listOrderNotes,
  listOrderRefunds,
  listOrders,
  listProducts,
  MAX_PER_PAGE,
  ORDER_STATUSES,
  recordRefund,
  refundPayment,
  SETTABLE_ORDER_STATUSES,
  updateCustomer,
  updateOrderStatus,
  updateProduct,
} from '../woocommerce/resources.js';
import {
  checkInputPolicy,
  checkToolPolicy,
  currentInstancePolicy,
  isToolDisabled,
  redactInScope,
  runInCallScope,
  validatePolicyConfig,
} from '../woocommerce/policy.js';
import { CURRENCY_PATTERN, isAmount, isCurrency, isIsoDate, isRecordId, MAX_AMOUNT, PRICE_PATTERN } from '../woocommerce/values.js';

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the HTTP method
 * and the path template relative to the REST API base (`{name}` marks a
 * caller-supplied segment). Published in the gateway tool catalog so a host
 * can see what each tool touches; keep it in step with the handler.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  method: 'GET' | 'POST' | 'PUT';
  path: string;
}

/** A client that carries the redactor of its instance (WooCommerceClient does). */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
}

/** What a write tool does. */
export type WooCommerceChangeAction = 'create' | 'update' | 'set_status' | 'add_note' | 'record_refund' | 'refund_payment';

/** The kind of record a write tool touches. */
export type WooCommerceChangeRecord = 'order' | 'order_note' | 'refund' | 'product' | 'customer';

/**
 * The type a logged value must have; anything else is left out of the values.
 *   recordId  a WooCommerce id (a positive integer), in clear
 *   amount    a positive amount of at most two decimals, in clear
 *   currency  an ISO 4217 code, in clear
 *   date      a date YYYY-MM-DD, in clear
 *   count     the number of entries in a list, never the entries
 *   flag      true or false, in clear
 *   kind      one value from a fixed list the tool's schema allows, in clear
 *   pseudonym a value the shop chose (a SKU). It can be any text, so it is
 *             never logged in clear: "sha256:" and 16 hex characters, or
 *             "hmac:" with a key from the host.
 * Names, addresses, notes, reasons and other free text are never log fields.
 */
export type WooCommerceLogFieldType = 'recordId' | 'amount' | 'currency' | 'date' | 'count' | 'flag' | 'kind' | 'pseudonym';

export interface WooCommerceLogField {
  readonly name: string;
  readonly type: WooCommerceLogFieldType;
}

/**
 * Write tools only: what the change does, for a host that logs a change
 * before it is sent. `logFields` are the input fields that identify it, each
 * with the one type its value must have.
 */
export interface WooCommerceChangeSpec {
  readonly action: WooCommerceChangeAction;
  readonly record: WooCommerceChangeRecord;
  /**
   * True only for refund_payment, which has the payment gateway pay money back (api_refund true). A recorded refund
   * (record_refund) is an entry in the shop; api_refund is false.
   */
  readonly movesMoney: boolean;
  readonly logFields: readonly WooCommerceLogField[];
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`woocommerce_*`). The gateway exposes it without the prefix. */
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** Strict object built from inputShape: unknown arguments are rejected. */
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Whether the result carries upstream content (vs. server metadata). */
  returnsUpstreamContent: boolean;
  /** Short human-readable summary used by the gateway result text. */
  summary: string;
  /** Every upstream request the handler may make. */
  upstream: readonly UpstreamOperation[];
  /** True when the tool can read more than its name says. None of these tools does. */
  broad?: boolean;
  /** Write tools: what the change does. */
  change?: WooCommerceChangeSpec;
  /** True when a person should confirm each call outside the chat before it runs: a refund that moves money. */
  requiresConfirmation?: boolean;
  /** Cross-field checks the schema shape cannot express. Returns a refusal or undefined. */
  check?: (input: Record<string, unknown>) => string | undefined;
  /**
   * Read-only tools (readOnlyHint) receive a client view that refuses
   * non-GET requests, so a mis-annotated tool cannot write.
   */
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(definition: Omit<ToolDefinition<S>, 'inputSchema'>): ToolDefinition {
  const description = definition.returnsUpstreamContent
    ? `${definition.description} ${UNTRUSTED_CONTENT_NOTE}`
    : definition.description;
  return {
    ...definition,
    description,
    inputSchema: z.strictObject(definition.inputShape),
  } as unknown as ToolDefinition;
}

const change = (
  action: WooCommerceChangeAction,
  record: WooCommerceChangeRecord,
  logFields: Record<string, WooCommerceLogFieldType>,
  movesMoney = false,
): WooCommerceChangeSpec => ({
  action,
  record,
  movesMoney,
  logFields: Object.entries(logFields).map(([name, type]) => ({ name, type })),
});

// ---------------------------------------------------------------------------
// Schemas

const recordId = (what: string) => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(what);
const dateSchema = z.string().trim().refine(isIsoDate, 'must be a date written YYYY-MM-DD');
const text = (max: number) => z.string().trim().min(1).max(max);
const priceSchema = z.string().trim().regex(PRICE_PATTERN).describe('A price as a decimal string, e.g. "199.95".');
const pageShape = {
  page: z.number().int().min(1).max(10_000).optional().describe('Page number, from 1 (default 1).'),
  perPage: z.number().int().min(1).max(MAX_PER_PAGE).optional().describe(`Rows per page (default 20, at most ${MAX_PER_PAGE}).`),
  order: z.enum(['asc', 'desc']).optional().describe('Sort direction.'),
};
const addressShape = {
  first_name: text(100).optional(),
  last_name: text(100).optional(),
  company: text(200).optional(),
  address_1: text(200).optional(),
  address_2: text(200).optional(),
  city: text(100).optional(),
  state: text(100).optional(),
  postcode: text(20).optional(),
  country: z.string().trim().regex(/^[A-Z]{2}$/).optional().describe('ISO 3166-1 alpha-2, e.g. DK.'),
};

const productFieldsShape = {
  sku: text(100).optional().describe('Stock keeping unit; must be unique in the shop.'),
  regular_price: priceSchema.optional(),
  sale_price: z.union([priceSchema, z.literal('')]).optional().describe('Sale price as a decimal string, or "" to end the sale.'),
  description: text(10_000).optional(),
  short_description: text(2_000).optional(),
  manage_stock: z.boolean().optional().describe('Keep stock for the product.'),
  stock_quantity: z.number().int().min(0).max(10_000_000).optional().describe('Stock quantity (with manage_stock).'),
  stock_status: z.enum(['instock', 'outofstock', 'onbackorder']).optional(),
};

/** The input of a refund: recorded only (record_refund) or paid back through the payment gateway (refund_payment). */
const refundShape = (amountText: string) => ({
  orderId: recordId('The order id.'),
  amount: z
    .number()
    .refine(isAmount, `must be more than 0 and at most ${MAX_AMOUNT}, with at most two decimals`)
    .describe(amountText),
  currency: z.string().trim().regex(CURRENCY_PATTERN).describe("The order's currency, e.g. DKK, as a check."),
  reason: text(500).optional().describe('Reason for the refund, kept on the order.'),
});

function atLeastOneChange(fields: readonly string[]) {
  return (input: Record<string, unknown>): string | undefined =>
    fields.some(field => input[field] !== undefined) ? undefined : 'Nothing to change: give at least one field.';
}

const WRITE_NOTE = 'Off unless writes are enabled (WOOCOMMERCE_ENABLE_WRITES, or the gateway host policy enableWrites).';

export const WOOCOMMERCE_TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'woocommerce_check_connection',
    title: 'Check WooCommerce connection',
    description: 'Check that the shop address and API key work, by reading one order. Returns only whether it works and the number of orders.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Checked the connection.',
    upstream: [{ access: 'read', method: 'GET', path: '/orders' }],
    handler: async client => checkConnection(client),
  }),
  defineTool({
    name: 'woocommerce_get_sales_report',
    title: 'Sales report (WooCommerce)',
    description:
      'Totals for a period: gross and net sales, orders, items, tax, shipping, refunds and discounts, also per day or month. No customers or orders, only sums.',
    inputShape: {
      period: z.enum(['week', 'month', 'last_month', 'year']).optional().describe('A fixed period. Or give dateMin and dateMax.'),
      dateMin: dateSchema.optional().describe('First day, YYYY-MM-DD.'),
      dateMax: dateSchema.optional().describe('Last day, YYYY-MM-DD.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched the sales report.',
    upstream: [{ access: 'read', method: 'GET', path: '/reports/sales' }],
    check: input => {
      if (input.period !== undefined) return input.dateMin !== undefined || input.dateMax !== undefined ? 'Give period or dates, not both.' : undefined;
      if (input.dateMin === undefined || input.dateMax === undefined) return 'Give period, or both dateMin and dateMax.';
      return String(input.dateMax) < String(input.dateMin) ? 'dateMax is before dateMin.' : undefined;
    },
    handler: async (client, input) => getSalesReport(client, input),
  }),
  defineTool({
    name: 'woocommerce_list_orders',
    title: 'List orders (WooCommerce)',
    description:
      'Orders, one page at a time, newest first: number, status, total, VAT, dates, customer id and name, payment method and number of lines. Filters as WooCommerce documents them.',
    inputShape: {
      status: z.enum(ORDER_STATUSES).optional().describe('Only orders with this status.'),
      customer: recordId('Only orders of this customer id.').optional(),
      product: recordId('Only orders with this product id.').optional(),
      search: text(100).optional().describe('Text to search for.'),
      after: dateSchema.optional().describe('Only orders created after this date, YYYY-MM-DD.'),
      before: dateSchema.optional().describe('Only orders created before this date, YYYY-MM-DD.'),
      orderby: z.enum(['date', 'modified', 'id']).optional(),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed orders.',
    upstream: [{ access: 'read', method: 'GET', path: '/orders' }],
    handler: async (client, input) => listOrders(client, input),
  }),
  defineTool({
    name: 'woocommerce_get_order',
    title: 'Get order (WooCommerce)',
    description:
      "One order with its lines, shipping, fees, coupons, refunds, billing and shipping address and the customer's note. The customer's IP address, browser, order key, transaction id and meta data are left out.",
    inputShape: { orderId: recordId('The order id (not the order number), from list_orders.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched order.',
    upstream: [{ access: 'read', method: 'GET', path: '/orders/{orderId}' }],
    handler: async (client, input) => getOrder(client, input),
  }),
  defineTool({
    name: 'woocommerce_list_order_notes',
    title: 'List order notes (WooCommerce)',
    description: 'The notes on an order: private notes and notes the customer was sent.',
    inputShape: {
      orderId: recordId('The order id.'),
      type: z.enum(['any', 'customer', 'internal']).optional().describe('any (default), customer or internal.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed order notes.',
    upstream: [{ access: 'read', method: 'GET', path: '/orders/{orderId}/notes' }],
    handler: async (client, input) => listOrderNotes(client, input),
  }),
  defineTool({
    name: 'woocommerce_list_order_refunds',
    title: 'List order refunds (WooCommerce)',
    description: 'The refunds of an order: amount, reason, and whether the money was refunded through the payment gateway.',
    inputShape: { orderId: recordId('The order id.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed refunds.',
    upstream: [{ access: 'read', method: 'GET', path: '/orders/{orderId}/refunds' }],
    handler: async (client, input) => listOrderRefunds(client, input),
  }),
  defineTool({
    name: 'woocommerce_list_products',
    title: 'List products (WooCommerce)',
    description: 'Products, one page at a time: name, SKU, type, status, prices, stock and categories. Filters as WooCommerce documents them.',
    inputShape: {
      search: text(100).optional().describe('Text to search for.'),
      sku: text(100).optional().describe('One SKU.'),
      status: z.enum(['any', 'draft', 'pending', 'private', 'publish']).optional(),
      stock_status: z.enum(['instock', 'outofstock', 'onbackorder']).optional(),
      category: z.string().trim().regex(/^\d{1,18}$/).optional().describe('A category id.'),
      type: z.enum(['simple', 'grouped', 'external', 'variable']).optional(),
      orderby: z.enum(['date', 'modified', 'id', 'title', 'price', 'popularity']).optional(),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed products.',
    upstream: [{ access: 'read', method: 'GET', path: '/products' }],
    handler: async (client, input) => listProducts(client, input),
  }),
  defineTool({
    name: 'woocommerce_get_product',
    title: 'Get product (WooCommerce)',
    description: 'One product with prices, stock, categories and descriptions. A variable product lists the ids of its variations.',
    inputShape: { productId: recordId('The product id.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched product.',
    upstream: [{ access: 'read', method: 'GET', path: '/products/{productId}' }],
    handler: async (client, input) => getProduct(client, input),
  }),
  defineTool({
    name: 'woocommerce_list_customers',
    title: 'List customers (WooCommerce)',
    description:
      'Registered customers, one page at a time: name, e-mail, company, city and phone. Guests who ordered without an account are only on their orders.',
    inputShape: {
      search: text(100).optional().describe('Text to search for.'),
      email: z.email().max(200).optional().describe('One e-mail address.'),
      orderby: z.enum(['id', 'name', 'registered_date']).optional(),
      ...pageShape,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed customers.',
    upstream: [{ access: 'read', method: 'GET', path: '/customers' }],
    handler: async (client, input) => listCustomers(client, input),
  }),
  defineTool({
    name: 'woocommerce_get_customer',
    title: 'Get customer (WooCommerce)',
    description: 'One customer with billing and shipping address. Username, role and meta data are left out.',
    inputShape: { customerId: recordId('The customer id.') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched customer.',
    upstream: [{ access: 'read', method: 'GET', path: '/customers/{customerId}' }],
    handler: async (client, input) => getCustomer(client, input),
  }),

  // -------------------------------------------------------------------------
  // Writes. No tool deletes, refunds money through a payment gateway, creates or changes coupons, users, settings or
  // payment methods, sends a customer note or uses a batch endpoint.

  defineTool({
    name: 'woocommerce_update_order_status',
    title: 'Change order status (WooCommerce)',
    description: `Move an order to processing, on-hold, completed or cancelled. Reads it first and refuses an order that is refunded, failed or deleted, or already has the status. WooCommerce may e-mail the customer as the shop's e-mail settings say (for example when an order is completed). No money moves. ${WRITE_NOTE}`,
    inputShape: {
      orderId: recordId('The order id.'),
      status: z.enum(SETTABLE_ORDER_STATUSES).describe('processing, on-hold, completed or cancelled.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Changed order status.',
    upstream: [
      { access: 'read', method: 'GET', path: '/orders/{orderId}' },
      { access: 'write', method: 'PUT', path: '/orders/{orderId}' },
    ],
    change: change('set_status', 'order', { orderId: 'recordId', status: 'kind' }),
    handler: async (client, input) => updateOrderStatus(client, input),
  }),
  defineTool({
    name: 'woocommerce_add_order_note',
    title: 'Add private order note (WooCommerce)',
    description: `Add a private note to an order, for the shop's staff. The customer is never notified: customer_note is always false. ${WRITE_NOTE}`,
    inputShape: { orderId: recordId('The order id.'), note: text(2000).describe('The note.') },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Added order note.',
    upstream: [{ access: 'write', method: 'POST', path: '/orders/{orderId}/notes' }],
    change: change('add_note', 'order_note', { orderId: 'recordId' }),
    handler: async (client, input) => addOrderNote(client, input),
  }),
  defineTool({
    name: 'woocommerce_record_refund',
    title: 'Record refund (WooCommerce)',
    description: `Record a refund on an order in the shop, without paying any money back: api_refund is always false, so the payment gateway is not asked to refund. The money is refunded by a person in the payment provider, or with refund_payment. Stock is not restocked. Reads the order first and refuses when it is not processing, on-hold or completed, the currency differs, or the amount is more than is left to refund. Refunds of one order run one at a time in this server. ${WRITE_NOTE}`,
    inputShape: refundShape('Amount to record as refunded, in the order currency.'),
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Recorded refund.',
    upstream: [
      { access: 'read', method: 'GET', path: '/orders/{orderId}' },
      { access: 'write', method: 'POST', path: '/orders/{orderId}/refunds' },
    ],
    change: change('record_refund', 'refund', { orderId: 'recordId', amount: 'amount', currency: 'currency' }),
    handler: async (client, input) => recordRefund(client, input),
  }),
  defineTool({
    name: 'woocommerce_refund_payment',
    title: 'Refund payment through the payment gateway (WooCommerce)',
    description: `Refund money on an order to the customer through the order's payment gateway: the refund is created with api_refund true, so the payment gateway pays the amount back. This moves money and cannot be undone; a person should confirm each call outside the chat. When the gateway cannot refund, the shop answers with an error and keeps no refund. Stock is not restocked. Reads the order first and refuses when it is not processing, on-hold or completed, the currency differs, or the amount is more than is left to refund. Refunds of one order run one at a time in this server. ${WRITE_NOTE}`,
    inputShape: refundShape('Amount to pay back, in the order currency.'),
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Refunded payment.',
    upstream: [
      { access: 'read', method: 'GET', path: '/orders/{orderId}' },
      { access: 'write', method: 'POST', path: '/orders/{orderId}/refunds' },
    ],
    change: change('refund_payment', 'refund', { orderId: 'recordId', amount: 'amount', currency: 'currency' }, true),
    requiresConfirmation: true,
    handler: async (client, input) => refundPayment(client, input),
  }),
  defineTool({
    name: 'woocommerce_create_draft_product',
    title: 'Create draft product (WooCommerce)',
    description: `Create a simple product as a draft; it is not shown in the shop until someone publishes it. ${WRITE_NOTE}`,
    inputShape: { name: text(200).describe('Product name.'), ...productFieldsShape },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created draft product.',
    upstream: [{ access: 'write', method: 'POST', path: '/products' }],
    change: change('create', 'product', { sku: 'pseudonym', manage_stock: 'flag' }),
    handler: async (client, input) => createDraftProduct(client, input),
  }),
  defineTool({
    name: 'woocommerce_update_product',
    title: 'Update product (WooCommerce)',
    description: `Change the fields given on a product: name, SKU, prices, descriptions, stock or status (draft, pending, private, publish). Fields left out stay as they are. Variations of a variable product are not changed here. ${WRITE_NOTE}`,
    inputShape: {
      productId: recordId('The product id.'),
      name: text(200).optional(),
      status: z.enum(['draft', 'pending', 'private', 'publish']).optional(),
      ...productFieldsShape,
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Updated product.',
    upstream: [{ access: 'write', method: 'PUT', path: '/products/{productId}' }],
    change: change('update', 'product', { productId: 'recordId', status: 'kind', stock_status: 'kind', manage_stock: 'flag' }),
    check: atLeastOneChange(['name', 'status', ...Object.keys(productFieldsShape)]),
    handler: async (client, input) => updateProduct(client, input),
  }),
  defineTool({
    name: 'woocommerce_update_customer',
    title: 'Update customer (WooCommerce)',
    description: `Change a customer's name, billing address and phone, or shipping address. The login e-mail, the billing e-mail, the password and the role cannot be changed here. ${WRITE_NOTE}`,
    inputShape: {
      customerId: recordId('The customer id.'),
      first_name: text(100).optional(),
      last_name: text(100).optional(),
      billing: z.strictObject({ ...addressShape, phone: text(50).optional() }).optional(),
      shipping: z.strictObject(addressShape).optional(),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Updated customer.',
    upstream: [{ access: 'write', method: 'PUT', path: '/customers/{customerId}' }],
    change: change('update', 'customer', { customerId: 'recordId' }),
    check: atLeastOneChange(['first_name', 'last_name', 'billing', 'shipping']),
    handler: async (client, input) => updateCustomer(client, input),
  }),
];

/**
 * Validate a write call's input exactly as executeTool does before it sends
 * anything: the strict schema, then the tool's own cross-field check. Used
 * by the change resolution, so a call it accepts is one that would run.
 */
export function validateCall(tool: ToolDefinition, input: unknown): { ok: true; data: Record<string, unknown> } | { ok: false } {
  const parsed = tool.inputSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false };
  const data = parsed.data as Record<string, unknown>;
  return tool.check?.(data) ? { ok: false } : { ok: true, data };
}

export function findTool(name: string): ToolDefinition | undefined {
  return WOOCOMMERCE_TOOLS.find(tool => tool.name === name);
}

/** The pseudonym of a value: HMAC-SHA-256 with the host's key, else SHA-256; 16 hex characters with a prefix. */
export function pseudonym(value: string, key?: string | Uint8Array): string {
  if (key !== undefined && key.length > 0) {
    return `hmac:${createHmac('sha256', key).update(value).digest('hex').slice(0, 16)}`;
  }
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

/** A fixed word of ours or the shop's (a status such as `on-hold`). */
const KIND_VALUES = /^[A-Za-z][A-Za-z_-]{0,19}$/;

/**
 * The value of one log field when it has exactly the field's type; otherwise
 * undefined. A number the company chose comes back only as a pseudonym.
 */
export function logFieldValue(
  type: WooCommerceLogFieldType,
  value: unknown,
  pseudonymKey?: string | Uint8Array,
): string | number | boolean | undefined {
  switch (type) {
    case 'recordId':
      return isRecordId(value) ? value : undefined;
    case 'amount':
      return isAmount(value) ? value : undefined;
    case 'currency':
      return isCurrency(value) ? value : undefined;
    case 'date':
      return isIsoDate(value) ? value : undefined;
    case 'count':
      return Array.isArray(value) ? value.length : undefined;
    case 'flag':
      return typeof value === 'boolean' ? value : undefined;
    case 'kind':
      return typeof value === 'string' && KIND_VALUES.test(value) ? value : undefined;
    case 'pseudonym':
      return typeof value === 'string' && value.length > 0 && value.length <= 100 ? pseudonym(value, pseudonymKey) : undefined;
    default:
      return undefined;
  }
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(WOOCOMMERCE_TOOLS.map(tool => tool.name));
}

/**
 * Startup checks for entry points (transports, gateway): tool policy plus a
 * writable audit log. The audit check is not repeated per HTTP request, so
 * read tools keep working if the log becomes unwritable later; write tools
 * then fail closed when their start record cannot be written.
 */
export function validateStartupConfig(): void {
  validateToolConfig();
  assertAuditLogWritable();
}

/** Tools enabled on this instance (WOOCOMMERCE_DISABLED_TOOLS removes them entirely). */
export function enabledTools(): ToolDefinition[] {
  return WOOCOMMERCE_TOOLS.filter(tool => !isToolDisabled(tool.name));
}

export function registerTools(server: McpServer, client: RedactingClient): void {
  validateToolConfig();
  for (const tool of enabledTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) => {
        let result: { content: Array<{ type: 'text'; text: string }>; isError?: true };
        try {
          // In a scope with this server's redactor, like a gateway call: audit records and context are redacted.
          const data = await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input));
          // Shop data can echo the key, in values or in object keys: redacted as data before it is serialised (a
          // serialised key is escaped and no longer matches), as on the gateway.
          result = mcpToolResult(tool, redactDeep(redactDeep(data, client.redactor), client.redactor));
        } catch (error) {
          // Central redaction with this instance's secrets: no error text reaches the client unredacted.
          result = { isError: true, content: [{ type: 'text' as const, text: formatUnknownError(error, client.redactor) }] };
        }
        // The same last check as the gateway: a result that still holds a piece of the key or secret is withheld whole.
        return leaksSecret(result, client.redactor) ? withheldResult() : result;
      },
    );
  }
}

/** Optional call context supplied by an embedding host. */
export interface CallContext {
  /** Caller identity, recorded in audit events. */
  caller?: string;
  /** Request id to reuse in audit events, for correlation with the host's own log. */
  requestId?: string;
}

function contextString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Redacted before it is cut short: a cut key would no longer match the redactor.
  const trimmed = redactInScope(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * The audit's view of a call context. Nothing the host sends is kept in
 * clear: a request id may be any text (a name, a phone number, an address),
 * so the audit keeps its pseudonym, which still ties the lines of one call
 * together for the host that knows the key; without a request id the audit
 * makes one. The caller becomes a pseudonym the same way. Both are keyed
 * with the host's policy.pseudonymKey when given.
 */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  const key = currentInstancePolicy()?.pseudonymKey;
  const given = typeof value.requestId === 'string' && value.requestId.length > 0 ? value.requestId.slice(0, 1000) : undefined;
  const requestId = given === undefined ? newRequestId() : pseudonym(given, key);
  const caller = contextString(value.caller, 320);
  return {
    requestId,
    ...(caller === undefined ? {} : { caller: pseudonym(caller, key) }),
  };
}

/**
 * Run one validated tool call through the instance policy and the audit
 * log. Used by both the MCP server and the gateway entry point.
 */
export async function executeTool(
  tool: ToolDefinition,
  client: RedactingClient,
  input: Record<string, unknown>,
  context?: CallContext,
): Promise<unknown> {
  const { requestId, caller } = normaliseCallContext(context);
  const target = auditTarget(input);
  const { redactor } = client;

  const policy = checkToolPolicy(tool.name, tool.annotations.readOnlyHint);
  const inputPolicy = policy.allowed ? checkInputPolicy(tool.name, input) : policy;
  const refusal = inputPolicy.allowed ? tool.check?.(input) : undefined;
  if (!inputPolicy.allowed || refusal) {
    const reason = inputPolicy.allowed ? (refusal as string) : inputPolicy.reason;
    await writeAuditEvent({ requestId, tool: tool.name, caller, action: 'policy_denied', target, reason }, { redactor });
    throw new Error(reason);
  }

  // Write tools fail closed: no write runs without its start record.
  await writeAuditEvent(
    { requestId, tool: tool.name, caller, action: 'start', target, reason: policy.reason },
    { required: !tool.annotations.readOnlyHint, redactor },
  );
  const startedAt = performance.now();

  try {
    const handlerClient = tool.annotations.readOnlyHint ? readOnlyClient(client, tool.name) : client;
    const result = await tool.handler(handlerClient, input as never);
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'finish',
      target,
      status: 'ok',
      durationMs: Math.round(performance.now() - startedAt),
    }, { redactor });
    return result;
  } catch (error) {
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'error',
      target,
      status: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      error,
    }, { redactor });
    throw error;
  }
}

/** Why a call was rejected before it ran: a fixed code, never text from the caller. */
export type RejectionCode = 'unknown_tool' | 'invalid_input';

/**
 * Audit a call rejected before execution (unknown tool or invalid input).
 * The record holds only what we wrote: a known tool name (an unknown one is
 * recorded as `unknown` with a pseudonym of what was given), the argument
 * names that the tool's schema knows, the number of other arguments, and a
 * fixed code. A caller can put a name or a text anywhere, so nothing it
 * chose is logged in clear.
 */
export async function auditRejectedCall(
  toolName: string,
  input: unknown,
  code: RejectionCode,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const tool = typeof toolName === 'string' ? findTool(toolName) : undefined;
  const known = new Set(tool ? Object.keys(tool.inputShape) : []);
  const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [];
  const fields = keys.filter(key => known.has(key)).sort();
  await writeAuditEvent({
    requestId,
    tool: tool ? tool.name : 'unknown',
    caller,
    action: 'rejected',
    target: {
      ...(tool ? {} : { toolPseudonym: pseudonym(String(toolName).slice(0, 200)) }),
      fields,
      otherFields: keys.length - fields.length,
    },
    reason: code,
  });
}

/** Compact JSON (no pretty-printing): indentation only costs tokens. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data ?? null);
}

function mcpToolResult(tool: ToolDefinition, data: unknown) {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactJson(data) }];
  if (tool.returnsUpstreamContent) {
    content.push({ type: 'text', text: UNTRUSTED_RESULT_NOTE });
  }
  return { content };
}
