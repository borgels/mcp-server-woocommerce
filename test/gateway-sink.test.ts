// The sink check (README, "Threat model"): nothing that leaves a gateway holds a piece of 6 characters of the key.
// Every output is checked in its final form; the round-7 counterexamples and keys spliced from real outputs.
import { describe, expect, it } from 'vitest';
import { createWooCommerceGateway } from '../src/gateway.js';
import { visibleTexts } from '../src/key-admission.js';
import { BASE, SECRET, SHOP } from './helpers.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A vendor-like value that our texts do not share. */
const PLAIN = 'Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU';

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

/** The pieces of the key found in any text a host or a log could see. */
function leaked(key: string, outputs: unknown[]): string[] {
  const texts = outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)));
  return pieces(key).filter(piece => texts.some(text => text.includes(piece)));
}

const upstream: typeof fetch = async input => {
  const path = (String(input).split('?')[0] ?? '').slice(BASE.length);
  if (path === '/customers/12') return json({ id: 'i1', name: 'Item one', status: 'open', riskLevel: 'low' });
  if (path === '/contacts') return json({ id: 'i2', name: 'n' }, 201);
  return json({ message: 'no stub' }, 404);
};

/** Every output of a normal session with this key, or the refusal when the key is not admitted. */
async function outputs(accessToken: string): Promise<{ refused?: string; outputs: unknown[] }> {
  const records: unknown[] = [];
  let gw: ReturnType<typeof createWooCommerceGateway>;
  try {
    gw = createWooCommerceGateway({
      consumerKey: accessToken,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      fetchImpl: upstream,
      maxAttempts: 1,
      policy: { enableWrites: true, audit: record => void records.push(record) },
    });
  } catch (error) {
    return { refused: (error as Error).message, outputs: [(error as Error).message, (error as Error).name] };
  }
  const results = [
    await gw.callTool('get_customer', { customerId: 12 }, { caller: 'person-1', requestId: 'r1' }),
    await gw.callTool('add_order_note', { orderId: 1, note: 'n' }, { caller: 'person-1', requestId: 'r2' }),
    await gw.callTool('get_customer', { customerId: 8 }),
    await gw.callTool('no_such_tool', {}),
    await gw.callTool('get_customer', { unknown: 1 }),
  ];
  return { outputs: [gw.tools, ...results, ...records] };
}

describe('the sink check', () => {
  it('holds for the round-7 counterexamples', async () => {
    for (const accessToken of [
      'riskLevelQz7pX2vK9mWb',
      'Zq7pX2visError9mWb4TnR',
      'qz7":"staV8k2mP9',
      'Zq7pX2-kind,p-Wb4TnR',
      'x"ok":y-0123456789',
      'URI malformedQz7pX2vK9mWb\uD800',
    ]) {
      const { refused, outputs: seen } = await outputs(accessToken);
      if (refused !== undefined) expect(refused, accessToken).toMatch(/key was refused/);
      expect(leaked(accessToken, seen), accessToken).toEqual([]);
    }
  });

  it('refuses a key that is not printable ASCII before anything is built from it', () => {
    for (const accessToken of ['URI malformedQz7pX2vK9mWb\uD800', 'Zq7pX2vK9mWb4TnRé', 'Zq7pX2 vK9mWb4TnR8y']) {
      expect(() => createWooCommerceGateway({ consumerKey: accessToken, consumerSecret: SECRET, shopUrl: SHOP }), accessToken).toThrow(/key was refused/);
    }
  });

  it('refuses a key that shares a piece with the tool list', () => {
    expect(() => createWooCommerceGateway({ consumerKey: 'riskLevelQz7pX2vK9mWb', consumerSecret: SECRET, shopUrl: SHOP })).toThrow(/key was refused/);
  });

  it('holds for keys spliced from the outputs of a normal session', async () => {
    const base = await outputs('Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU');
    expect(base.refused).toBeUndefined();
    const texts = base.outputs.flatMap(output => visibleTexts(output)).filter(text => text.length >= 6);
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const filler = (n: number) => Array.from({ length: n }, () => String.fromCharCode(0x30 + random(43))).join('');
    let admitted = 0;
    for (let round = 0; round < 60; round += 1) {
      const text = texts[random(texts.length)]!;
      const start = random(text.length - 5);
      const window = text.slice(start, start + 6);
      if (!/^[\x21-\x7E]{6}$/.test(window)) continue;
      const accessToken = `${filler(6)}${window}${filler(6)}`;
      const { refused, outputs: seen } = await outputs(accessToken);
      if (refused === undefined) admitted += 1;
      expect(leaked(accessToken, seen), accessToken).toEqual([]);
    }
    expect(admitted).toBeGreaterThan(0);
  });
});

