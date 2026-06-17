import { readdir } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMcpToolDefinition, type McpToolDefinition } from "./tool-definition.js";

const skippedToolModules = new Set(["common"]);

function sortTools(tools: McpToolDefinition[]) {
  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

function exportedToolDefinitions(moduleExports: Record<string, unknown>) {
  return Object.values(moduleExports).filter(isMcpToolDefinition);
}

export async function loadToolDefinitions(toolsDirUrl = new URL("./tools/", import.meta.url)) {
  const toolsDir = fileURLToPath(toolsDirUrl);
  const moduleExtension = extname(fileURLToPath(import.meta.url));
  const entries = await readdir(toolsDir, { withFileTypes: true });
  const toolFiles = entries
    .filter((entry) => {
      const baseName = basename(entry.name, moduleExtension);
      return (
        entry.isFile() &&
        entry.name.endsWith(moduleExtension) &&
        !entry.name.endsWith(".d.ts") &&
        !skippedToolModules.has(baseName)
      );
    })
    .map((entry) => entry.name)
    .sort();
  const tools: McpToolDefinition[] = [];

  for (const toolFile of toolFiles) {
    const moduleUrl = pathToFileURL(`${toolsDir}/${toolFile}`).href;
    const moduleExports = (await import(moduleUrl)) as Record<string, unknown>;
    const definitions = exportedToolDefinitions(moduleExports);

    if (definitions.length === 0) {
      continue;
    }

    tools.push(...definitions);
  }

  const names = new Set<string>();

  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate MCP tool name: ${tool.name}`);
    }

    names.add(tool.name);
  }

  return sortTools(tools);
}
