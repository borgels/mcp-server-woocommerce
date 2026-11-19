import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_KEY_HEADER } from '../src/woocommerce/client.js';
import { createWooCommerceGateway } from '../src/gateway.js';
import { BASE, stubFetch, texts, SECRET, SHOP } from './helpers.js';

// Every gateway call runs in a call scope of its own: its policy (or the environment), its sink and its
// redactor, also when it is made from inside another instance's call, and also across await.

const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('WOOCOMMERCE_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

type AuditRecord = Record<string, unknown>;

const KEY_A = `tenant-a-${'a'.repeat(12)}`;
const KEY_B = `tenant-b-${'b'.repeat(12)}`;
// Longer than every cut the audit makes (64 for field names, 100 for tool names, 200 for reasons), so a
// key that was cut before it was redacted would show.
const LONG_KEY = `long-${'k'.repeat(250)}`;

function routes() {
  return stubFetch({
    [`GET ${BASE}/customers/12`]: { body: { id: 12 } },
    [`POST ${BASE}/orders/1/notes`]: { body: { id: 2 } },
  });
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A fetch whose answers wait until `release` is called, recording the key each request carried. */
function heldFetch() {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let signalStarted!: () => void;
  /** Resolves when the first request has reached the stand-in and is waiting. */
  const started = new Promise<void>(resolve => {
    signalStarted = resolve;
  });
  const keys: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    keys.push(String((init?.headers as Record<string, string> | undefined)?.[API_KEY_HEADER] ?? ''));
    signalStarted();
    await gate;
    return json({ id: 12 });
  }) as unknown as typeof fetch;
  return { fetchImpl, release, started, keys };
}

describe('audit records', () => {
  it('are never written with a key the redactor cannot protect: a short key is refused', () => {
    for (const accessToken of ['abc123', 'k', '1234567', '123456789012345']) {
      expect(() => createWooCommerceGateway({ consumerKey: accessToken, consumerSecret: SECRET, shopUrl: SHOP, policy: {} }), accessToken).toThrow(/key was refused/);
      expect(() => createWooCommerceGateway({ consumerKey: accessToken, consumerSecret: SECRET, shopUrl: SHOP }), accessToken).toThrow(/key was refused/);
    }
    expect(() => createWooCommerceGateway({ consumerKey: '1234567890123456', consumerSecret: SECRET, shopUrl: SHOP, policy: {} })).not.toThrow();
  });

  it('keep the instance key out, refusals, input and metadata included', async () => {
    const records: AuditRecord[] = [];
    const gw = createWooCommerceGateway({
      consumerKey: LONG_KEY,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { audit: record => void records.push(record) },
    });
    const metadata = { caller: `person ${LONG_KEY}`, requestId: LONG_KEY };
    await gw.callTool(LONG_KEY, {}, metadata);
    await gw.callTool(`get_${LONG_KEY}`, { customerId: 12 }, metadata);
    await gw.callTool('get_customer', { [LONG_KEY]: 'x', customerId: 12 }, metadata);
    await gw.callTool('get_customer', { customerId: LONG_KEY }, metadata);
    await gw.callTool('add_order_note', { orderId: 1, note: LONG_KEY }, metadata);

    expect(records.length).toBeGreaterThanOrEqual(5);
    const text = JSON.stringify(records);
    expect(text).not.toContain(LONG_KEY);
    // Not even a part of it.
    expect(text).not.toContain('k'.repeat(40));
    expect(text).toContain('‹redacted›');
  });
});

