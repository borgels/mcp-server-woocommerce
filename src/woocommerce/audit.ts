import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WooCommerceHttpError, formatUnknownError, redactDeep, redactSecrets, type SecretRedactor } from '../errors.js';
import { STDERR_WITHHELD, withheldAuditRecord } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import { ConfigError, readEnvString } from '../config-env.js';
import { currentInstancePolicy, currentRedactor } from './policy.js';

export interface AuditEvent {
  /** Shared by all events of one tool call (start/finish/error). */
  requestId: string;
  tool: string;
  /** Caller identity supplied by an embedding host, when available. */
  caller?: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied' | 'rejected';
  target?: Record<string, unknown>;
  status?: string;
  reason?: string;
  error?: unknown;
  durationMs?: number;
}

const MAX_AUDIT_MESSAGE_LENGTH = 200;

/**
 * Error summary for the audit log: the HTTP status, or this server's own
 * message, redacted before it is shortened. Nothing the upstream controls
 * (body, error code, message) is logged: it can quote input or part of the key.
 */
export function auditErrorSummary(
  error: unknown,
  redactor?: SecretRedactor,
): { httpStatus?: number; message: string } {
  if (error instanceof WooCommerceHttpError) {
    return {
      httpStatus: error.status,
      message: `WooCommerce API request failed with HTTP ${error.status}`,
    };
  }
  const message = formatUnknownError(error, redactor);
  return {
    message: message.length > MAX_AUDIT_MESSAGE_LENGTH ? `${message.slice(0, MAX_AUDIT_MESSAGE_LENGTH)}…` : message,
  };
}

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Startup check: when WOOCOMMERCE_AUDIT_LOG is set, its directory must exist and
 * be writable (and the file, if it exists, writable), so a typo fails at
 * startup rather than refusing every write tool call later.
 */
export function assertAuditLogWritable(): void {
  const auditPath = readEnvString('WOOCOMMERCE_AUDIT_LOG');
  if (!auditPath) {
    return;
  }
  try {
    const existing = statSync(auditPath, { throwIfNoEntry: false });
    accessSync(existing ? auditPath : dirname(auditPath), constants.W_OK);
  } catch {
    throw new ConfigError('WOOCOMMERCE_AUDIT_LOG is not writable.');
  }
}

/**
 * Append one JSON line to WOOCOMMERCE_AUDIT_LOG (no-op when unset). Under a
 * host's InstancePolicy the record goes to the policy's `audit` sink instead
 * (no-op without one), and WOOCOMMERCE_AUDIT_LOG is not read.
 *
 * By default a failing audit sink is reported on stderr and does not change
 * the tool result: after a call has run, surfacing an error would invite a
 * retry and a duplicate write. With `required: true` (used for the event
 * written before a write tool runs) the failure is thrown instead, so no
 * write happens without an audit record. `redactor` is the redactor of the
 * instance that ran the call.
 */
export async function writeAuditEvent(
  event: AuditEvent,
  options: { required?: boolean; redactor?: SecretRedactor } = {},
): Promise<void> {
  const hosted = currentInstancePolicy();
  const sink = hosted?.audit;
  const auditPath = hosted ? undefined : readEnvString('WOOCOMMERCE_AUDIT_LOG');
  if (!sink && !auditPath) {
    return;
  }
  // One redactor for the record and for every failure message: the caller's, else the call scope's.
  const redactor = options.redactor ?? currentRedactor();
  // The sink check (src/key-admission.ts), on each record and line in its final form.
  const leaks = (value: unknown) => redactor !== undefined && leaksSecret(value, redactor);
  const stderrLine = (line: string) => process.stderr.write(`${leaks(line) ? STDERR_WITHHELD : line}\n`);

  try {
    const record = {
      timestamp: new Date().toISOString(),
      requestId: event.requestId,
      tool: event.tool,
      caller: event.caller,
      action: event.action,
      target: event.target,
      status: event.status,
      durationMs: event.durationMs,
      reason: event.reason,
      ...(event.error === undefined ? {} : errorFields(auditErrorSummary(event.error, redactor))),
    };

    // Every value in the record, keys and numbers included, with the instance's secrets redacted (the shared
    // redactDeep): a key can reach the record through a tool name, an input field, the caller or a reason.
    const safe = redactDeep(record, redactor) as Record<string, unknown>;
    if (sink) {
      // A copy through JSON: the sink gets plain data, not an object the server keeps.
      const copy = JSON.parse(JSON.stringify(safe)) as Record<string, unknown>;
      await sink(leaks(copy) ? withheldAuditRecord() : copy);
    } else if (auditPath) {
      const line = JSON.stringify(safe);
      await appendFile(auditPath, `${leaks(line) ? JSON.stringify(withheldAuditRecord()) : line}\n`, 'utf8');
    }
  } catch (error) {
    if (options.required) {
      // Details (path, OS error) go to stderr only, not to the caller.
      const tool = formatUnknownError(event.tool, redactor);
      // The whole line, prefix included, through the redactor and then the sink check.
      stderrLine(redactSecrets(`[woocommerce-mcp] audit log write failed, refusing ${tool}: ${formatUnknownError(error, redactor)}`, redactor));
      throw new Error(`Audit log is not writable on this instance; ${tool} was not run.`);
    }
    stderrLine(redactSecrets(`[woocommerce-mcp] audit log write failed: ${formatUnknownError(error, redactor)}`, redactor));
  }
}

function errorFields(summary: ReturnType<typeof auditErrorSummary>) {
  return { httpStatus: summary.httpStatus, error: summary.message };
}

/**
 * Fields logged in clear text: WooCommerce ids (integers), dates, amounts,
 * currency codes and values from the tools' fixed lists. Input is validated
 * against the tool's schema before it is audited.
 */
const ID_FIELDS = [
  'orderId',
  'productId',
  'customerId',
  'customer',
  'product',
  'category',
  'status',
  'stock_status',
  'type',
  'period',
  'dateMin',
  'dateMax',
  'after',
  'before',
  'amount',
  'currency',
  'manage_stock',
  'page',
  'perPage',
] as const;

/**
 * Search text, SKUs and product names are hashed so text a person wrote does
 * not land in the log. Names, e-mail addresses, addresses, phone numbers,
 * notes and refund reasons are not logged at all, not even hashed.
 */
const FREE_TEXT_FIELDS = ['search', 'sku', 'name'] as const;

/** Nothing is logged as a list in this server. */
const LIST_FIELDS = [] as const;

/** Build the audit `target` for a tool input. Values not listed above are not logged. */
export function auditTarget(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const value = input as Record<string, unknown>;
  const target: Record<string, unknown> = {};

  for (const field of ID_FIELDS) {
    if (value[field] !== undefined) {
      target[field] = value[field];
    }
  }

  for (const field of FREE_TEXT_FIELDS) {
    if (typeof value[field] === 'string' && value[field] !== '') {
      target[`${field}Sha256`] = hashValue(value[field] as string);
    }
  }

  for (const field of LIST_FIELDS) {
    if (Array.isArray(value[field])) {
      target[`${field}Count`] = (value[field] as unknown[]).length;
    }
  }

  return target;
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
