import { z } from "zod";
import {
  cacheToDevices,
  type Device,
  findDevices,
  mapWithConcurrency,
  MicrOSSocketClient,
  parseModuleHelp,
  parseModules,
  readDeviceCache,
  socketErrorMessage
} from "./common.js";
import { defineTool } from "./definition.js";

export type DiscoverCommandsInput = {
  deviceTag?: string;
  timeout?: number;
  password?: string;
  verbose?: boolean;
  concurrency?: number;
};

async function discoverDeviceCommands(
  device: Device,
  input: Pick<DiscoverCommandsInput, "timeout" | "password" | "verbose">
) {
  const client = new MicrOSSocketClient(device, input.timeout ?? 10, input.password, Boolean(input.verbose));

  try {
    await client.connect();
    const moduleLines = await client.sendCommand("modules");
    const modules = parseModules(moduleLines);
    const moduleDetails = [];
    const commands = [];

    for (const moduleName of modules) {
      const helpLines = await client.sendCommand(`${moduleName} help`);
      const functions = parseModuleHelp(helpLines);

      for (const fn of functions) {
        commands.push({
          module: moduleName,
          function: fn.name,
          parameters: fn.parameters,
          command: `${moduleName} ${fn.signature}`,
          signature: fn.signature
        });
      }

      moduleDetails.push({
        name: moduleName,
        helpCommand: `${moduleName} help`,
        rawHelp: helpLines,
        functions
      });
    }

    return {
      ok: true,
      device,
      modulesCommand: "modules",
      rawModules: moduleLines,
      modules: moduleDetails,
      commands
    };
  } catch (error) {
    return {
      ok: false,
      device,
      modulesCommand: "modules",
      error: socketErrorMessage(error)
    };
  } finally {
    client.close();
  }
}

export async function discoverCommands(input: DiscoverCommandsInput = {}) {
  const cache = await readDeviceCache();
  const deviceTag = input.deviceTag;
  const devices = findDevices(cacheToDevices(cache), deviceTag);

  if (deviceTag && devices.length === 0) {
    return {
      ok: false,
      deviceTag,
      error: `Unknown device: ${deviceTag}`,
      devices: []
    };
  }

  const results = await mapWithConcurrency(devices, input.concurrency ?? 3, (device) =>
    discoverDeviceCommands(device, input)
  );

  return {
    ok: results.every((result) => result.ok),
    deviceTag: deviceTag ?? null,
    count: results.length,
    devices: results
  };
}

export const discoverCommandsTool = defineTool<DiscoverCommandsInput>({
  name: "discover_commands",
  title: "Discover Commands",
  description:
    "Discover available micrOS modules and module functions by running modules, then <module> help, on all cached devices or one selected device.",
  inputSchema: {
    deviceTag: z
      .string()
      .optional()
      .describe(
        "Optional device UID, FUID, IP address, or partial device name. Omit to discover commands on all cached devices."
      ),
    timeout: z.number().int().positive().optional().describe("Socket timeout in seconds. Defaults to 10."),
    password: z.string().optional().describe("Optional micrOS app password if auth is enabled."),
    verbose: z.boolean().optional().describe("Enable verbose micrOS client logging."),
    concurrency: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .describe("Maximum devices to inspect in parallel when deviceTag is omitted. Defaults to 3.")
  },
  handler: discoverCommands
});
