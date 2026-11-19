import { nestedFailuresAsStatus, nestedFailureText } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { UpstreamClient } from './client.js';

/**
 * Upstream API calls. Keep these thin: build the path from validated input,
 * call the client, return the response. Every caller-supplied path segment
 * goes through encodePathParam.
 */

export async function getItem(
  client: UpstreamClient,
  input: { itemId: string; includeHistory?: boolean },
): Promise<unknown> {
  const path = `/items/${encodePathParam(input.itemId, 'itemId')}`;
  // Failures the API reports inside a successful body (`metadata.error`, `failures[].error`) become status-only text.
  const item = nestedFailuresAsStatus(await client.get(path));
  if (!input.includeHistory) {
    return item;
  }
  // A combined read: the item is returned even when its history cannot be read. The failure is kept as
  // nestedFailureText (the status, or a fixed text), never as the error's message.
  const history = await client
    .get(`${path}/history`)
    .then(nestedFailuresAsStatus, (error: unknown) => ({ error: nestedFailureText(error) }));
  return { item, history };
}

export async function createItem(
  client: UpstreamClient,
  input: { name: string; description?: string },
): Promise<unknown> {
  return nestedFailuresAsStatus(await client.post('/items', { name: input.name, description: input.description }));
}
