import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExampleGateway } from '../src/gateway.js';
import { BASE, stubFetch, texts } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'example-policy-'));
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

const KEY = `tenant-${'x'.repeat(12)}`;

function routes() {
  return stubFetch({
    [`GET ${BASE}/items/i1`]: { body: { id: 'i1' } },
    [`POST ${BASE}/items`]: { body: { id: 'new' } },
  });
}

/** Records every environment variable read while `work` runs. */
async function envReads(work: () => Promise<void>): Promise<Set<string>> {
  const reads = new Set<string>();
  const env = { ...process.env };
  process.env = new Proxy(env, {
    get(target, property, receiver) {
      if (typeof property === 'string') {
        reads.add(property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await work();
  } finally {
    process.env = env;
  }
  return reads;
}

describe('instance policy from the host', () => {
  it('reads no policy or audit variable from the environment', async () => {
    process.env.EXAMPLE_ENABLE_WRITES = 'true';
    process.env.EXAMPLE_DISABLED_TOOLS = 'get_item';
    process.env.EXAMPLE_AUDIT_LOG = join(dir, 'audit.jsonl');
    process.env.EXAMPLE_ALLOW_CUSTOM_BASE_URL = 'true';

    const reads = await envReads(async () => {
      const gw = createExampleGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: routes() as unknown as typeof fetch, policy: {} });
      expect(gw.tools.map(tool => tool.name)).toContain('get_item');
      const read = await gw.callTool('get_item', { itemId: 'i1' });
      expect(read.isError).toBeUndefined();
      const write = await gw.callTool('create_item', { name: 'n' });
      expect(write.isError).toBe(true);
      expect(texts(write).join(' ')).toMatch(/host has not enabled writes/);
    });

    for (const name of ['EXAMPLE_ENABLE_WRITES', 'EXAMPLE_DISABLED_TOOLS', 'EXAMPLE_AUDIT_LOG', 'EXAMPLE_ALLOW_CUSTOM_BASE_URL']) {
      expect(reads.has(name), name).toBe(false);
    }
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(false);
  });

  it('keeps two instances in one process apart', async () => {
    const fetchImpl = routes() as unknown as typeof fetch;
    const a = createExampleGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { disabledTools: ['get_item'] } });
    const b = createExampleGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { enableWrites: true } });

    expect(a.tools.map(tool => tool.name)).not.toContain('get_item');
    expect(b.tools.map(tool => tool.name)).toContain('get_item');

    const [denied, allowed] = await Promise.all([
      a.callTool('get_item', { itemId: 'i1' }),
      b.callTool('create_item', { name: 'n' }),
    ]);
    expect(denied.isError).toBe(true);
    expect(texts(denied).join(' ')).toMatch(/disabled on this instance/);
    expect(allowed.isError).toBeUndefined();
  });

  it('sends audit records to the host and refuses a write whose start record is refused', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createExampleGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { enableWrites: true, audit: record => void records.push({ ...record }) },
    });
    await gw.callTool('get_item', { itemId: 'i1' }, { requestId: 'r1', caller: 'person-1' });
    expect(records.map(r => [r.requestId, r.action, r.caller])).toEqual([
      ['r1', 'start', 'person-1'],
      ['r1', 'finish', 'person-1'],
    ]);

    const fetchImpl = routes();
    const refusing = createExampleGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: {
        enableWrites: true,
        audit: () => {
          throw new Error('sink down');
        },
      },
    });
    const write = await refusing.callTool('create_item', { name: 'n' });
    expect(write.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unclear policy when the instance is created', () => {
    const create = (policy: unknown) => () =>
      createExampleGateway({ apiKey: KEY, baseUrl: BASE, policy: policy as never });
    expect(create({ disabledTools: ['no_such_tool'] })).toThrow(/is not a known tool/);
    expect(create({ enableWrites: 'yes' })).toThrow(/enableWrites/);
    expect(create({ audit: 'file.jsonl' })).toThrow(/audit/);
    expect(create(null)).toThrow(/policy/);
  });

  it('still uses the environment without a host policy', async () => {
    process.env.EXAMPLE_ENABLE_WRITES = 'true';
    const gw = createExampleGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: routes() as unknown as typeof fetch });
    const write = await gw.callTool('create_item', { name: 'n' });
    expect(write.isError).toBeUndefined();
  });
});
