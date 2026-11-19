import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstreamClient } from '../src/woocommerce/client.js';
import { createServer, getDefaultClient } from '../src/server.js';
import { createWooCommerceGateway, wooCommerceGatewayTools } from '../src/gateway.js';
import { WOOCOMMERCE_TOOLS, executeTool, validateStartupConfig } from '../src/tools/woocommerce.js';
import { BASE, auditLines, connect, gateway, makeClient, texts, SECRET, SHOP } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'woocommerce-mcp-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('WOOCOMMERCE_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

const item = { id: 12, first_name: 'First item' };
const note = { id: 2, note: 'First item' };

describe('MCP tool surface', () => {
  it('registers every tool with matching annotations', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(WOOCOMMERCE_TOOLS.map(t => t.name).sort());
    for (const tool of tools) {
      const definition = WOOCOMMERCE_TOOLS.find(t => t.name === tool.name);
      expect(tool.annotations).toEqual(definition?.annotations);
    }
  });

  it('runs the read tool and labels upstream content as data', async () => {
    const { mcpClient, fetchImpl } = await connect({ [`GET ${BASE}/customers/12`]: { body: item } });
    const result = await mcpClient.callTool({ name: 'woocommerce_get_customer', arguments: { customerId: 12 } });
    expect(result.isError).toBeFalsy();
    const [json, note] = texts(result);
    expect(JSON.parse(json ?? '')).toEqual(item);
    expect(note).toContain('not instructions');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown arguments and path traversal', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const extra = await mcpClient.callTool({ name: 'woocommerce_get_customer', arguments: { customerId: 12, other: 1 } });
    expect(extra.isError).toBe(true);
    const traversal = await mcpClient.callTool({ name: 'woocommerce_get_customer', arguments: { customerId: -1 } });
    expect(traversal.isError).toBe(true);
    const slash = await mcpClient.callTool({ name: 'woocommerce_get_customer', arguments: { customerId: 'a/b' } });
    expect(slash.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses the write tool unless writes are enabled, without calling upstream', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const result = await mcpClient.callTool({ name: 'woocommerce_add_order_note', arguments: { orderId: 1, note: 'New' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('WOOCOMMERCE_ENABLE_WRITES');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs the write tool when enabled and audits it', async () => {
    process.env.WOOCOMMERCE_ENABLE_WRITES = 'true';
    process.env.WOOCOMMERCE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/orders/1/notes`]: { status: 201, body: note } });
    const result = await mcpClient.callTool({
      name: 'woocommerce_add_order_note',
      arguments: { orderId: 1, note: 'First item' },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(texts(result)[0] ?? '')).toEqual(note);
    const init = fetchImpl.mock.calls[0]?.[1];
    // A private note: the customer is never notified.
    expect(JSON.parse(String(init?.body))).toEqual({ note: 'First item', customer_note: false });

    const lines = auditLines(process.env.WOOCOMMERCE_AUDIT_LOG);
    expect(lines.map(line => line.action)).toEqual(['start', 'finish']);
    expect(lines[0]?.requestId).toBe(lines[1]?.requestId);
    // The note is not logged at all, not even hashed; the order id is.
    expect(JSON.stringify(lines)).not.toContain('First item');
    expect(lines[0]?.target).toEqual({ orderId: 1 });
  });

  it('refuses an unwritable audit log path at startup, but not per server instance', async () => {
    process.env.WOOCOMMERCE_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    expect(() => validateStartupConfig()).toThrow('WOOCOMMERCE_AUDIT_LOG');
    expect(() => createWooCommerceGateway({ consumerKey: 'tttt-gggg-wwww-vvvv-1', consumerSecret: SECRET, shopUrl: SHOP })).toThrow('WOOCOMMERCE_AUDIT_LOG');

    // The HTTP transport creates a server per request: read tools keep working.
    const { mcpClient } = await connect({ [`GET ${BASE}/customers/12`]: { body: item } });
    const result = await mcpClient.callTool({ name: 'woocommerce_get_customer', arguments: { customerId: 12 } });
    expect(result.isError).toBeFalsy();
  });

  it('fails closed when the audit log cannot be written before a write', async () => {
    process.env.WOOCOMMERCE_ENABLE_WRITES = 'true';
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/orders/1/notes`]: { body: note } });
    // The log becomes unwritable after startup.
    process.env.WOOCOMMERCE_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    const result = await mcpClient.callTool({ name: 'woocommerce_add_order_note', arguments: { orderId: 1, note: 'x' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('Audit log is not writable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes disabled tools and refuses unknown names', async () => {
    process.env.WOOCOMMERCE_DISABLED_TOOLS = 'add_order_note,woocommerce_get_customer';
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name)).not.toContain('woocommerce_add_order_note');
    expect(tools.map(t => t.name)).not.toContain('woocommerce_get_customer');
    expect(tools).toHaveLength(WOOCOMMERCE_TOOLS.length - 2);

    process.env.WOOCOMMERCE_DISABLED_TOOLS = 'no_such_tool';
    expect(() => createServer({ clientOptions: { consumerKey: 'k', consumerSecret: 's', shopUrl: 'https://shop.example.com' } })).toThrow('WOOCOMMERCE_DISABLED_TOOLS');
  });

  it('logs only a summary of upstream errors', async () => {
    process.env.WOOCOMMERCE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient } = await connect({
      [`GET ${BASE}/customers/12`]: { status: 400, body: { message: 'bad value: jane@vendor.test' } },
    });
    const result = await mcpClient.callTool({ name: 'woocommerce_get_customer', arguments: { customerId: 12 } });
    expect(result.isError).toBe(true);
    const lines = auditLines(process.env.WOOCOMMERCE_AUDIT_LOG);
    expect(lines.at(-1)).toMatchObject({ action: 'error', httpStatus: 400 });
    expect(JSON.stringify(lines)).not.toContain('jane@');
  });
});

