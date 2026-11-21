import { ConfigError, readEnvBoolean, readEnvInteger, readEnvString, type Env } from '../config-env.js';
import { WooCommerceHttpError, describeUrl, parseRetryAfterMs, requestIdFrom, SecretRedactor } from '../errors.js';
import { createHash } from 'node:crypto';
import { USER_AGENT } from '../version.js';
import ipaddr from 'ipaddr.js';
import { pinnedFetch, systemResolve, type ResolveHost } from './network.js';


export interface WooCommerceClientOptions {
  /** REST API consumer key (ck_...). When omitted, read from WOOCOMMERCE_CONSUMER_KEY in `credentialEnv`. */
  consumerKey?: string;
  /** REST API consumer secret (cs_...). When omitted, read from WOOCOMMERCE_CONSUMER_SECRET in `credentialEnv`. */
  consumerSecret?: string;
  /** The shop's address, e.g. https://shop.example.dk. When omitted, read from WOOCOMMERCE_SHOP_URL in `credentialEnv`. */
  shopUrl?: string;
  /**
   * Where omitted credentials (consumerKey, consumerSecret, shopUrl) are read
   * from. Defaults to process.env for the standalone server. The gateway
   * passes `{}`, so an embedded instance only ever uses what it was given.
   */
  credentialEnv?: Env;
  /**
   * Allow a shop on a loopback or private address, or over http on loopback
   * (env WOOCOMMERCE_ALLOW_PRIVATE_HOST). For local development only; never
   * under a gateway host policy.
   */
  allowPrivateHost?: boolean;
  /**
   * Resolves the shop's host name for each new connection of the built-in
   * fetch (default: the system resolver). Every address must be public, and
   * the connection goes to the address checked (see network.ts). Not used
   * when `fetchImpl` is given: the host that supplies the fetch decides where
   * it connects.
   */
  resolveHost?: ResolveHost;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout covering headers and body (default 30 s, env WOOCOMMERCE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Maximum number of concurrent upstream requests from this client (default 4, env WOOCOMMERCE_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Largest successful response body read, in bytes (default 10 MB, env WOOCOMMERCE_MAX_RESPONSE_BYTES). */
  maxResponseBytes?: number;
  /** Total attempts for idempotent GETs on 429/502/503/504 and transient network errors (default 3). */
  maxAttempts?: number;
  /** Base delay of the exponential backoff between retries (default 500 ms). */
  retryBaseDelayMs?: number;
  /**
   * Total time one call may spend waiting between retries (default 10 s). A
   * Retry-After that does not fit in the remaining budget is not waited for;
   * the response is returned to the caller instead.
   */
  retryBudgetMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type QueryValue = string | number | boolean | null | undefined;

/** One page of a list and the totals from the X-WP-Total and X-WP-TotalPages headers (absent when not sent). */
export interface Page<T> {
  body: T;
  total?: number;
  totalPages?: number;
}

type HttpMethod = 'GET' | 'POST' | 'PUT';

/**
 * The header that carries the credentials: HTTP Basic auth with the consumer
 * key as user name and the consumer secret as password, as the WooCommerce
 * REST API documentation describes for HTTPS ("Authentication over HTTPS").
 * Error text redaction follows it.
 */
export const API_KEY_HEADER = 'Authorization';

/** The REST API's path below the shop's address (WooCommerce 3.5 or later, pretty permalinks on). */
export const API_PATH = '/wp-json/wc/v3';

/**
 * The only writes the client sends: method and path (relative to the API
 * path). Anything else, a DELETE among them, is refused before it is sent,
 * whatever a tool or a policy says. The client has no delete method at all.
 */
export const ALLOWED_WRITES: ReadonlyArray<{ method: 'POST' | 'PUT'; path: RegExp }> = [
  { method: 'PUT', path: /^\/orders\/\d+$/ },
  { method: 'POST', path: /^\/orders\/\d+\/notes$/ },
  { method: 'POST', path: /^\/orders\/\d+\/refunds$/ },
  { method: 'POST', path: /^\/products$/ },
  { method: 'PUT', path: /^\/products\/\d+$/ },
  { method: 'PUT', path: /^\/customers\/\d+$/ },
];

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES_LIMIT = 100 * 1024 * 1024;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** Largest delay accepted by Node timers. */
const MAX_TIMER_MS = 2_147_483_647;
/** Error codes (on `error.cause`) of connection-level failures worth retrying. */
/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * The client as handed to tool handlers. Read-only tools get a view whose
 * non-GET methods throw (see readOnlyClient), so the write gate does not
 * depend on tool annotations alone.
 */
export interface UpstreamClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  getPage<T>(path: string, query?: Record<string, QueryValue>): Promise<Page<T>>;
  post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  /**
   * The shop, for serialising writes to one order in this process: the same
   * for every key of the shop, and holding no credential.
   */
  shopIdentity(): string;
}

/**
 * A view of the client that only allows GET. A read-only tool that needs a
 * POST (e.g. a search endpoint that takes a body) should get an explicit,
 * named method here rather than the full client.
 */
export function readOnlyClient(client: UpstreamClient, toolName: string): UpstreamClient {
  const refuse = (method: string) => async () => {
    throw new Error(`Read-only tool ${toolName} attempted an upstream ${method}; refused.`);
  };
  return {
    get: (path, query) => client.get(path, query),
    getPage: (path, query) => client.getPage(path, query),
    post: refuse('POST'),
    put: refuse('PUT'),
    shopIdentity: () => client.shopIdentity(),
  };
}

/**
 * Client for the upstream API. Authenticates with the consumer key and secret (HTTP Basic over HTTPS).
 *
 * Redirects are never followed, so the key cannot be forwarded to another
 * origin. Idempotent GETs are retried with backoff on throttling, gateway
 * errors and transient network failures; other methods are never retried.
 * Missing credentials or shop address only fail when a request is made, so the
 * tool list can be read without credentials.
 *
 * Each client owns a SecretRedactor holding its own key and key header;
 * errors raised by the client, and the audit and tool results of calls
 * made through it, are redacted with it.
 */
export class WooCommerceClient implements UpstreamClient {
  readonly redactor: SecretRedactor;
  private readonly authorization?: string;
  private readonly missing?: string;
  /** The REST API base: the shop's address and API_PATH. */
  readonly baseUrl?: string;
  private readonly allowPrivateHost: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryBudgetMs: number;
  private readonly semaphore: Semaphore;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: WooCommerceClientOptions = {}) {
    const credentialEnv = options.credentialEnv ?? process.env;
    const consumerKey = options.consumerKey ?? readEnvString('WOOCOMMERCE_CONSUMER_KEY', credentialEnv);
    const consumerSecret = options.consumerSecret ?? readEnvString('WOOCOMMERCE_CONSUMER_SECRET', credentialEnv);
    this.redactor = new SecretRedactor().addHeader(API_KEY_HEADER).addSecret(consumerKey).addSecret(consumerSecret);
    if (consumerKey && consumerSecret) {
      const basic = Buffer.from(`${consumerKey}:${consumerSecret}`, 'utf8').toString('base64');
      this.redactor.addSecret(basic);
      this.authorization = `Basic ${basic}`;
    } else {
      this.missing = consumerKey ? 'WOOCOMMERCE_CONSUMER_SECRET' : 'WOOCOMMERCE_CONSUMER_KEY';
    }
    this.allowPrivateHost = options.allowPrivateHost ?? readEnvBoolean('WOOCOMMERCE_ALLOW_PRIVATE_HOST', false);
    const shopUrl = options.shopUrl ?? readEnvString('WOOCOMMERCE_SHOP_URL', credentialEnv);
    if (shopUrl !== undefined) {
      const shop = assertSafeShopUrl(trimTrailingSlash(shopUrl), this.allowPrivateHost);
      this.baseUrl = `${trimTrailingSlash(`${shop.origin}${shop.pathname}`)}${API_PATH}`;
    }
    // The built-in fetch connects only to public addresses of the shop, checked for every new connection. With
    // allowPrivateHost (local development) it is the plain fetch.
    this.fetchImpl = options.fetchImpl ?? (this.allowPrivateHost ? fetch : pinnedFetch(options.resolveHost ?? systemResolve));
    this.timeoutMs = intOption('timeoutMs', options.timeoutMs, 'WOOCOMMERCE_TIMEOUT_MS', 30_000, 1, MAX_TIMER_MS);
    this.maxResponseBytes = intOption(
      'maxResponseBytes',
      options.maxResponseBytes,
      'WOOCOMMERCE_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES_LIMIT,
    );
    this.semaphore = new Semaphore(
      intOption('maxConcurrency', options.maxConcurrency, 'WOOCOMMERCE_MAX_CONCURRENCY', 4, 1, 64),
    );
    this.maxAttempts = intOption('maxAttempts', options.maxAttempts, undefined, 3, 1, 10);
    this.retryBaseDelayMs = intOption('retryBaseDelayMs', options.retryBaseDelayMs, undefined, 500, 0, 60_000);
    this.retryBudgetMs = intOption('retryBudgetMs', options.retryBudgetMs, undefined, 10_000, 0, 600_000);
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return (await this.request<T>('GET', this.buildUrl(path, query))).body;
  }

  /** A GET of one page of a list, with the totals WooCommerce sends in X-WP-Total and X-WP-TotalPages. */
  async getPage<T>(path: string, query?: Record<string, QueryValue>): Promise<Page<T>> {
    return this.request<T>('GET', this.buildUrl(path, query));
  }

  async post<T>(path: string, body?: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return (await this.request<T>('POST', this.buildUrl(path, query), body)).body;
  }

  /**
   * The shop, independent of the key: its API address with the host in lower
   * case and a leading "www." left out, hashed. Two connections with
   * different keys to the same shop share it. See recordRefund.
   */
  shopIdentity(): string {
    if (!this.baseUrl) return 'unconfigured';
    const url = new URL(this.baseUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return createHash('sha256').update(`${host}${url.port ? `:${url.port}` : ''}${url.pathname.replace(/\/+$/, '')}`).digest('hex').slice(0, 32);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return (await this.request<T>('PUT', this.buildUrl(path), body)).body;
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    if (!this.baseUrl) {
      throw new Error('Missing WOOCOMMERCE_SHOP_URL. Set it in the MCP server environment.');
    }
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  private headers(): Record<string, string> {
    if (!this.authorization) {
      throw new Error(`Missing ${this.missing ?? 'WOOCOMMERCE_CONSUMER_KEY'}. Set it in the MCP server environment.`);
    }
    return {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      [API_KEY_HEADER]: this.authorization,
    };
  }

  private async request<T>(method: HttpMethod, url: string, body?: unknown): Promise<Page<T>> {
    if (method !== 'GET') {
      // The fixed list of writes: anything else is refused before the credentials are put in a header.
      const path = new URL(url).pathname.slice(new URL(`${this.baseUrl}/`).pathname.length - 1);
      if (!ALLOWED_WRITES.some(entry => entry.method === method && entry.path.test(path))) {
        throw new Error(`Refused: ${method} to that path is not among the writes this server sends.`);
      }
    }
    const headers = this.headers();
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    return this.execute(method, url, init, async response => {
      if (isRedirect(response.status)) {
        await discardBody(response);
        throw new Error(this.redactor.redact(redirectRefusedMessage(response, method, url)));
      }

      if (!response.ok) {
        // The body is the shop's text: it is never read into an error, a result or an audit record.
        await discardBody(response);
        throw new WooCommerceHttpError({
          status: response.status,
          url: describeUrl(url),
          retryAfter: response.headers.get('retry-after') ?? undefined,
          requestId: requestIdFrom(response.headers),
        });
      }

      const total = countHeader(response.headers.get('x-wp-total'));
      const totalPages = countHeader(response.headers.get('x-wp-totalpages'));
      const data = (await readResponseBody(response, this.maxResponseBytes)) as T;
      return { body: data, total, totalPages };
    });
  }

  /**
   * Run one logical request: limit concurrency, apply the timeout, and retry
   * idempotent GETs on retryable statuses and transient network errors
   * within the retry budget. `handle` runs while the concurrency slot is
   * held, so body reads count against it.
   */
  private async execute<R>(
    method: HttpMethod,
    url: string,
    init: RequestInit,
    handle: (response: Response) => Promise<R>,
  ): Promise<R> {
    const maxAttempts = method === 'GET' ? this.maxAttempts : 1;
    let slept = 0;

    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt < maxAttempts;
      let delayMs: number | undefined;
      const release = await this.semaphore.acquire();
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        let response: Response | undefined;
        try {
          response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal });
        } catch (error) {
          delayMs = canRetry && isTransientNetworkError(error) ? this.retryDelay(attempt, undefined, slept) : undefined;
          if (delayMs === undefined) {
            throw this.transportError(method, url, error);
          }
        }

        if (response) {
          if (canRetry && RETRYABLE_STATUS.has(response.status)) {
            delayMs = this.retryDelay(attempt, parseRetryAfterMs(response.headers.get('retry-after')), slept);
          }
          if (delayMs === undefined) {
            try {
              return await handle(response);
            } catch (error) {
              // Failures while reading the body surface as raw fetch errors.
              if (isTimeoutError(error)) {
                throw this.transportError(method, url, error);
              }
              if (!isTransientNetworkError(error)) {
                throw error;
              }
              delayMs = canRetry ? this.retryDelay(attempt, undefined, slept) : undefined;
              if (delayMs === undefined) {
                throw this.transportError(method, url, error);
              }
            }
          }
          await discardBody(response);
        }
      } finally {
        release();
      }
      // Wait outside the concurrency slot.
      const wait = delayMs ?? 0;
      slept += wait;
      await this.sleep(wait);
    }
  }

  /**
   * Delay before the next attempt: exponential backoff with jitter, or the
   * server's Retry-After if longer. Undefined when the wait would exceed the
   * remaining retry budget (the caller then gives up).
   */
  private retryDelay(attempt: number, retryAfterMs: number | undefined, slept: number): number | undefined {
    const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * this.retryBaseDelayMs;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    return slept + delay > this.retryBudgetMs ? undefined : delay;
  }

  // Our own words with the method only: the address is configuration and is not quoted.
  private transportError(method: HttpMethod, _url: string, error: unknown): Error {
    if (isTimeoutError(error)) {
      return new Error(this.redactor.redact(`WooCommerce API request timed out after ${this.timeoutMs} ms (${method}).`));
    }
    // The connection's own check (network.ts) refused a private address: our own text.
    if (causeCodes(error).includes('ERR_SHOP_PRIVATE_ADDRESS')) {
      return new Error('Refused: the shop address points to a private or local network address.');
    }
    // Only a system error code (ECONNREFUSED, ENOTFOUND, ...) from the cause, never its message.
    const code = (error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined) ?? undefined;
    const shown = typeof code === 'string' && SHOWN_NETWORK_CODES.has(code) ? ` (${code})` : '';
    return new Error(this.redactor.redact(`Network error calling the WooCommerce API (${method})${shown}.`), { cause: error });
  }
}

