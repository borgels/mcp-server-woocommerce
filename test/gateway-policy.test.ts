import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWooCommerceGateway } from '../src/gateway.js';
import { BASE, stubFetch, texts, SECRET, SHOP } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'woocommerce-policy-'));
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

const KEY = `tenant-${'x'.repeat(12)}`;

function routes() {
  return stubFetch({
    [`GET ${BASE}/customers/12`]: { body: { id: 12 } },
    [`POST ${BASE}/orders/1/notes`]: { body: { id: 2 } },
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
    process.env.WOOCOMMERCE_ENABLE_WRITES = 'true';
    process.env.WOOCOMMERCE_DISABLED_TOOLS = 'get_customer';
    process.env.WOOCOMMERCE_AUDIT_LOG = join(dir, 'audit.jsonl');
    process.env.WOOCOMMERCE_ALLOW_PRIVATE_HOST = 'true';

    const reads = await envReads(async () => {
      const gw = createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: routes() as unknown as typeof fetch, policy: {} });
      expect(gw.tools.map(tool => tool.name)).toContain('get_customer');
      const read = await gw.callTool('get_customer', { customerId: 12 });
      expect(read.isError).toBeUndefined();
      const write = await gw.callTool('add_order_note', { orderId: 1, note: 'n' });
      expect(write.isError).toBe(true);
      expect(texts(write).join(' ')).toMatch(/host has not enabled writes/);
    });

    for (const name of ['WOOCOMMERCE_ENABLE_WRITES', 'WOOCOMMERCE_DISABLED_TOOLS', 'WOOCOMMERCE_AUDIT_LOG', 'WOOCOMMERCE_ALLOW_PRIVATE_HOST']) {
      expect(reads.has(name), name).toBe(false);
    }
    expect(existsSync(join(dir, 'audit.jsonl'))).toBe(false);
  });

  it('keeps two instances in one process apart', async () => {
    const fetchImpl = routes() as unknown as typeof fetch;
    const a = createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl, policy: { disabledTools: ['get_customer'] } });
    const b = createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl, policy: { enableWrites: true } });

    expect(a.tools.map(tool => tool.name)).not.toContain('get_customer');
    expect(b.tools.map(tool => tool.name)).toContain('get_customer');

    const [denied, allowed] = await Promise.all([
      a.callTool('get_customer', { customerId: 12 }),
      b.callTool('add_order_note', { orderId: 1, note: 'n' }),
    ]);
    expect(denied.isError).toBe(true);
    expect(texts(denied).join(' ')).toMatch(/disabled on this instance/);
    expect(allowed.isError).toBeUndefined();
  });

  it('sends audit records to the host and refuses a write whose start record is refused', async () => {
    const records: Array<Record<string, unknown>> = [];
    const gw = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { enableWrites: true, audit: record => void records.push({ ...record }) },
    });
    await gw.callTool('get_customer', { customerId: 12 }, { requestId: 'r1', caller: 'person-1' });
    expect(records.map(r => [r.requestId, r.action, r.caller])).toEqual([
      ['r1', 'start', 'person-1'],
      ['r1', 'finish', 'person-1'],
    ]);

    const fetchImpl = routes();
    const refusing = createWooCommerceGateway({
      consumerKey: KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: {
        enableWrites: true,
        audit: () => {
          throw new Error('sink down');
        },
      },
    });
    const write = await refusing.callTool('add_order_note', { orderId: 1, note: 'n' });
    expect(write.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unclear policy when the instance is created', () => {
    const create = (policy: unknown) => () =>
      createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, policy: policy as never });
    expect(create({ disabledTools: ['no_such_tool'] })).toThrow(/is not a known tool/);
    expect(create({ enableWrites: 'yes' })).toThrow(/enableWrites/);
    expect(create({ audit: 'file.jsonl' })).toThrow(/audit/);
    expect(create(null)).toThrow(/policy/);
  });

  it('still uses the environment without a host policy', async () => {
    process.env.WOOCOMMERCE_ENABLE_WRITES = 'true';
    const gw = createWooCommerceGateway({ consumerKey: KEY, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: routes() as unknown as typeof fetch });
    const write = await gw.callTool('add_order_note', { orderId: 1, note: 'n' });
    expect(write.isError).toBeUndefined();
  });
});
