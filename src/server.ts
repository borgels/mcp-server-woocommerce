import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ExampleClient, type ExampleClientOptions } from './example/client.js';
import { registerTools } from './tools/example.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: ExampleClient;
  clientOptions?: ExampleClientOptions;
}

let defaultClient: ExampleClient | undefined;

/**
 * Process-wide client built from the environment. Sharing it means the
 * outbound concurrency limit applies across all sessions, also when a server
 * instance is created per HTTP request.
 */
export function getDefaultClient(): ExampleClient {
  defaultClient ??= new ExampleClient();
  return defaultClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'example',
    version: PACKAGE_VERSION,
  });

  const client =
    options.client ?? (options.clientOptions ? new ExampleClient(options.clientOptions) : getDefaultClient());
  registerTools(server, client);

  return server;
}
