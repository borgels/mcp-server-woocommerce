import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WooCommerceClient } from '../src/woocommerce/client.js';
import { createWooCommerceGateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';

export const SHOP = 'https://shop.example.com';
export const BASE = `${SHOP}/wp-json/wc/v3`;
/** A consumer secret for tests: random-looking, so it passes key admission. */
export const SECRET = 'Qz7xK2vN9pL4wR8mT3bY'; // gitleaks:allow

export type Stub = { status?: number; body?: unknown; raw?: string };

/** A fetch stub keyed by "METHOD URL" (URL without query string). Unknown routes answer 404. */
export function stubFetch(routes: Record<string, Stub>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).split('?')[0] ?? '';
    const stub = routes[`${init?.method ?? 'GET'} ${url}`];
    if (!stub) {
      return new Response(JSON.stringify({ message: `no stub for ${url}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (stub.raw !== undefined) {
      return new Response(stub.raw, { status: stub.status ?? 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify(stub.body), {
      status: stub.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

export function makeClient(fetchImpl: unknown) {
  return new WooCommerceClient({ consumerKey: 'test-api-key', consumerSecret: SECRET, shopUrl: SHOP, fetchImpl: fetchImpl as typeof fetch });
}

export async function connect(routes: Record<string, Stub> = {}) {
  const fetchImpl = stubFetch(routes);
  const server = createServer({ client: makeClient(fetchImpl) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return { mcpClient, fetchImpl };
}

export function gateway(routes: Record<string, Stub> = {}) {
  const fetchImpl = stubFetch(routes);
  const gw = createWooCommerceGateway({
    consumerKey: 'tttt-gggg-wwww-vvvv-1',
    consumerSecret: SECRET,
    shopUrl: SHOP,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { gw, fetchImpl };
}

export function texts(result: unknown): string[] {
  return (((result as { content?: unknown }).content ?? []) as Array<{ text: string }>).map(c => c.text);
}

export function auditLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}
