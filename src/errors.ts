/**
 * Errors and redaction.
 *
 * The rule: no text the upstream API controls ever reaches a host, a result
 * or an audit record through an error. An HTTP error carries the status, our
 * own hint for it, and a parsed Retry-After; never the response body, the
 * vendor's error code or message, or a redirect's Location. Upstream text can
 * quote the request, personal data, or part of the key, and no redactor
 * recognises every fragment.
 *
 * Redaction is the second line: every instance redacts its key (the exact
 * value, its URL- and JSON-encoded forms, and any fragment of
 * FRAGMENT_LENGTH characters or more) from everything it returns, always on
 * structured values before they are serialised, and before anything is cut
 * short.
 */

/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
export const MIN_SECRET_LENGTH = 8;
/** Any piece of a secret this long or longer is redacted, wherever it appears. */
export const FRAGMENT_LENGTH = 6;
/** Values nested deeper than this are replaced by redactDeep, never passed on. */
export const MAX_REDACT_DEPTH = 64;
/**
 * What a redacted value is replaced by. Its brackets are not ASCII, so it cannot be a piece of a key typed or
 * issued as ASCII; a key that contains it or shares a FRAGMENT_LENGTH piece with it is refused (overlapsMarker).
 */
export const REDACTION_MARKER = '‹redacted›';

/** Whether a secret could survive its own redaction: it contains the marker, or shares a piece with it. */
export function overlapsMarker(value: string): boolean {
  if (value.includes(REDACTION_MARKER)) {
    return true;
  }
  for (let i = 0; i + FRAGMENT_LENGTH <= REDACTION_MARKER.length; i += 1) {
    if (value.includes(REDACTION_MARKER.slice(i, i + FRAGMENT_LENGTH))) {
      return true;
    }
  }
  return false;
}

/** Matches `<name>: <value>`, `<name>=<value>` and `"<name>": "<value>"` for one header (case-insensitive). */
function headerPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`["']?${escaped}["']?\s*[:=]\s*["']?[^"',\s}]+`, 'gi');
}

/** Patterns that are always applied: credential-shaped key/value pairs. They hold no secret values. */
const BASE_PATTERNS: readonly RegExp[] = [
  headerPattern('x-api-key'),
  // Any scheme word (Bearer, Basic, Token, ...) followed by the credentials.
  /["']?authorization["']?\s*[:=]\s*["']?(?:[a-z][\w-]*\s+)?[^"',\s}]+/gi,
  /(apiKey|EXAMPLE_API_KEY|api_key|access_token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

/**
 * Redacts the secrets of one client, and so of one gateway or server
 * instance: the exact values (raw, URL-encoded and JSON-escaped), every
 * fragment of FRAGMENT_LENGTH characters or more of them, and the values of
 * named credential headers. Each instance owns its redactor, so a host that
 * runs several tenants in one process never mixes their keys, and a tenant's
 * key is released with its instance. There is no process-wide registry.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();
  private readonly fragments = new Set<string>();
  private readonly patterns: RegExp[] = [...BASE_PATTERNS];

  /** Redact this value and every piece of it. Values shorter than MIN_SECRET_LENGTH are ignored. */
  addSecret(value: string | undefined): this {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return this;
    }
    for (const form of new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])) {
      this.secrets.add(form);
      for (let i = 0; i + FRAGMENT_LENGTH <= form.length; i += 1) {
        this.fragments.add(form.slice(i, i + FRAGMENT_LENGTH));
      }
    }
    return this;
  }

  /** Redact the value of this header wherever it appears as `<name>: <value>` or `<name>=<value>`. */
  addHeader(name: string): this {
    const pattern = headerPattern(name);
    if (!this.patterns.some(existing => existing.source === pattern.source)) {
      this.patterns.push(pattern);
    }
    return this;
  }

  /** Whether this exact value is one of this instance's secrets. */
  hasSecret(value: string): boolean {
    return this.secrets.has(value);
  }

  /** Whether the text contains one of the secrets in any form, or any FRAGMENT_LENGTH-character piece of one. */
  matches(text: string): boolean {
    for (const secret of this.secrets) {
      if (text.includes(secret)) return true;
    }
    if (this.fragments.size === 0) return false;
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.fragments.has(text.slice(i, i + FRAGMENT_LENGTH))) return true;
    }
    return false;
  }

  redact(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      result = result.split(secret).join('‹redacted›');
    }
    return applyPatterns(this.redactFragments(result), this.patterns);
  }

  /** Every run of text covered by a FRAGMENT_LENGTH-character piece of a secret becomes one ‹redacted›. */
  private redactFragments(text: string): string {
    if (this.fragments.size === 0 || text.length < FRAGMENT_LENGTH) {
      return text;
    }
    let covered: Uint8Array | undefined;
    for (let i = 0; i + FRAGMENT_LENGTH <= text.length; i += 1) {
      if (this.fragments.has(text.slice(i, i + FRAGMENT_LENGTH))) {
        covered ??= new Uint8Array(text.length);
        covered.fill(1, i, i + FRAGMENT_LENGTH);
      }
    }
    if (!covered) {
      return text;
    }
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (covered[i]) {
        out += '‹redacted›';
        while (i < text.length && covered[i]) i += 1;
      } else {
        out += text[i];
        i += 1;
      }
    }
    return out;
  }
}