/** Option value if given (validated), else the environment variable (if any), else the default. */
function intOption(
  optionName: string,
  value: number | undefined,
  envName: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value !== undefined) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      // The value is not quoted: an option may hold a secret put there by mistake.
      throw new ConfigError(`${optionName} must be an integer between ${min} and ${max}.`);
    }
    return value;
  }
  return envName ? readEnvInteger(envName, fallback, { min, max }) : fallback;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // hand the slot over directly
      } else {
        this.active -= 1;
      }
    };
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** The redirect's Location is the vendor's text and is never quoted; only the status and our own request. */
function redirectRefusedMessage(response: Response, method: HttpMethod, _url: string): string {
  return (
    `WooCommerce API responded with a redirect (HTTP ${response.status}) for ${method}; ` +
    'redirects are not followed. Check the shop address (WOOCOMMERCE_SHOP_URL): it must be the address the shop answers on.'
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** fetch reports connection failures as TypeError with a coded cause; only those are retried. */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  return causeCodes(error.cause).some(code => TRANSIENT_NETWORK_CODES.has(code));
}

function causeCodes(cause: unknown, depth = 0): string[] {
  if (typeof cause !== 'object' || cause === null || depth > 3) {
    return [];
  }
  const codes: string[] = [];
  const { code, errors, cause: inner } = cause as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === 'string') {
    codes.push(code);
  }
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      codes.push(...causeCodes(entry, depth + 1));
    }
  }
  codes.push(...causeCodes(inner, depth + 1));
  return codes;
}

