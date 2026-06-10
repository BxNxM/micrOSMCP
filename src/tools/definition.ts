import type { z } from "zod";

type MicrOSToolDefinitionInput<Args> = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Args) => Promise<unknown>;
};

export type MicrOSToolDefinition = Omit<MicrOSToolDefinitionInput<unknown>, "handler"> & {
  handler: (args: unknown) => Promise<unknown>;
};

export function defineTool<Args>(definition: MicrOSToolDefinitionInput<Args>): MicrOSToolDefinition {
  return {
    ...definition,
    handler: (args: unknown) => definition.handler(args as Args)
  };
}