function applyPatterns(value: string, patterns: readonly RegExp[]): string {
  return patterns.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        // Split at the first separator only: the value may itself contain `:` or `=`.
        const [, key = 'secret', separator = ':'] = /^(.*?)\s*([:=])/.exec(match) ?? [];
        return `${key.trim()}${separator} ‹redacted›`;
      }),
    value,
  );
}

/** Our own guidance per HTTP status. Replace or extend with the vendor's documented statuses. */
const STATUS_HINTS: Record<number, string> = {
  401: 'The API key was rejected (invalid or expired). The server operator must renew EXAMPLE_API_KEY.',
  403: 'The API key has no access to this resource. Retrying will not help.',
  404: 'The object was not found, or the API key has no access to it. Check the ids.',
  429: 'The upstream API is throttling requests. Wait and retry later.',
};

/**
 * An HTTP error from the upstream API. It keeps the status and the parsed
 * Retry-After, nothing from the response body: the message is our own.
 */
export class ExampleHttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** Seconds to wait, parsed from Retry-After; undefined when absent or malformed. */
  readonly retryAfter?: string;

  constructor(input: { status: number; url: string; retryAfter?: string }) {
    super(httpErrorMessage(input.status, input.retryAfter));
    this.name = 'ExampleHttpError';
    this.status = input.status;
    this.url = describeUrl(input.url);
    const retryMs = parseRetryAfterMs(input.retryAfter);
    this.retryAfter = retryMs === undefined ? undefined : String(Math.ceil(retryMs / 1000));
  }
}

/** The whole text of an HTTP error: status, our hint, and a parsed Retry-After in seconds. */
export function httpErrorMessage(status: number, retryAfter?: string): string {
  const retryMs = parseRetryAfterMs(retryAfter);
  return [
    `Example API request failed with HTTP ${status}`,
    Object.hasOwn(STATUS_HINTS, status) ? STATUS_HINTS[status] : undefined,
    retryMs === undefined ? undefined : `retry-after=${Math.ceil(retryMs / 1000)}s`,
  ]
    .filter(Boolean)
    .join(' | ');
}

export function formatUnknownError(error: unknown, redactor?: SecretRedactor): string {
  if (error instanceof Error) {
    return redactSecrets(error.message, redactor);
  }
  return redactSecrets(String(error), redactor);
}

/**
 * Redact with an instance's redactor. Without one, only the credential-shaped
 * patterns are applied: no secret values are known outside an instance.
 */
export function redactSecrets(value: string, redactor?: SecretRedactor): string {
  return redactor ? redactor.redact(value) : applyPatterns(value, BASE_PATTERNS);
}

/** Origin and path of a URL, without query string or fragment (which may carry signatures). */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/**
 * Copy of a JSON-like value with every string, object keys included, passed
 * through redactSecrets, and every number, boolean or bigint whose string form
 * would be redacted replaced by the string "‹redacted›" (so the copy still
 * serialises to valid JSON). Redact a value with this before it is serialised:
 * a serialised secret is escaped, and the escaped form is easy to miss.
 * Anything nested deeper than MAX_REDACT_DEPTH is replaced, never passed on,
 * so a deep value cannot exhaust the stack when the copy is serialised.
 */
