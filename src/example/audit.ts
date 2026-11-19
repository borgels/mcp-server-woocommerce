import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ExampleHttpError, formatUnknownError, redactDeep, redactSecrets, type SecretRedactor } from '../errors.js';
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
  if (error instanceof ExampleHttpError) {
    return {
      httpStatus: error.status,
      message: `Example API request failed with HTTP ${error.status}`,
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
 * Startup check: when EXAMPLE_AUDIT_LOG is set, its directory must exist and
 * be writable (and the file, if it exists, writable), so a typo fails at
 * startup rather than refusing every write tool call later.
 */
export function assertAuditLogWritable(): void {
  const auditPath = readEnvString('EXAMPLE_AUDIT_LOG');
  if (!auditPath) {
    return;
  }
  try {
    const existing = statSync(auditPath, { throwIfNoEntry: false });
    accessSync(existing ? auditPath : dirname(auditPath), constants.W_OK);
  } catch {
    throw new ConfigError('EXAMPLE_AUDIT_LOG is not writable.');
  }
}

/**
 * Append one JSON line to EXAMPLE_AUDIT_LOG (no-op when unset). Under a
 * host's InstancePolicy the record goes to the policy's `audit` sink instead
 * (no-op without one), and EXAMPLE_AUDIT_LOG is not read.
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
  const auditPath = hosted ? undefined : readEnvString('EXAMPLE_AUDIT_LOG');
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
      stderrLine(redactSecrets(`[example-mcp] audit log write failed, refusing ${tool}: ${formatUnknownError(error, redactor)}`, redactor));
      throw new Error(`Audit log is not writable on this instance; ${tool} was not run.`);
    }
    stderrLine(redactSecrets(`[example-mcp] audit log write failed: ${formatUnknownError(error, redactor)}`, redactor));
  }
}

function errorFields(summary: ReturnType<typeof auditErrorSummary>) {
  return { httpStatus: summary.httpStatus, error: summary.message };
}

/** Identifier fields logged in clear text: they are opaque ids, not secrets. Extend per tool. */
const ID_FIELDS = ['itemId'] as const;

/** Free-text fields are hashed so user-written text does not land in the log. */
const FREE_TEXT_FIELDS = ['name', 'query'] as const;

/** Write payload objects: only their field names are logged. */
const PAYLOAD_FIELDS = ['body', 'patch'] as const;

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

  for (const field of PAYLOAD_FIELDS) {
    const payload = value[field];
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      target[`${field}Fields`] = Object.keys(payload).sort();
    }
  }

  return target;
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