describe('write gate beyond annotations', () => {
  it('gives read-only tools a client that refuses non-GET requests', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl);
    const misannotated = {
      ...WOOCOMMERCE_TOOLS[0]!,
      name: 'woocommerce_get_customer',
      handler: async (c: UpstreamClient) => c.post('/contacts', { name: 'x' }),
    };
    await expect(executeTool(misannotated, client, { customerId: 12 })).rejects.toThrow(/Read-only tool .* POST/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts error text centrally on the MCP path', async () => {
    // A handler that throws a raw, unredacted error.
    const tool = WOOCOMMERCE_TOOLS.find(t => t.name === 'woocommerce_get_customer')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed: key test-api-key, header Authorization: Basic other-secret, {"consumer_secret":"third-secret"}');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'woocommerce_get_customer', arguments: { customerId: 12 } });
      expect(result.isError).toBe(true);
      const text = texts(result).join(' ');
      expect(text).toContain('‹redacted›');
      for (const secret of ['test-api-key', 'other-secret', 'third-secret']) {
        expect(text).not.toContain(secret);
      }
    } finally {
      tool.handler = original;
    }
  });
});

describe('gateway export', () => {
  it('exposes tools without the prefix and with valid JSON Schemas', () => {
    for (const tool of wooCommerceGatewayTools) {
      expect(tool.name.startsWith('woocommerce_')).toBe(false);
      // Reads are on by default; writes are 'write' (none deletes) and off by default.
      expect([tool.riskLevel, tool.enabledByDefault]).toEqual(
        tool.riskLevel === 'read' ? ['read', true] : ['write', false],
      );
    }
    expect(wooCommerceGatewayTools.filter(t => t.riskLevel === 'write').map(t => t.name)).toEqual([
      'update_order_status',
      'add_order_note',
      'record_refund',
      'create_draft_product',
      'update_product',
      'update_customer',
    ]);
    const ajv = new Ajv({ strict: true });
    for (const tool of wooCommerceGatewayTools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('validates input, applies the policy and records the caller', async () => {
    process.env.WOOCOMMERCE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { gw, fetchImpl } = gateway({ [`GET ${BASE}/customers/12`]: { body: item } });

    const ok = await gw.callTool('get_customer', { customerId: 12 }, { caller: 'user@vendor.test', requestId: 'req-1' });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual(item);

    const invalid = await gw.callTool('get_customer', { customerId: 12, extra: true });
    expect(invalid.isError).toBe(true);
    const unknown = await gw.callTool('delete_everything', {});
    expect(unknown.isError).toBe(true);
    const write = await gw.callTool('add_order_note', { orderId: 1, note: 'x' });
    expect(write.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const lines = auditLines(process.env.WOOCOMMERCE_AUDIT_LOG);
    expect(lines[0]).toMatchObject({ requestId: 'req-1', caller: expect.stringMatching(/^sha256:[0-9a-f]{16}$/), action: 'start' });
    expect(JSON.stringify(lines)).not.toContain('user@vendor.test');
    expect(lines.map(line => line.action)).toEqual(['start', 'finish', 'rejected', 'rejected', 'policy_denied']);
  });
});

describe('default client', () => {
  it('is shared by servers created without a client, so its concurrency limit is process-wide', () => {
    const first = getDefaultClient();
    createServer();
    createServer();
    expect(getDefaultClient()).toBe(first);
  });
});
