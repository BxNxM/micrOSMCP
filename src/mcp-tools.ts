import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolDefinitions, type MicrOSToolDefinition } from "./tools.js";

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

function registerMicrOSTool(server: McpServer, tool: MicrOSToolDefinition) {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema
    },
    async (args) => {
      const result = await tool.handler(args);
      return textResult(result, isToolError(result));
    }
  );
}

export function registerMicrOSTools(server: McpServer) {
  for (const tool of toolDefinitions) {
    registerMicrOSTool(server, tool);
  }
}
