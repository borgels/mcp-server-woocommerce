// One property, proved through every channel at once: no piece of an instance's key (six characters or more)
// reaches a host result, a thrown error or an audit record. The key has a quote and a backslash, so a form
// that is serialised before it is redacted would show; the upstream echoes the key whole, in fragments, in
// keys, in error bodies and codes, in a redirect's Location and in an over-limit body; the environment holds
// it where a number or a switch was expected.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FRAGMENT_LENGTH, MAX_REDACT_DEPTH, redactDeep, SecretRedactor } from '../src/errors.js';
import { createExampleGateway, type GatewayToolResult } from '../src/gateway.js';
import { BASE, gateway } from './helpers.js';

const KEY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const FRAGMENT = KEY.slice(0, 12);
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('EXAMPLE_')) delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/** Every string in a value, object keys included. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(entry => strings(entry, out));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.push(key);
      strings(entry, out);
    }
  }
  return out;
}

/** The pieces of the key that are found anywhere in `value`, raw or serialised. */
function leaks(value: unknown): string[] {
  const texts = [...strings(value), JSON.stringify(value) ?? ''];
  const found = new Set<string>();
  for (let i = 0; i + FRAGMENT_LENGTH <= KEY.length; i += 1) {
    const piece = KEY.slice(i, i + FRAGMENT_LENGTH);
    if (texts.some(text => text.includes(piece))) found.add(piece);
  }
  return [...found];
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** The upstream: each item id answers through one channel. */
const upstream: typeof fetch = async (input, init) => {
  const url = String(input).split('?')[0] ?? '';
  const path = url.slice(BASE.length);
  if (init?.method === 'POST') return json({ id: 'new', echo: KEY, [KEY]: FRAGMENT }, 201);
  switch (path) {
    case '/items/echo':
      return json({ name: KEY, fragment: FRAGMENT, [KEY]: 1, [`k ${FRAGMENT}`]: { deeper: [FRAGMENT, KEY] } });
    case '/items/error':
      return json({ message: `Rejected ${KEY}`, code: FRAGMENT, details: { [KEY]: FRAGMENT } }, 400);
    case '/items/unauthorised':
      return json({ code: FRAGMENT, error: FRAGMENT }, 401);
    case '/items/big-error':
      return new Response(`${' '.repeat(70_000)}${KEY}`, { status: 500, headers: { 'content-type': 'text/plain' } });
    case '/items/big':
      return new Response(`"${' '.repeat(2_000)}${KEY}"`, { status: 200, headers: { 'content-type': 'application/json' } });
    case '/items/redirect':
      return new Response(null, { status: 302, headers: { location: `https://elsewhere.test/${FRAGMENT}?k=${KEY}` } });
    case '/items/network':
      throw new TypeError(`fetch failed for ${KEY}`, { cause: Object.assign(new Error(`connect ${FRAGMENT}`), { code: FRAGMENT }) });
    case '/items/combined':
      return json({ name: 'ok' });
    case '/items/combined/history':
      return json({ message: `history rejected ${FRAGMENT}`, code: FRAGMENT }, 401);
    case '/items/combined-redirect':
      return json({ name: 'ok' });
    case '/items/combined-redirect/history':
      return new Response(null, { status: 307, headers: { location: `/${FRAGMENT}` } });
    default:
      return json({ message: `no stub ${KEY}` }, 404);
  }
};

describe('no piece of the key leaves an instance', () => {
  it('holds for every channel: results, errors, nested failures and audit records', async () => {
    const records: unknown[] = [];
    const gw = createExampleGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: upstream,
      maxAttempts: 1,
      maxResponseBytes: 1_000,
      policy: { enableWrites: true, audit: record => void records.push(record) },
    });
    const results: GatewayToolResult[] = [];
    for (const itemId of ['echo', 'error', 'unauthorised', 'big-error', 'big', 'redirect', 'network', 'missing']) {
      results.push(await gw.callTool('get_item', { itemId }, { caller: `caller ${KEY}`, requestId: FRAGMENT }));
    }
    const combined = await gw.callTool('get_item', { itemId: 'combined', includeHistory: true });
    const redirected = await gw.callTool('get_item', { itemId: 'combined-redirect', includeHistory: true });
    results.push(combined, redirected, await gw.callTool('create_item', { name: KEY }));
    results.push(await gw.callTool(`get_item ${KEY}`, {}), await gw.callTool('get_item', { itemId: 'x', [KEY]: FRAGMENT }));

    expect(results[0]?.isError).toBeUndefined();
    expect(combined.structuredContent).toMatchObject({ history: { error: 'Example API request failed with HTTP 401' } });
    expect(redirected.structuredContent).toMatchObject({ history: { error: 'Example API request failed.' } });
    expect(records.length).toBeGreaterThan(10);
    expect(leaks(results)).toEqual([]);
    expect(leaks(records)).toEqual([]);
  });

  it('holds for errors about the environment, with or without an instance', async () => {
    const answers: unknown[] = [];
    for (const name of ['EXAMPLE_ENABLE_WRITES', 'EXAMPLE_DISABLED_TOOLS', 'EXAMPLE_TIMEOUT_MS', 'EXAMPLE_MAX_CONCURRENCY', 'EXAMPLE_MAX_RESPONSE_BYTES']) {
      process.env[name] = KEY;
      try {
        // Without a host policy the environment applies: the bad value fails at creation or at the call.
        const gw = createExampleGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: upstream });
        answers.push(await gw.callTool('create_item', { name: 'x' }));
      } catch (error) {
        answers.push((error as Error).message);
      }
      delete process.env[name];
    }
    expect(answers.filter(answer => typeof answer === 'string' || (answer as GatewayToolResult).isError)).toHaveLength(5);
    expect(leaks(answers)).toEqual([]);
  });
});