export function redactDeep(value: unknown, redactor?: SecretRedactor, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    return '[nested too deep]';
  }
  if (typeof value === 'string') {
    return redactSecrets(value, redactor);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    const text = String(value);
    if (redactSecrets(text, redactor) !== text) return '‹redacted›';
    return typeof value === 'bigint' ? text : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const json = (value as { toJSON?: unknown }).toJSON;
  if (typeof json === 'function') {
    // A Date and the like: redact what JSON.stringify would write.
    return redactDeep(json.call(value), redactor, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map(entry => redactDeep(entry, redactor, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      redactSecrets(key, redactor),
      redactDeep(entry, redactor, depth + 1),
    ]),
  );
}

/**
 * Text for a failure kept inside a result that is otherwise returned (one
 * part of a combined read that could not be fetched): the HTTP status, or a
 * fixed text. Never the error's own message.
 */
export function nestedFailureText(error: unknown): string {
  if (error instanceof ExampleHttpError) {
    return `Example API request failed with HTTP ${error.status}`;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'Example API request timed out.';
  }
  return 'Example API request failed.';
}

/** Keys whose value is a failure context: anything inside that carries an error or a message is a failure. */
const FAILURE_CONTEXTS = new Set(['failures', 'failure', 'errors', 'error', 'metadata', 'warnings', 'amount']);
/** Fields that make an object in a failure context a failure. */
const FAILURE_FIELDS = ['error', 'errors', 'failures', 'warnings', 'message', 'detail', 'description'];
/** Failure lists: every element in one is a failure, whatever its fields. */
const FAILURE_LISTS = new Set(['failures', 'failure', 'errors', 'error', 'warnings']);

/** One element of a failure list, reduced to a numeric status (when it has one) and our own text. */
function failureEntry(value: unknown): { status?: number; message: string } {
  const status =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? { status, message: `Example API request failed with HTTP ${status}` }
    : { message: 'Example API request failed.' };
}

/** A failure list: every element (an object with any fields, a text, a list) becomes a failureEntry. */
function failureList(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  return Array.isArray(value) ? value.map(failureEntry) : failureEntry(value);
}

/**
 * Copy of a successful body with every failure reported inside it reduced to
 * its HTTP status and our own text.
 *
 * - Every element of a failure list (`failures`, `failure`, `errors`,
 *   `error`, `warnings`), at any depth, becomes `{ status?, message }`: a
 *   numeric status is kept, and every other field, whatever its name, is
 *   dropped. Nothing below a failure list is kept.
 * - Elsewhere a failure is an object with a numeric `status` of 400 or
 *   more, an object with an `error` field, or an object in a failure
 *   context (`metadata`, `amount` and the like, also through wrappers such
 *   as `data` below them) with any of `error`, `errors`, `failures`,
 *   `warnings`, `message`, `detail` or `description`. It becomes
 *   `{ status?, error }` with our own text.
 *
 * A text outside a failure list, an amount among them, is kept.
 * Depth-limited.
 */
export function nestedFailuresAsStatus(value: unknown, depth = 0, context = false): unknown {
  if (depth > 64) {
    return '[nested too deep]';
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => nestedFailuresAsStatus(entry, depth + 1, context));
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  const failedStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599;
  const present = (field: string) => Object.hasOwn(record, field) && record[field] !== null && record[field] !== undefined;
  if (failedStatus || present('error') || (context && FAILURE_FIELDS.some(present))) {
    return failedStatus
      ? { status, error: `Example API request failed with HTTP ${status}` }
      : { error: 'Example API request failed.' };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      FAILURE_LISTS.has(key)
        ? failureList(entry)
        : // A failure context holds through wrappers such as `data` below it.
          nestedFailuresAsStatus(entry, depth + 1, context || FAILURE_CONTEXTS.has(key)),
    ]),
  );
}

/** IMF-fixdate, the HTTP date format used by Retry-After. */
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a Retry-After header (delay in seconds or an HTTP date) into
 * milliseconds from `now`. Returns undefined when absent, malformed, zero or
 * in the past, so callers fall back to their own backoff.
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
  }
  if (!HTTP_DATE.test(trimmed)) {
    return undefined;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date) || date <= now) {
    return undefined;
  }
  return date - now;
}
