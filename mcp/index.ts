#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeMicrOSStateSafely } from "./initialize.js";
import { registerMicrOSTools } from "./mcp-tools.js";

const server = new McpServer({
  name: "microsmcp",
  version: "0.1.0"
});

registerMicrOSTools(server);

const initialization = await initializeMicrOSStateSafely({
  log: (message) => console.error(message)
});
console.error(`[micrOSMCP] initialization: ready ${JSON.stringify(initialization)}`);

const transport = new StdioServerTransport();
await server.connect(transport);
