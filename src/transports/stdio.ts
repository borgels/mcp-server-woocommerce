#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { validateStartupConfig } from '../tools/example.js';
import { createServer, getDefaultClient } from '../server.js';

async function main(): Promise<void> {
  try {
    // Fail at startup on invalid configuration instead of on the first call.
    getDefaultClient();
    validateStartupConfig();
  } catch (error) {
    console.error(`Example MCP server not started: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
