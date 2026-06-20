import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpToolDefinition } from "./tool-definition.js";
import { loadToolDefinitions } from "./tool-loader.js";

function textResult(value: unknown, isError = false) {
  return {
    isError,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function isToolError(result: unknown) {
  return typeof result === "object" && result !== null && "ok" in result && result.ok === false;
}

function registerMcpTool(server: McpServer, tool: McpToolDefinition) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      _meta: tool._meta
    },
    async (args) => {
      const result = await tool.handler(args);
      return textResult(result, isToolError(result));
    }
  );
}

export async function registerMcpTools(server: McpServer) {
  for (const tool of await loadToolDefinitions()) {
    registerMcpTool(server, tool);
  }
}
