import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ExampleClient } from '../src/example/client.js';
import { createExampleGateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';

export const BASE = 'https://api.vendor.test/v1';

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
  return new ExampleClient({ apiKey: 'test-api-key', baseUrl: BASE, fetchImpl: fetchImpl as typeof fetch });
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
  const gw = createExampleGateway({
    apiKey: 'tttt-gggg-wwww-vvvv-1',
    baseUrl: BASE,
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
