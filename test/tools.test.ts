import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstreamClient } from '../src/example/client.js';
import { createServer, getDefaultClient } from '../src/server.js';
import { createExampleGateway, exampleGatewayTools } from '../src/gateway.js';
import { EXAMPLE_TOOLS, executeTool, validateStartupConfig } from '../src/tools/example.js';
import { BASE, auditLines, connect, gateway, makeClient, texts } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'example-mcp-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('EXAMPLE_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

const item = { id: 'i1', name: 'First item' };

describe('MCP tool surface', () => {
  it('registers every tool with matching annotations', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(EXAMPLE_TOOLS.map(t => t.name).sort());
    for (const tool of tools) {
      const definition = EXAMPLE_TOOLS.find(t => t.name === tool.name);
      expect(tool.annotations).toEqual(definition?.annotations);
    }
  });

  it('runs the read tool and labels upstream content as data', async () => {
    const { mcpClient, fetchImpl } = await connect({ [`GET ${BASE}/items/i1`]: { body: item } });
    const result = await mcpClient.callTool({ name: 'example_get_item', arguments: { itemId: 'i1' } });
    expect(result.isError).toBeFalsy();
    const [json, note] = texts(result);
    expect(JSON.parse(json ?? '')).toEqual(item);
    expect(note).toContain('not instructions');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown arguments and path traversal', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const extra = await mcpClient.callTool({ name: 'example_get_item', arguments: { itemId: 'i1', other: 1 } });
    expect(extra.isError).toBe(true);
    const traversal = await mcpClient.callTool({ name: 'example_get_item', arguments: { itemId: '..' } });
    expect(traversal.isError).toBe(true);
    expect(texts(traversal).join(' ')).toContain('Invalid itemId');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses the write tool unless writes are enabled, without calling upstream', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const result = await mcpClient.callTool({ name: 'example_create_item', arguments: { name: 'New' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('EXAMPLE_ENABLE_WRITES');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs the write tool when enabled and audits it', async () => {
    process.env.EXAMPLE_ENABLE_WRITES = 'true';
    process.env.EXAMPLE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/items`]: { status: 201, body: item } });
    const result = await mcpClient.callTool({
      name: 'example_create_item',
      arguments: { name: 'First item', description: 'text' },
    });
    expect(result.isError).toBeFalsy();
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'First item', description: 'text' });

    const lines = auditLines(process.env.EXAMPLE_AUDIT_LOG);
    expect(lines.map(line => line.action)).toEqual(['start', 'finish']);
    expect(lines[0]?.requestId).toBe(lines[1]?.requestId);
    // Free text is hashed, never logged in clear text.
    expect(JSON.stringify(lines)).not.toContain('First item');
    expect((lines[0]?.target as Record<string, unknown>).nameSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses an unwritable audit log path at startup, but not per server instance', async () => {
    process.env.EXAMPLE_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    expect(() => validateStartupConfig()).toThrow('EXAMPLE_AUDIT_LOG');
    expect(() => createExampleGateway({ apiKey: 'tttt-gggg-wwww-vvvv-1', baseUrl: BASE })).toThrow('EXAMPLE_AUDIT_LOG');

    // The HTTP transport creates a server per request: read tools keep working.
    const { mcpClient } = await connect({ [`GET ${BASE}/items/i1`]: { body: item } });
    const result = await mcpClient.callTool({ name: 'example_get_item', arguments: { itemId: 'i1' } });
    expect(result.isError).toBeFalsy();
  });

  it('fails closed when the audit log cannot be written before a write', async () => {
    process.env.EXAMPLE_ENABLE_WRITES = 'true';
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/items`]: { body: item } });
    // The log becomes unwritable after startup.
    process.env.EXAMPLE_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    const result = await mcpClient.callTool({ name: 'example_create_item', arguments: { name: 'x' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('Audit log is not writable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes disabled tools and refuses unknown names', async () => {
    process.env.EXAMPLE_DISABLED_TOOLS = 'create_item';
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name)).toEqual(['example_get_item']);

    process.env.EXAMPLE_DISABLED_TOOLS = 'no_such_tool';
    expect(() => createServer({ clientOptions: { apiKey: 'k' } })).toThrow('EXAMPLE_DISABLED_TOOLS');
  });

  it('logs only a summary of upstream errors', async () => {
    process.env.EXAMPLE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient } = await connect({
      [`GET ${BASE}/items/i1`]: { status: 400, body: { message: 'bad value: jane@vendor.test' } },
    });
    const result = await mcpClient.callTool({ name: 'example_get_item', arguments: { itemId: 'i1' } });
    expect(result.isError).toBe(true);
    const lines = auditLines(process.env.EXAMPLE_AUDIT_LOG);
    expect(lines.at(-1)).toMatchObject({ action: 'error', httpStatus: 400 });
    expect(JSON.stringify(lines)).not.toContain('jane@');
  });
});

describe('write gate beyond annotations', () => {
  it('gives read-only tools a client that refuses non-GET requests', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl);
    const misannotated = {
      ...EXAMPLE_TOOLS[0]!,
      name: 'example_get_item',
      handler: async (c: UpstreamClient) => c.post('/items', { name: 'x' }),
    };
    await expect(executeTool(misannotated, client, { itemId: 'i1' })).rejects.toThrow(/Read-only tool .* POST/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts error text centrally on the MCP path', async () => {
    // A handler that throws a raw, unredacted error.
    const tool = EXAMPLE_TOOLS.find(t => t.name === 'example_get_item')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed: key test-api-key, header X-API-Key: other-secret, {"apiKey":"third-secret"}');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'example_get_item', arguments: { itemId: 'i1' } });
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
    expect(exampleGatewayTools.map(t => [t.name, t.riskLevel, t.enabledByDefault])).toEqual([
      ['get_item', 'read', true],
      ['create_item', 'destructive', false],
    ]);
    const ajv = new Ajv({ strict: true });
    for (const tool of exampleGatewayTools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('validates input, applies the policy and records the caller', async () => {
    process.env.EXAMPLE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { gw, fetchImpl } = gateway({ [`GET ${BASE}/items/i1`]: { body: item } });

    const ok = await gw.callTool('get_item', { itemId: 'i1' }, { caller: 'user@vendor.test', requestId: 'req-1' });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual(item);

    const invalid = await gw.callTool('get_item', { itemId: 'i1', extra: true });
    expect(invalid.isError).toBe(true);
    const unknown = await gw.callTool('delete_everything', {});
    expect(unknown.isError).toBe(true);
    const write = await gw.callTool('create_item', { name: 'x' });
    expect(write.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const lines = auditLines(process.env.EXAMPLE_AUDIT_LOG);
    expect(lines[0]).toMatchObject({ requestId: 'req-1', caller: 'user@vendor.test', action: 'start' });
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