describe('redactDeep', () => {
  it('replaces anything deeper than its limit, strings at the limit included, and redacts what is above it', () => {
    const redactor = new SecretRedactor().addSecret(KEY);
    let value: unknown = KEY;
    for (let i = 0; i < MAX_REDACT_DEPTH; i += 1) value = [value];
    // The string sits at depth MAX_REDACT_DEPTH: redacted, not replaced.
    expect(JSON.stringify(redactDeep(value, redactor))).toContain('‹redacted›');
    expect(JSON.stringify(redactDeep([value], redactor))).toContain('[nested too deep]');
    expect(leaks(redactDeep([value], redactor))).toEqual([]);
  });
});

describe('the data in the text block', () => {
  it('carries the redacted structured content as compact JSON after the summary', async () => {
    const gw = createExampleGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: upstream, maxAttempts: 1 });
    const result = await gw.callTool('get_item', { itemId: 'echo' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const [summary, data, ...rest] = result.content[0]!.text.split('\n\n');
    expect(summary).not.toBe('');
    expect(summary).not.toContain('{');
    expect(rest).toEqual([]);
    expect(data).toBe(JSON.stringify(result.structuredContent));
    expect(data).not.toContain('\n');
    expect(data).toContain('‹redacted›');
    expect(leaks(result)).toEqual([]);
  });

  it('gives a client that reads only the text the data', async () => {
    const { gw } = gateway({ [`GET ${BASE}/items/7`]: { body: { id: '7', name: 'Testvare Blå' } } });
    const result = await gw.callTool('get_item', { itemId: '7' });
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    expect(result.content[0]!.text).toContain('"name":"Testvare Blå"');
    expect(result.content[0]!.text.endsWith(JSON.stringify(result.structuredContent))).toBe(true);
  });

  it('leaves error results with their text only', async () => {
    const gw = createExampleGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: upstream, maxAttempts: 1 });
    const result = await gw.callTool('get_item', { itemId: 'error' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]!.text).not.toContain('\n\n{');
  });
});
