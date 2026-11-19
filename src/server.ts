import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WooCommerceClient, type WooCommerceClientOptions } from './woocommerce/client.js';
import { registerTools } from './tools/woocommerce.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: WooCommerceClient;
  clientOptions?: WooCommerceClientOptions;
}

let defaultClient: WooCommerceClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): WooCommerceClient {
  defaultClient ??= new WooCommerceClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'woocommerce',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new WooCommerceClient(options.clientOptions) : getDefaultClient());
  registerTools(server, client);

  return server;
}
