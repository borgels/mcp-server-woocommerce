import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_KEY_HEADER } from '../src/example/client.js';
import { createExampleGateway } from '../src/gateway.js';
import { BASE, stubFetch, texts } from './helpers.js';

// Every gateway call runs in a call scope of its own: its policy (or the environment), its sink and its
// redactor, also when it is made from inside another instance's call, and also across await.

const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('EXAMPLE_')) {
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
    [`GET ${BASE}/items/i1`]: { body: { id: 'i1' } },
    [`POST ${BASE}/items`]: { body: { id: 'new' } },
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
    return json({ id: 'i1' });
  }) as unknown as typeof fetch;
  return { fetchImpl, release, started, keys };
}

describe('audit records', () => {
  it('are never written with a key the redactor cannot protect: a short key is refused', () => {
    for (const apiKey of ['abc123', 'k', '1234567', '123456789012345']) {
      expect(() => createExampleGateway({ apiKey, baseUrl: BASE, policy: {} }), apiKey).toThrow(/key was refused/);
      expect(() => createExampleGateway({ apiKey, baseUrl: BASE }), apiKey).toThrow(/key was refused/);
    }
    expect(() => createExampleGateway({ apiKey: '1234567890123456', baseUrl: BASE, policy: {} })).not.toThrow();
  });

  it('keep the instance key out, refusals, input and metadata included', async () => {
    const records: AuditRecord[] = [];
    const gw = createExampleGateway({
      apiKey: LONG_KEY,
      baseUrl: BASE,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { audit: record => void records.push(record) },
    });
    const metadata = { caller: `person ${LONG_KEY}`, requestId: LONG_KEY };
    await gw.callTool(LONG_KEY, {}, metadata);
    await gw.callTool(`get_${LONG_KEY}`, { itemId: 'i1' }, metadata);
    await gw.callTool('get_item', { [LONG_KEY]: 'x', itemId: 'i1' }, metadata);
    await gw.callTool('get_item', { itemId: LONG_KEY }, metadata);
    await gw.callTool('create_item', { name: LONG_KEY, description: LONG_KEY }, metadata);

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
    const a = createExampleGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: held.fetchImpl, policy: { audit: r => void sinkA.push(r) } });
    const b = createExampleGateway({
      apiKey: KEY_B,
      baseUrl: BASE,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { enableWrites: true, audit: r => void sinkB.push(r) },
    });

    // A starts and waits inside its upstream request; B runs a read and a write meanwhile; then A resumes.
    const pendingA = a.callTool('get_item', { itemId: 'i1' }, { requestId: 'a' });
    await held.started;
    expect(held.keys).toEqual([KEY_A]);
    expect((await b.callTool('get_item', { itemId: 'i1' }, { requestId: 'b1' })).isError).toBeUndefined();
    expect((await b.callTool('create_item', { name: 'n' }, { requestId: 'b2' })).isError).toBeUndefined();
    held.release();
    expect((await pendingA).isError).toBeUndefined();
    // After resuming, A still cannot write: its own policy, not B's.
    expect((await a.callTool('create_item', { name: 'n' }, { requestId: 'a2' })).isError).toBe(true);

    expect(sinkA.filter(r => r.requestId === 'a').map(r => r.action)).toEqual(['start', 'finish']);
    expect(new Set(sinkA.map(r => r.requestId))).toEqual(new Set(['a', 'a2']));
    expect(new Set(sinkB.map(r => r.requestId))).toEqual(new Set(['b1', 'b2']));
  });

  it('do not let a call from inside another instance inherit its policy or sink', async () => {
    // A allows writes and audits to its sink. From inside A's sink, B (no host policy; the environment
    // allows no writes) tries a write: refused, nothing sent, and nothing of B's in A's sink.
    const sinkA: AuditRecord[] = [];
    const fetchB = routes();
    const b = createExampleGateway({ apiKey: KEY_B, baseUrl: BASE, fetchImpl: fetchB as unknown as typeof fetch });
    const nested: Array<Promise<{ isError?: boolean; content: Array<{ text: string }> }>> = [];
    const a = createExampleGateway({
      apiKey: KEY_A,
      baseUrl: BASE,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: {
        enableWrites: true,
        audit: record => {
          sinkA.push(record);
          if (record.action === 'start' && nested.length === 0) {
            nested.push(b.callTool('create_item', { name: 'n' }, { requestId: 'b' }));
          }
        },
      },
    });
    expect((await a.callTool('create_item', { name: 'n' }, { requestId: 'a' })).isError).toBeUndefined();
    const fromInside = await nested[0]!;
    expect(fromInside.isError).toBe(true);
    expect(texts(fromInside).join(' ')).toMatch(/EXAMPLE_ENABLE_WRITES/);
    expect(fetchB).not.toHaveBeenCalled();
    expect(sinkA.every(r => r.requestId === 'a')).toBe(true);
  });

  it('do not let an instance with a policy, called from inside one without, use the environment', async () => {
    // A has no host policy and the environment allows writes. From inside A's upstream request, B (host
    // policy without writes) tries a write: refused. After B returns, A's own write still goes through.
    process.env.EXAMPLE_ENABLE_WRITES = 'true';
    const fetchB = routes();
    const b = createExampleGateway({ apiKey: KEY_B, baseUrl: BASE, fetchImpl: fetchB as unknown as typeof fetch, policy: {} });
    let fromInside: { isError?: boolean } | undefined;
    const fetchA = (async () => {
      fromInside = await b.callTool('create_item', { name: 'n' });
      return json({ id: 'new' });
    }) as unknown as typeof fetch;
    const a = createExampleGateway({ apiKey: KEY_A, baseUrl: BASE, fetchImpl: fetchA });
    expect((await a.callTool('create_item', { name: 'n' })).isError).toBeUndefined();
    expect(fromInside?.isError).toBe(true);
    expect(fetchB).not.toHaveBeenCalled();
  });

  it('validate a gateway created inside another instance against the environment, not against its policy', async () => {
    // A's policy disables nothing unknown; the environment names a tool that does not exist. A gateway without a host
    // policy, created inside A's sink or fetch, must fail on the environment as it would anywhere else.
    process.env.EXAMPLE_DISABLED_TOOLS = 'no_such_tool';
    const created: Array<{ where: string; error: unknown }> = [];
    const tryCreate = (where: string) => {
      try {
        createExampleGateway({ apiKey: KEY_B, baseUrl: BASE, fetchImpl: routes() as unknown as typeof fetch });
        created.push({ where, error: undefined });
      } catch (error) {
        created.push({ where, error });
      }
    };
    const fetchA = (async () => {
      tryCreate('fetch');
      return json({ id: 'i1' });
    }) as unknown as typeof fetch;
    const a = createExampleGateway({
      apiKey: KEY_A,
      baseUrl: BASE,
      fetchImpl: fetchA,
      policy: {
        audit: record => {
          if (record.action === 'start') tryCreate('sink');
        },
      },
    });
    expect((await a.callTool('get_item', { itemId: 'i1' })).isError).toBeUndefined();
    expect(created.map(c => c.where).sort()).toEqual(['fetch', 'sink']);
    for (const c of created) {
      expect(String(c.error), c.where).toMatch(/EXAMPLE_DISABLED_TOOLS names 1 unknown tool/);
    }
  });

  it('never send a write upstream when the start record is refused', async () => {
    const fetchImpl = routes();
    const gw = createExampleGateway({
      apiKey: KEY_A,
      baseUrl: BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      policy: {
        enableWrites: true,
        audit: record => {
          if (record.action === 'start') throw new Error('sink down');
        },
      },
    });
    expect((await gw.callTool('get_item', { itemId: 'i1' })).isError).toBeUndefined();
    const write = await gw.callTool('create_item', { name: 'n' });
    expect(write.isError).toBe(true);
    expect(fetchImpl.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toEqual([]);
  });

  it('name the host, not an environment variable, when a host policy refuses', async () => {
    const gw = createExampleGateway({
      apiKey: KEY_A,
      baseUrl: BASE,
      fetchImpl: routes() as unknown as typeof fetch,
      policy: { disabledTools: ['get_item'] },
    });
    const disabled = texts(await gw.callTool('get_item', { itemId: 'i1' })).join(' ');
    const write = texts(await gw.callTool('create_item', { name: 'n' })).join(' ');
    for (const text of [disabled, write]) {
      expect(text).not.toMatch(/EXAMPLE_/);
      expect(text).toMatch(/host/);
    }
  });
});
