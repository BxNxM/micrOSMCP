import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { discoverCommands, discoverDevices, filterDevices, listDevices, runCommand } from "./tools.js";

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

export function registerMicrOSTools(server: McpServer) {
  server.registerTool(
    "list_devices",
    {
      title: "List Devices",
      description: "Return devices from the micrOS device cache.",
      inputSchema: {}
    },
    async () => textResult(await listDevices())
  );

  server.registerTool(
    "filter_devices",
    {
      title: "Filter Devices",
      description: "Filter cached micrOS devices by UID, FUID, IP address, or port.",
      inputSchema: {
        query: z.string().min(1).describe("Text to filter across cached micrOS device fields."),
        status: z.enum(["online", "offline"]).optional().describe("Optional live status filter."),
        includeStatus: z.boolean().optional().describe("Check live online/offline status for matched devices.")
      }
    },
    async ({ query, status, includeStatus }) => textResult(await filterDevices({ query, status, includeStatus }))
  );

  server.registerTool(
    "discover_devices",
    {
      title: "Discover Devices",
      description: "Scan the local network for micrOS devices and update the project-local device cache.",
      inputSchema: {
        port: z.number().int().positive().optional().describe("micrOS service port. Defaults to 9008."),
        networkPrefix: z
          .string()
          .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/)
          .optional()
          .describe("IPv4 /24 prefix to scan, such as 10.0.1. Defaults to the active local network."),
        startHost: z.number().int().min(1).max(254).optional().describe("First host number to scan. Defaults to 2."),
        endHost: z.number().int().min(1).max(254).optional().describe("Last host number to scan. Defaults to 254."),
        concurrency: z
          .number()
          .int()
          .positive()
          .max(254)
          .optional()
          .describe("Parallel connection checks. Defaults to 50."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Per-host socket timeout in milliseconds. Defaults to 1000.")
      }
    },
    async ({ port, networkPrefix, startHost, endHost, concurrency, timeoutMs }) =>
      textResult(await discoverDevices({ port, networkPrefix, startHost, endHost, concurrency, timeoutMs }))
  );

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description: "Run a real micrOS command pipeline on a selected device.",
      inputSchema: {
        deviceTag: z.string().describe("The micrOS device UID, FUID, or IP address to target."),
        command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe(
          "The command or command pipeline to run. String commands may use the <a> separator."
        ),
        separator: z.string().optional().describe("Optional string command separator. Defaults to <a>."),
        timeout: z.number().int().positive().optional().describe("Socket timeout in seconds. Defaults to 10."),
        password: z.string().optional().describe("Optional micrOS app password if auth is enabled."),
        verbose: z.boolean().optional().describe("Enable verbose micrOS client logging.")
      }
    },
    async ({ deviceTag, command, separator, timeout, password, verbose }) => {
      const result = await runCommand({ deviceTag, command, separator, timeout, password, verbose });
      return textResult(result, isToolError(result));
    }
  );

  server.registerTool(
    "discover_commands",
    {
      title: "Discover Commands",
      description:
        "Discover available micrOS modules and module functions by running modules, then <module> help, on all cached devices or one selected device.",
      inputSchema: {
        deviceName: z
          .string()
          .optional()
          .describe(
            "Optional device UID, FUID, IP address, or partial device name. Omit to discover commands on all cached devices."
          ),
        deviceTag: z
          .string()
          .optional()
          .describe("Alias for deviceName. The micrOS device UID, FUID, or IP address to target."),
        timeout: z.number().int().positive().optional().describe("Socket timeout in seconds. Defaults to 10."),
        password: z.string().optional().describe("Optional micrOS app password if auth is enabled."),
        verbose: z.boolean().optional().describe("Enable verbose micrOS client logging."),
        concurrency: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe("Maximum devices to inspect in parallel when deviceName is omitted. Defaults to 3.")
      }
    },
    async ({ deviceName, deviceTag, timeout, password, verbose, concurrency }) => {
      const result = await discoverCommands({ deviceName, deviceTag, timeout, password, verbose, concurrency });
      return textResult(result, isToolError(result));
    }
  );
}
