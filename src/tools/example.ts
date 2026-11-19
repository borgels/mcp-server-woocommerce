import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import {
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WRITE_TOOL_ANNOTATIONS,
} from '../example/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../example/audit.js';
import { readOnlyClient, type UpstreamClient } from '../example/client.js';
import { formatUnknownError, type SecretRedactor } from '../errors.js';
import { createItem, getItem } from '../example/items.js';
import { checkInputPolicy, checkToolPolicy, isToolDisabled, redactInScope, runInCallScope, validatePolicyConfig } from '../example/policy.js';

const MAX_ID_LENGTH = 200;
const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the HTTP method
 * and the path template relative to the base URL (`{name}` marks a
 * caller-supplied segment). Published in the gateway tool catalog so a host
 * can see what each tool touches; keep it in step with the handler.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
}

/** A client that carries the redactor of its instance (ExampleClient does). */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`example_*`). The gateway exposes it without the prefix. */
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
  /**
   * True when the tool can read more than its name says: anything in the
   * system, chosen by the input (a generic get-by-path, a raw query).
   * Published as `broad` in the gateway catalog, so a host that grants tools
   * per role gives it only to roles that may read everything. Default false.
   */
  broad?: boolean;
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

export const EXAMPLE_TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'example_get_item',
    title: 'Get Item (Example)',
    description: 'Fetch one item by id, optionally with its history.',
    inputShape: {
      itemId: idSchema.describe('Item id.'),
      includeHistory: z.boolean().optional().describe('Also read the item history. A failed history read is reported in the result.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched item.',
    upstream: [
      { access: 'read', method: 'GET', path: '/items/{itemId}' },
      { access: 'read', method: 'GET', path: '/items/{itemId}/history' },
    ],
    handler: async (client, input) => getItem(client, input),
  }),
  defineTool({
    name: 'example_create_item',
    title: 'Create Item (Example)',
    description:
      'Create a new item. Requires write access on this instance; confirm with the user before creating.',
    inputShape: {
      name: z.string().trim().min(1).max(200).describe('Item name.'),
      description: z.string().trim().max(2000).optional().describe('Optional description.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created item.',
    upstream: [{ access: 'write', method: 'POST', path: '/items' }],
    handler: async (client, input) => createItem(client, input),
  }),
];

export function findTool(name: string): ToolDefinition | undefined {
  return EXAMPLE_TOOLS.find(tool => tool.name === name);
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(EXAMPLE_TOOLS.map(tool => tool.name));
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

/** Tools enabled on this instance (EXAMPLE_DISABLED_TOOLS removes them entirely). */
export function enabledTools(): ToolDefinition[] {
  return EXAMPLE_TOOLS.filter(tool => !isToolDisabled(tool.name));
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
        try {
          // In a scope with this server's redactor, like a gateway call: audit records and context are redacted.
          return mcpToolResult(tool, await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input)));
        } catch (error) {
          // Central redaction with this instance's secrets: no error text reaches the client unredacted.
          return {
            isError: true,
            content: [{ type: 'text' as const, text: formatUnknownError(error, client.redactor) }],
          };
        }
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

/** Normalise a host-supplied context; malformed values are ignored. */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  return {
    requestId: contextString(value.requestId, 200) ?? newRequestId(),
    caller: contextString(value.caller, 320),
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
  if (!inputPolicy.allowed) {
    await writeAuditEvent(
      { requestId, tool: tool.name, caller, action: 'policy_denied', target, reason: inputPolicy.reason },
      { redactor },
    );
    throw new Error(inputPolicy.reason);
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

const MAX_REJECTED_FIELDS = 20;
const MAX_REJECTED_FIELD_LENGTH = 64;

/** Audit a call rejected before execution (unknown tool or invalid input); field names only. */
export async function auditRejectedCall(
  toolName: string,
  input: unknown,
  reason: string,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const fields =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.keys(input)
          .sort()
          .slice(0, MAX_REJECTED_FIELDS)
          .map(key => redactInScope(key).slice(0, MAX_REJECTED_FIELD_LENGTH))
      : [];
  await writeAuditEvent({
    requestId,
    tool: redactInScope(toolName).slice(0, 100),
    caller,
    action: 'rejected',
    target: { fields },
    reason: redactInScope(reason).slice(0, 200),
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
