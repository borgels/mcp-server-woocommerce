import { AsyncLocalStorage } from 'node:async_hooks';
import { ConfigError, readEnvBoolean, readEnvList } from '../config-env.js';
import type { SecretRedactor } from '../errors.js';

/**
 * Server-side guards that apply to every tool call, whether it arrives over
 * MCP or through the embeddable gateway entry point.
 *
 * - Write tools are opt-in per instance (EXAMPLE_ENABLE_WRITES=true).
 * - EXAMPLE_DISABLED_TOOLS turns individual tools off; they are not even
 *   registered.
 *
 * The template has no input allowlists. A server that adds one (account or
 * project ids) adds it to checkInputPolicy, to the environment and to
 * InstancePolicy. Any client-side permission model sits on top of these;
 * the environment decides what the server will ever do.
 *
 * An embedding host that serves several tenants from one process passes an
 * InstancePolicy to the gateway instead. That instance's calls then run with
 * the host's policy and read none of the policy or audit variables from the
 * environment, so a tenant's settings never come from a value the whole
 * process shares.
 *
 * Every gateway call runs in its own call scope (runInCallScope), with or
 * without a host policy, so a call made from inside another instance's call
 * (from its audit sink or its fetch) never inherits that instance's policy,
 * sink or redactor.
 */

/** Receives one audit record (the JSON object the audit log would hold). */
export type AuditSink = (record: Readonly<Record<string, unknown>>) => void | Promise<void>;

/** Policy given by an embedding host for one gateway instance. */
export interface InstancePolicy {
  /** Allow write tools. Default false. */
  enableWrites?: boolean;
  /** Tools turned off on this instance, with or without the prefix. Must name known tools. */
  disabledTools?: readonly string[];
  /**
   * Receives every audit record of this instance's calls, instead of
   * EXAMPLE_AUDIT_LOG. Without it the instance writes no audit records. A
   * write tool runs only if its start record was accepted, so a sink that
   * throws refuses the write.
   */
  audit?: AuditSink;
}

/** An InstancePolicy, checked and normalised. */
export interface ResolvedInstancePolicy {
  readonly enableWrites: boolean;
  readonly disabledTools: ReadonlySet<string>;
  readonly audit?: AuditSink;
}

/** What one gateway call runs under: the host's policy (none: the environment applies) and the instance's redactor. */
export interface CallScope {
  readonly policy?: ResolvedInstancePolicy;
  readonly redactor?: SecretRedactor;
}

const callScope = new AsyncLocalStorage<CallScope>();

/** Check a host's policy against the known tools. Throws ConfigError on anything unclear. */
export function resolveInstancePolicy(policy: InstancePolicy, knownTools: readonly string[]): ResolvedInstancePolicy {
  if (policy === null || typeof policy !== 'object') {
    throw new ConfigError('policy must be an object');
  }
  if (policy.enableWrites !== undefined && typeof policy.enableWrites !== 'boolean') {
    throw new ConfigError('policy.enableWrites must be a boolean');
  }
  if (policy.disabledTools !== undefined && !Array.isArray(policy.disabledTools)) {
    throw new ConfigError('policy.disabledTools must be an array of tool names');
  }
  if (policy.audit !== undefined && typeof policy.audit !== 'function') {
    throw new ConfigError('policy.audit must be a function');
  }
  const known = new Set(knownTools);
  const disabled = new Set<string>();
  for (const [index, name] of (policy.disabledTools ?? []).entries()) {
    if (typeof name !== 'string' || !known.has(canonicalToolName(name))) {
      // The value is not quoted: a configuration value is never echoed, not even shortened.
      throw new ConfigError(`policy.disabledTools[${index}] is not a known tool.`);
    }
    disabled.add(canonicalToolName(name));
  }
  return Object.freeze({
    enableWrites: policy.enableWrites === true,
    disabledTools: disabled,
    ...(policy.audit ? { audit: policy.audit } : {}),
  });
}

/**
 * Run `work` (and everything it awaits) in a call scope of its own. Always a
 * fresh scope: a scope without a policy means the environment applies, even
 * when the caller is itself inside another instance's call.
 */
export function runInCallScope<T>(scope: CallScope, work: () => T): T {
  return callScope.run(Object.freeze({ ...scope }), work);
}

/** The host's policy of the call in progress, or undefined (the environment applies). */
export function currentInstancePolicy(): ResolvedInstancePolicy | undefined {
  return callScope.getStore()?.policy;
}

/** The redactor of the instance whose call is in progress, if any. */
export function currentRedactor(): SecretRedactor | undefined {
  return callScope.getStore()?.redactor;
}

/** Text with the current instance's secrets redacted (unchanged outside a gateway call). */
export function redactInScope(text: string): string {
  const redactor = currentRedactor();
  return redactor ? redactor.redact(text) : text;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

export const TOOL_PREFIX = 'example_';

export function writesEnabled(): boolean {
  const hosted = currentInstancePolicy();
  if (hosted) {
    return hosted.enableWrites;
  }
  return readEnvBoolean('EXAMPLE_ENABLE_WRITES', false);
}

/** Tool names are accepted with or without the prefix, case-insensitively. */
export function canonicalToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.startsWith(TOOL_PREFIX) ? lower : `${TOOL_PREFIX}${lower}`;
}

function disabledTools(): ReadonlySet<string> {
  const hosted = currentInstancePolicy();
  if (hosted) {
    return hosted.disabledTools;
  }
  return new Set(readEnvList('EXAMPLE_DISABLED_TOOLS').map(canonicalToolName));
}

export function isToolDisabled(toolName: string): boolean {
  return disabledTools().has(canonicalToolName(toolName));
}

/**
 * Validate the policy environment once at startup: boolean switches must be
 * valid and EXAMPLE_DISABLED_TOOLS may only name known tools, so a typo
 * cannot silently leave a tool enabled.
 */
export function validatePolicyConfig(knownTools: readonly string[]): void {
  writesEnabled();
  const known = new Set(knownTools);
  const unknown = [...disabledTools()].filter(name => !known.has(name));
  if (unknown.length > 0) {
    // The names are not quoted: a configuration value is never echoed, not even shortened.
    throw new ConfigError(`EXAMPLE_DISABLED_TOOLS names ${unknown.length} unknown tool(s).`);
  }
}

export function checkToolPolicy(toolName: string, readOnly: boolean): PolicyDecision {
  if (isToolDisabled(toolName)) {
    const source = currentInstancePolicy() ? 'by the embedding host' : '(EXAMPLE_DISABLED_TOOLS)';
    return { allowed: false, reason: `tool is disabled on this instance ${source}: ${toolName}` };
  }
  if (readOnly) {
    return { allowed: true, reason: 'read-only tool' };
  }
  if (!writesEnabled()) {
    return {
      allowed: false,
      reason:
        `write tool is disabled on this instance: ${toolName}. ` +
        (currentInstancePolicy()
          ? 'The embedding host has not enabled writes for this instance.'
          : 'Set EXAMPLE_ENABLE_WRITES=true in the server environment to allow write tools.'),
    };
  }
  return { allowed: true, reason: 'write tool (writes enabled on this instance)' };
}

/** Input-dependent checks (allowlists on ids in the input). None by default. */
export function checkInputPolicy(_toolName: string, _input: Record<string, unknown>): PolicyDecision {
  return { allowed: true, reason: 'no input restrictions configured' };
}
