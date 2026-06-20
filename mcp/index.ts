#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initializeMicrOSStateSafely } from "./initialize.js";
import { loadMcpInstructions } from "./metadata.js";
import { registerMcpTools } from "./mcp-tools.js";

const server = new McpServer(
  {
    name: "microsmcp",
    version: "1.1.0"
  },
  {
    instructions: await loadMcpInstructions()
  }
);

await registerMcpTools(server);

const initialization = await initializeMicrOSStateSafely({
  log: (message) => console.error(message)
});
console.error(`[micrOSMCP] initialization: ready ${JSON.stringify(initialization)}`);

const transport = new StdioServerTransport();
await server.connect(transport);
