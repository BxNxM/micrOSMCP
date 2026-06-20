import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";

type McpToolDefinitionInput<Args> = {
  name?: string;
  title?: string;
  description?: string;
  _meta?: Record<string, unknown>;
  inputSchema: z.ZodRawShape;
  handler: (args: Args) => Promise<unknown>;
};

export type McpToolDefinition = Omit<McpToolDefinitionInput<unknown>, "handler" | "name" | "title"> & {
  name: string;
  title: string;
  description: string;
  handler: (args: unknown) => Promise<unknown>;
};

function toolNameFromModule(moduleUrl: string) {
  const modulePath = fileURLToPath(moduleUrl);
  return basename(modulePath, extname(modulePath)).replaceAll("-", "_");
}

function descriptionPathForModule(moduleUrl: string) {
  const modulePath = fileURLToPath(moduleUrl);
  const extension = extname(modulePath);
  return `${modulePath.slice(0, -extension.length)}.md`;
}

function loadDescription(moduleUrl: string) {
  const descriptionPath = descriptionPathForModule(moduleUrl);

  if (!existsSync(descriptionPath)) {
    throw new Error(`Missing MCP tool description file: ${descriptionPath}`);
  }

  const description = readFileSync(descriptionPath, "utf8").trim();

  if (!description) {
    throw new Error(`Empty MCP tool description file: ${descriptionPath}`);
  }

  return description;
}

function fallbackTitleFromName(name: string) {
  return name
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function defineTool<Args>(moduleUrl: string, definition: McpToolDefinitionInput<Args>): McpToolDefinition {
  const name = definition.name ?? toolNameFromModule(moduleUrl);
  const description = definition.description ?? loadDescription(moduleUrl);

  if (!description) {
    throw new Error(`Tool ${name} must provide a description.`);
  }

  return {
    ...definition,
    name,
    title: definition.title || fallbackTitleFromName(name),
    description,
    handler: (args: unknown) => definition.handler(args as Args)
  };
}

export function isMcpToolDefinition(value: unknown): value is McpToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string" &&
    "title" in value &&
    typeof value.title === "string" &&
    "description" in value &&
    typeof value.description === "string" &&
    "inputSchema" in value &&
    typeof value.inputSchema === "object" &&
    "handler" in value &&
    typeof value.handler === "function"
  );
}