/** Read at most `limit` bytes of the body; cancels the rest and reports whether it was longer. */
async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/** Successful bodies are read up to maxBytes; a larger response is an error, not a truncated result. */
async function readResponseBody(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw new Error(`WooCommerce API response of ${declared} bytes exceeds the ${maxBytes} byte limit (WOOCOMMERCE_MAX_RESPONSE_BYTES).`);
  }
  let read: { bytes: Uint8Array; exceeded: boolean };
  try {
    read = await readUpTo(response, maxBytes);
  } catch (error) {
    // A timeout or a dropped connection goes on to execute(), which reports it as a transport error. Anything else
    // thrown while reading the body is replaced by a fixed text: its message is not ours.
    if (isTimeoutError(error) || isTransientNetworkError(error)) {
      throw error;
    }
    throw new Error('The WooCommerce API response could not be read.');
  }
  const { bytes, exceeded } = read;
  if (exceeded) {
    throw new Error(`WooCommerce API response exceeds the ${maxBytes} byte limit (WOOCOMMERCE_MAX_RESPONSE_BYTES).`);
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Host names that are never a public shop. */
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

/**
 * Checks the shop's address before anything is built from it: https, no
 * credentials, query or fragment, and a public host name (not an IP address,
 * not localhost, not a single label, not a local suffix). A shop on a
 * loopback or private address is accepted only with allowPrivateHost, for
 * local development. The address is never quoted: it is configuration.
 */
function assertSafeShopUrl(shopUrl: string, allowPrivateHost: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(shopUrl);
  } catch {
    throw new ConfigError('WOOCOMMERCE_SHOP_URL is not a valid URL.');
  }
  if (parsed.username || parsed.password || shopUrl.includes('?') || shopUrl.includes('#')) {
    throw new ConfigError('WOOCOMMERCE_SHOP_URL must not contain credentials, a query string or a fragment.');
  }
  if (allowPrivateHost) {
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocalHost(parsed.hostname))) return parsed;
    throw new ConfigError('WOOCOMMERCE_SHOP_URL must use https:// (loopback http:// only for local development).');
  }
  if (parsed.protocol !== 'https:') {
    // The scheme is not quoted: it is part of a configuration value.
    throw new ConfigError('Refusing to send the API key over a scheme other than https://. The shop address must use https://.');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    isLocalHost(host) ||
    isIpLiteral(host) ||
    !host.includes('.') ||
    LOCAL_SUFFIXES.some(suffix => host.endsWith(suffix))
  ) {
    throw new ConfigError('Refusing that shop address: it must be a public host name, not an IP address or a local name.');
  }
  return parsed;
}

function isIpLiteral(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return host.startsWith('[') || ipaddr.isValid(bare) || /^[0-9.]+$/.test(bare) || /^0x/i.test(bare);
}

/** A count from a header: a whole number of at most 9 digits, else undefined. Nothing else of a header is kept. */
function countHeader(value: string | null): number | undefined {
  return value !== null && /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : undefined;
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