describe('call scopes', () => {
  it('isolate two allowed calls with different keys and sinks across await', async () => {
    const held = heldFetch();
    const sinkA: AuditRecord[] = [];
    const sinkB: AuditRecord[] = [];
    const a = createWooCommerceGateway({ consumerKey: KEY_A, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: held.fetchImpl, policy: { audit: r => void sinkA.push(r) } });
    const b = createWooCommerceGateway({
      consumerKey: KEY_B,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { enableWrites: true, audit: r => void sinkB.push(r) },
    });

    // A starts and waits inside its upstream request; B runs a read and a write meanwhile; then A resumes.
    const pendingA = a.callTool('get_customer', { customerId: 12 }, { requestId: 'a' });
    await held.started;
    expect(held.keys).toEqual([`Basic ${Buffer.from(`${KEY_A}:${SECRET}`).toString('base64')}`]);
    expect((await b.callTool('get_customer', { customerId: 12 }, { requestId: 'b1' })).isError).toBeUndefined();
    expect((await b.callTool('add_order_note', { orderId: 1, note: 'n' }, { requestId: 'b2' })).isError).toBeUndefined();
    held.release();
    expect((await pendingA).isError).toBeUndefined();
    // After resuming, A still cannot write: its own policy, not B's.
    expect((await a.callTool('add_order_note', { orderId: 1, note: 'n' }, { requestId: 'a2' })).isError).toBe(true);

    expect(sinkA.filter(r => r.requestId === 'a').map(r => r.action)).toEqual(['start', 'finish']);
    expect(new Set(sinkA.map(r => r.requestId))).toEqual(new Set(['a', 'a2']));
    expect(new Set(sinkB.map(r => r.requestId))).toEqual(new Set(['b1', 'b2']));
  });

  it('do not let a call from inside another instance inherit its policy or sink', async () => {
    // A allows writes and audits to its sink. From inside A's sink, B (no host policy; the environment
    // allows no writes) tries a write: refused, nothing sent, and nothing of B's in A's sink.
    const sinkA: AuditRecord[] = [];
    const fetchB = routes();
    const b = createWooCommerceGateway({ consumerKey: KEY_B, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: fetchB as unknown as typeof fetch });
    const nested: Array<Promise<{ isError?: boolean; content: Array<{ text: string }> }>> = [];
    const a = createWooCommerceGateway({
      consumerKey: KEY_A,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: {
        enableWrites: true,
        audit: record => {
          sinkA.push(record);
          if (record.action === 'start' && nested.length === 0) {
            nested.push(b.callTool('add_order_note', { orderId: 1, note: 'n' }, { requestId: 'b' }));
          }
        },
      },
    });
    expect((await a.callTool('add_order_note', { orderId: 1, note: 'n' }, { requestId: 'a' })).isError).toBeUndefined();
    const fromInside = await nested[0]!;
    expect(fromInside.isError).toBe(true);
    expect(texts(fromInside).join(' ')).toMatch(/WOOCOMMERCE_ENABLE_WRITES/);
    expect(fetchB).not.toHaveBeenCalled();
    expect(sinkA.every(r => r.requestId === 'a')).toBe(true);
  });

  it('do not let an instance with a policy, called from inside one without, use the environment', async () => {
    // A has no host policy and the environment allows writes. From inside A's upstream request, B (host
    // policy without writes) tries a write: refused. After B returns, A's own write still goes through.
    process.env.WOOCOMMERCE_ENABLE_WRITES = 'true';
    const fetchB = routes();
    const b = createWooCommerceGateway({ consumerKey: KEY_B, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: fetchB as unknown as typeof fetch, policy: {} });
    let fromInside: { isError?: boolean } | undefined;
    const fetchA = (async () => {
      fromInside = await b.callTool('add_order_note', { orderId: 1, note: 'n' });
      return json({ id: 2 });
    }) as unknown as typeof fetch;
    const a = createWooCommerceGateway({ consumerKey: KEY_A, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: fetchA });
    expect((await a.callTool('add_order_note', { orderId: 1, note: 'n' })).isError).toBeUndefined();
    expect(fromInside?.isError).toBe(true);
    expect(fetchB).not.toHaveBeenCalled();
  });

  it('validate a gateway created inside another instance against the environment, not against its policy', async () => {
    // A's policy disables nothing unknown; the environment names a tool that does not exist. A gateway without a host
    // policy, created inside A's sink or fetch, must fail on the environment as it would anywhere else.
    process.env.WOOCOMMERCE_DISABLED_TOOLS = 'no_such_tool';
    const created: Array<{ where: string; error: unknown }> = [];
    const tryCreate = (where: string) => {
      try {
        createWooCommerceGateway({ consumerKey: KEY_B, consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: routes() as unknown as typeof fetch });
        created.push({ where, error: undefined });
      } catch (error) {
        created.push({ where, error });
      }
    };
    const fetchA = (async () => {
      tryCreate('fetch');
      return json({ id: 12 });
    }) as unknown as typeof fetch;
    const a = createWooCommerceGateway({
      consumerKey: KEY_A,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: fetchA,
      policy: {
        audit: record => {
          if (record.action === 'start') tryCreate('sink');
        },
      },
    });
    expect((await a.callTool('get_customer', { customerId: 12 })).isError).toBeUndefined();
    expect(created.map(c => c.where).sort()).toEqual(['fetch', 'sink']);
    for (const c of created) {
      expect(String(c.error), c.where).toMatch(/WOOCOMMERCE_DISABLED_TOOLS names 1 unknown tool/);
    }
  });

  it('never send a write upstream when the start record is refused', async () => {
    const fetchImpl = routes();
    const gw = createWooCommerceGateway({
      consumerKey: KEY_A,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: {
        enableWrites: true,
        audit: record => {
          if (record.action === 'start') throw new Error('sink down');
        },
      },
    });
    expect((await gw.callTool('get_customer', { customerId: 12 })).isError).toBeUndefined();
    const write = await gw.callTool('add_order_note', { orderId: 1, note: 'n' });
    expect(write.isError).toBe(true);
    expect(fetchImpl.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toEqual([]);
  });

  it('name the host, not an environment variable, when a host policy refuses', async () => {
    const gw = createWooCommerceGateway({
      consumerKey: KEY_A,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { disabledTools: ['get_customer'] },
    });
    const disabled = texts(await gw.callTool('get_customer', { customerId: 12 })).join(' ');
    const write = texts(await gw.callTool('add_order_note', { orderId: 1, note: 'n' })).join(' ');
    for (const text of [disabled, write]) {
      expect(text).not.toMatch(/WOOCOMMERCE_/);
      expect(text).toMatch(/host/);
    }
  });
});
