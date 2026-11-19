import { z } from 'zod/v4';
import { UNTRUSTED_CONTENT_NOTE } from './woocommerce/annotations.js';
import { WooCommerceClient, type WooCommerceClientOptions } from './woocommerce/client.js';
import {
  isToolDisabled,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type InstancePolicy,
} from './woocommerce/policy.js';
import { ConfigError } from './config-env.js';
import { formatUnknownError, redactDeep, SecretRedactor } from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import {
  auditRejectedCall,
  WOOCOMMERCE_TOOLS,
  executeTool,
  findTool,
  logFieldValue,
  validateCall,
  validateStartupConfig,
  type WooCommerceChangeAction,
  type WooCommerceChangeRecord,
  type WooCommerceChangeSpec,
  type CallContext,
  type ToolDefinition,
  type UpstreamOperation,
} from './tools/woocommerce.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Tool definitions, input validation,
 * instance policy and audit are shared with the MCP server in
 * src/tools/woocommerce.ts.
 *
 * One instance per shop. Several instances can run in one process: each
 * uses only the consumer key, secret and shop address passed to
 * createWooCommerceGateway (never WOOCOMMERCE_CONSUMER_KEY,
 * WOOCOMMERCE_CONSUMER_SECRET or WOOCOMMERCE_SHOP_URL from the environment),
 * and redacts with its own secrets only. A gateway never sends to a shop
 * address that is not https on a public host name, or whose name resolves to
 * a private address.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`: that instance then reads none of WOOCOMMERCE_ENABLE_WRITES,
 * WOOCOMMERCE_DISABLED_TOOLS, WOOCOMMERCE_AUDIT_LOG or WOOCOMMERCE_ALLOW_PRIVATE_HOST,
 * so two tenants in one process can have different settings. Without
 * `policy` the instance uses the environment, as the MCP server does. Limits
 * (timeouts, retries) are still read from the environment and apply to every
 * instance.
 *
 * What no policy can turn on: a request outside the client's fixed list of
 * writes (src/woocommerce/client.ts, ALLOWED_WRITES). There is no DELETE, no
 * refund through a payment gateway (a refund is recorded with api_refund
 * false), no batch endpoint, and no tool that changes settings, users,
 * coupons or payment methods.
 */

export type { AuditSink, InstancePolicy } from './woocommerce/policy.js';
export type {
  WooCommerceChangeAction,
  WooCommerceChangeRecord,
  WooCommerceChangeSpec,
  WooCommerceLogField,
  WooCommerceLogFieldType,
} from './tools/woocommerce.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One upstream request a tool may make (method and path template relative to the base URL). */
export type GatewayUpstreamOperation = Readonly<UpstreamOperation>;

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). A host that grants tools per role gives a
   * broad tool only to roles that may read everything. From the tool table
   * (`broad`), false unless a tool declares it.
   */
  readonly broad: boolean;
  /**
   * True for a tool a person should confirm outside the chat before it runs:
   * recording a refund (it records a refund in the shop; no money moves).
   */
  readonly requiresConfirmation: boolean;
  /**
   * Write tools only: what the change does, for a host that logs a change
   * before it is sent. `logFields` are the input fields that identify it,
   * each with the one type its value must have (record ids, amounts,
   * currency codes, dates, counts, flags and kinds in clear; numbers the
   * company chose only as pseudonyms; never names or free text).
   * `resolveWooCommerceChange` returns their values.
   */
  readonly change?: WooCommerceChangeSpec;
}

export interface WooCommerceGatewayOptions
  extends Omit<WooCommerceClientOptions, 'consumerKey' | 'consumerSecret' | 'shopUrl' | 'credentialEnv' | 'allowPrivateHost'> {
  /** REST API consumer key (ck_...) of this shop. Required; never read from the environment. */
  consumerKey: string;
  /** REST API consumer secret (cs_...) of this shop. Required; never read from the environment. */
  consumerSecret: string;
  /**
   * The shop's address, e.g. https://shop.example.dk. Required; never read
   * from the environment. Must be https and a public host name; a name that
   * resolves to a private address is refused before each request.
   */
  shopUrl: string;
  /**
   * Instance policy from the host: enableWrites, disabledTools, allowedTools
   * and audit. When given, the instance reads no policy or audit variables
   * from the environment. A host serving several shops should always pass it.
   */
  policy?: InstancePolicy;
}

/**
 * JSON Schema for a gateway tool, derived from the tool's zod schema.
 * `format` is dropped: validators such as Ajv reject unknown formats in
 * strict mode unless format plugins are installed, and zod already checks
 * these values when the call runs.
 */
function toGatewayJsonSchema(tool: ToolDefinition): GatewayJsonObject {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return schema as GatewayJsonObject;
}

function stripPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function toGatewayDefinition(tool: ToolDefinition): GatewayToolDefinition {
  return {
    name: stripPrefix(tool.name),
    title: tool.title,
    description: tool.description,
    riskLevel: tool.annotations.readOnlyHint ? 'read' : tool.annotations.destructiveHint ? 'destructive' : 'write',
    enabledByDefault: tool.annotations.readOnlyHint,
    inputSchema: toGatewayJsonSchema(tool),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/** All tools, as gateway definitions (names without the prefix). */
export const wooCommerceGatewayTools: GatewayToolDefinition[] = WOOCOMMERCE_TOOLS.map(toGatewayDefinition);

/**
 * The tool catalog: every tool with its gateway definition and the upstream
 * requests it may make. Generated from the same tool table as the MCP server
 * and `wooCommerceGatewayTools`, and deeply frozen. Hosts can use it to build
 * their own permission model without creating a gateway instance.
 */
export const wooCommerceToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  WOOCOMMERCE_TOOLS.map(tool => ({
    ...toGatewayDefinition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
    requiresConfirmation: tool.requiresConfirmation === true,
    ...(tool.change
      ? { change: { ...tool.change, logFields: tool.change.logFields.map(field => ({ ...field })) } }
      : {}),
  })),
);

/** What a write tool call will change, resolved from its input before anything is sent. */
export interface WooCommerceChange {
  readonly tool: string;
  readonly action: WooCommerceChangeAction;
  readonly record: WooCommerceChangeRecord;
  readonly movesMoney: false;
  readonly requiresConfirmation: boolean;
  /**
   * The values of the tool's `logFields` that are present and have their
   * field's type. A value of the wrong type is left out, so a name or a free
   * text can never reach the values.
   */
  readonly values: Readonly<Record<string, string | number | boolean>>;
}

export type WooCommerceChangeResolution =
  | { readonly ok: true; readonly change: WooCommerceChange }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves what a write tool call will change, for a host that logs the
 * change before the call runs: the action, the record kind and the values of
 * the tool's `logFields`. A number the company chose (contact, product or
 * voucher number) comes back only as a pseudonym: HMAC-SHA-256 with
 * `options.pseudonymKey` when the host gives one, otherwise SHA-256. Refuses
 * read tools, unknown tools and invalid input, as callTool does.
 */
export function resolveWooCommerceChange(
  toolName: string,
  input: GatewayJsonObject = {},
  options: { pseudonymKey?: string | Uint8Array; redactor?: SecretRedactor } = {},
): WooCommerceChangeResolution {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  const tool = name ? findTool(`${TOOL_PREFIX}${stripPrefix(name)}`) : undefined;
  if (!tool) return { ok: false, reason: 'Unsupported WooCommerce gateway tool.' };
  if (!tool.change) return { ok: false, reason: `${stripPrefix(tool.name)} is not a write tool.` };
  const valid = validateCall(tool, input);
  if (!valid.ok) return { ok: false, reason: `Invalid input for ${stripPrefix(tool.name)}.` };
  const data = valid.data;
  const values: Record<string, string | number | boolean> = {};
  for (const field of tool.change.logFields) {
    const value = logFieldValue(field.type, data[field.name], options.pseudonymKey);
    if (value === undefined) continue;
    // A secret put in a field by mistake never reaches the host's log: with an instance's redactor, a value that
    // holds a piece of its key or secret is left out.
    if (options.redactor && leaksSecret(String(value), options.redactor)) continue;
    values[field.name] = value;
  }
  return {
    ok: true,
    change: Object.freeze({
      tool: stripPrefix(tool.name),
      action: tool.change.action,
      record: tool.change.record,
      movesMoney: false as const,
      requiresConfirmation: tool.requiresConfirmation === true,
      values: Object.freeze(values),
    }),
  };
}

const SECRET_OPTIONS = ['consumerKey', 'consumerSecret'] as const;
type SecretOption = (typeof SECRET_OPTIONS)[number];

function requiredSecret(options: Partial<WooCommerceGatewayOptions> | undefined, name: SecretOption): string {
  const value: unknown = options?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(
      `createWooCommerceGateway requires options.${name}. Embedded instances do not read credentials from the environment.`,
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from the key; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(value.trim())) {
    throw new ConfigError(keyRefusedText(value.trim()));
  }
  return value.trim();
}

/**
 * Create one gateway instance for one shop. `consumerKey`,
 * `consumerSecret` and `shopUrl` are required and are the only credentials
 * the instance uses; a missing value fails here.
 */
export function createWooCommerceGateway(options: WooCommerceGatewayOptions) {
  const given = options as Partial<WooCommerceGatewayOptions> | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const secrets = SECRET_OPTIONS.flatMap(name => {
    const value: unknown = given?.[name];
    return typeof value === 'string' ? [value, value.trim()] : [];
  });
  let guard: SecretRedactor | undefined;
  try {
    const admitted = Object.fromEntries(SECRET_OPTIONS.map(name => [name, requiredSecret(given, name)])) as Record<
      SecretOption,
      string
    >;
    guard = new SecretRedactor();
    for (const name of SECRET_OPTIONS) guard.addSecret(admitted[name]);
    guard.addSecret(Buffer.from(`${admitted.consumerKey}:${admitted.consumerSecret}`, 'utf8').toString('base64'));
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of a key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new ConfigError(keyRefusedText(''));
    }
    const gateway = buildGateway(options, admitted);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new ConfigError(keyRefusedText(''));
    }
    return gateway;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    let message = raw;
    if (guard) {
      // Redacted, then checked whole as the very last step: a message that still holds a piece of a key becomes
      // the fixed refusal.
      message = guard.redact(raw);
      if (leaksSecret(message, guard)) message = keyRefusedText('');
    }
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against every key given. Then the sink check on the finished object.
    const final = sealedError(error instanceof ConfigError ? new ConfigError(message) : new Error(message), ...secrets);
    if (guard && leaksSecret(final, guard)) {
      throw sealedError(new ConfigError(keyRefusedText('')), ...secrets);
    }
    throw final;
  }
}

/** Register a key given as text or bytes, in every form it could be written. */
function addKeyMaterial(redactor: SecretRedactor, key: string | Uint8Array): void {
  if (typeof key === 'string') {
    redactor.addSecret(key);
    return;
  }
  const bytes = Buffer.from(key);
  for (const form of [bytes.toString('utf8'), bytes.toString('latin1'), bytes.toString('hex'), bytes.toString('base64'), bytes.toString('base64url')]) {
    redactor.addSecret(form);
  }
}

function buildGateway(options: WooCommerceGatewayOptions, secrets: Record<SecretOption, string>) {
  const { policy: hostPolicy, consumerKey: _key, consumerSecret: _secret, shopUrl, ...clientOptions } = options;
  if (typeof shopUrl !== 'string' || shopUrl.trim() === '') {
    throw new ConfigError('createWooCommerceGateway requires options.shopUrl. Embedded instances do not read it from the environment.');
  }
  const policy =
    hostPolicy === undefined ? undefined : resolveInstancePolicy(hostPolicy, WOOCOMMERCE_TOOLS.map(tool => tool.name));
  if (policy === undefined) {
    // In a scope of its own: a gateway created from inside another instance's call (its audit sink or its fetch)
    // validates against the environment, never against that instance's policy.
    runInCallScope({}, () => validateStartupConfig());
  }
  const client = new WooCommerceClient({
    ...clientOptions,
    ...secrets,
    shopUrl: shopUrl.trim(),
    credentialEnv: {},
    // A gateway never talks to a private or local address: the switch is not read from the environment here.
    allowPrivateHost: false,
  });
  const redactor: SecretRedactor = client.redactor;
  // The host's pseudonym key is a secret like the shop's: kept out of results, logs and errors.
  if (policy?.pseudonymKey !== undefined) addKeyMaterial(redactor, policy.pseudonymKey);
  // Every call in a scope of its own, with or without a host policy: a call made from inside another
  // instance's call (its audit sink or its fetch) never runs under that instance's policy, sink or redactor.
  const underPolicy = <T>(work: () => T): T => runInCallScope(policy ? { policy, redactor } : { redactor }, work);

  return {
    /**
     * resolveWooCommerceChange bound to this instance: a value that holds a piece of
     * this instance's key or secret is left out of the values.
     */
    resolveChange(toolName: string, input: GatewayJsonObject = {}, resolveOptions: { pseudonymKey?: string | Uint8Array } = {}) {
      return resolveWooCommerceChange(toolName, input, { ...resolveOptions, redactor });
    },
    /** Tools enabled on this instance (the policy's or WOOCOMMERCE_DISABLED_TOOLS' disabled tools are left out). */
    tools: underPolicy(() => wooCommerceGatewayTools.filter(tool => !isToolDisabled(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // The whole result, text and data (keys included, numbers by their string form), with this instance's secrets
      // redacted: upstream data can echo the key, and so can an error. Redacted first, as data and depth-limited, and
      // only then copied as JSON, so no key is serialised and no deep value can exhaust the stack.
      return underPolicy(() =>
        runCall(toolName, input, context).then(
          // A second pass covers what the first one inserted (the depth placeholder). Then the sink check, as the very
          // last step: a result that holds a piece of the key anywhere, outer fields included, is withheld whole.
          result => {
            // The data also goes into the text, built from this final, redacted copy, so the sink check covers it.
            const final = withDataInText(
              JSON.parse(JSON.stringify(redactDeep(redactDeep(result, redactor), redactor))) as GatewayToolResult,
            );
            return leaksSecret(final, redactor) ? withheldResult() : final;
          },
        ),
      );
    },
  };

  async function runCall(
    toolName: string,
    input: GatewayJsonObject,
    context: GatewayCallContext | undefined,
  ): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? toolName.trim() : '';
      const tool = name ? findTool(`${TOOL_PREFIX}${stripPrefix(name)}`) : undefined;
      if (!tool) {
        // Redacted before it is cut short: a cut key would no longer match the redactor.
        await auditRejectedCall(String(toolName), input, 'unknown_tool', context);
        return errorResult('Unsupported WooCommerce gateway tool.');
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        const reason = `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`;
        await auditRejectedCall(tool.name, input, 'invalid_input', context);
        return errorResult(redactor.redact(reason));
      }

      const data = await executeTool(tool, client, parsed.data as Record<string, unknown>, context ?? undefined);
      const text = tool.returnsUpstreamContent ? `${tool.summary} ${UNTRUSTED_CONTENT_NOTE}` : tool.summary;
      return jsonResult(text, data);
    } catch (error) {
      return errorResult(formatUnknownError(error, redactor));
    }
  }
}

/** One gateway instance, as returned by createWooCommerceGateway. */
export type WooCommerceGateway = ReturnType<typeof createWooCommerceGateway>;

/** The data as it came; callTool redacts it and only then copies it as JSON. */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: (structuredContent ?? null) as GatewayJsonValue,
  };
}

/**
 * The redacted data, also as compact JSON in the text block after the summary, as the MCP spec asks of a tool
 * that returns structured content: many clients read only the text. Built from the final, redacted copy, so the
 * text holds exactly `structuredContent` and nothing more. Error results have no data and are left as they are.
 */
function withDataInText(result: GatewayToolResult): GatewayToolResult {
  if (result.isError || result.structuredContent === undefined) return result;
  const [first, ...rest] = result.content;
  const summary = first?.text ?? '';
  return {
    ...result,
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(result.structuredContent)}` }, ...rest],
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