/** The body as the name of a contact: what get_customer and add_order_note pass on unchanged. */
const asContact =
  (body: unknown): typeof fetch =>
  async (_input, init) =>
    init?.method === 'POST' ? json({ id: 2, note: body }, 201) : json({ id: 11, first_name: body });

describe('failure texts', () => {
  it('replaces texts in failure lists of a successful answer, for reads and writes', async () => {
    const gw = createWooCommerceGateway({
      consumerKey: PLAIN,
      consumerSecret: SECRET,
      shopUrl: SHOP,
      maxAttempts: 1,
      policy: { enableWrites: true },
      fetchImpl: asContact({ data: { failures: ['Vendor diagnostic'], errors: ['Vendor diagnostic'] } }),
    });
    for (const [field, result] of [
      ['first_name', await gw.callTool('get_customer', { customerId: 11 })],
      ['note', await gw.callTool('add_order_note', { orderId: 1, note: 'n' })],
    ] as const) {
      expect(JSON.stringify(result)).not.toContain('Vendor');
      expect(result.structuredContent).toMatchObject({
        [field]: { data: { failures: [{ message: 'WooCommerce API request failed.' }], errors: [{ message: 'WooCommerce API request failed.' }] } },
      });
    }
  });
});

describe('round 8', () => {
  it('throws construction errors in final form: no frames or paths in the stack, no cause', () => {
    for (const [accessToken, baseUrl] of [
      ['scratchpadQz7pX2vK9mWb', 'https://10.0.0.1/shop'],
      ['scratchpadQz7pX2vK9mWb', 'bad'],
      ['Zq7pX2-node:i-Wb4TnR', 'bad'],
      ['short', 'bad'],
    ] as const) {
      let caught: Error | undefined;
      try {
        createWooCommerceGateway({ consumerKey: accessToken, consumerSecret: SECRET, shopUrl: baseUrl });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, accessToken).toBeInstanceOf(Error);
      const stack = String(caught!.stack);
      expect(stack).toBe(`${caught!.name}: ${caught!.message}`);
      expect(stack).not.toMatch(/\n\s+at /);
      expect((caught as { cause?: unknown }).cause).toBeUndefined();
      expect(leaked(accessToken, [stack, caught!.message, caught!.name, caught])).toEqual([]);
    }
  });

  it('reduces every element of a failure list, whatever its fields, also below a wrapper', async () => {
    for (const body of [
      { data: { failures: [{ reason: 'Vendor diagnostic' }], errors: [{ code: 'Vendor diagnostic' }] } },
      { failures: [{ code: 'Vendor diagnostic' }] },
    ]) {
      const gw = createWooCommerceGateway({
        consumerKey: PLAIN,
        consumerSecret: SECRET,
        shopUrl: SHOP,
        maxAttempts: 1,
        policy: { enableWrites: true },
        fetchImpl: asContact(body),
      });
      for (const result of [await gw.callTool('get_customer', { customerId: 11 }), await gw.callTool('add_order_note', { orderId: 1, note: 'n' })]) {
        expect(JSON.stringify(result)).not.toContain('Vendor');
        expect(JSON.stringify(result.structuredContent)).toContain('"message":"WooCommerce API request failed."');
      }
    }
  });

  it('quotes no configured address in network, timeout or redirect errors', async () => {
    const ADDRESS = 'https://shop.vendor-name.example';
    for (const fetchImpl of [
      async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
      },
      async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } }),
    ] as Array<typeof fetch>) {
      const gw = createWooCommerceGateway({ consumerKey: PLAIN, consumerSecret: SECRET, shopUrl: ADDRESS, maxAttempts: 1, fetchImpl });
      const result = await gw.callTool('get_customer', { customerId: 11 });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('vendor-name');
    }
  });
});
