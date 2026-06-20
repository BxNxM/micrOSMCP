import { z } from "zod";
import {
  cacheToDevices,
  type CachedDeviceFeatures,
  type DiscoveredModule,
  type Device,
  findDevices,
  mapWithConcurrency,
  MicrOSSocketClient,
  parseModuleHelp,
  parseModules,
  readDeviceCache,
  readDeviceFeatureCache,
  saveDeviceFeatureCache,
  socketErrorMessage
} from "./common.js";
import { defineTool } from "../tool-definition.js";
import { documentModules } from "../function-docs.js";

export type DiscoverCommandsInput = {
  deviceTag?: string;
  timeout?: number;
  password?: string;
  verbose?: boolean;
  concurrency?: number;
};

export type DeviceCommandDiscoverySuccess = Omit<CachedDeviceFeatures, "deviceNote"> & {
  ok: true;
  device: Device;
};

export type DeviceCommandDiscoveryFailure = {
  ok: false;
  device: Device;
  error: string;
};

export type DeviceCommandDiscoveryResult = DeviceCommandDiscoverySuccess | DeviceCommandDiscoveryFailure;

async function discoverDeviceCommands(
  device: Device,
  input: Pick<DiscoverCommandsInput, "timeout" | "password" | "verbose">
): Promise<DeviceCommandDiscoveryResult> {
  const client = new MicrOSSocketClient(device, input.timeout ?? 10, input.password, Boolean(input.verbose));

  try {
    await client.connect();
    const moduleLines = await client.sendCommand("modules");
    const modules = parseModules(moduleLines);
    const moduleDetails: DiscoveredModule[] = [];

    for (const moduleName of modules) {
      const helpLines = await client.sendCommand(`${moduleName} help >json`);
      const functions = parseModuleHelp(helpLines);

      moduleDetails.push({
        name: moduleName,
        functions
      });
    }

    return {
      ok: true,
      device,
      discoveredAt: new Date().toISOString(),
      modules: moduleDetails
    };
  } catch (error) {
    return {
      ok: false,
      device,
      error: socketErrorMessage(error)
    };
  } finally {
    client.close();
  }
}

export async function saveSuccessfulFeatureDiscoveries(results: DeviceCommandDiscoveryResult[]) {
  const cache = await readDeviceFeatureCache();
  let changed = false;

  for (const result of results) {
    if (!result.ok) {
      continue;
    }

    const existingNote = cache[result.device.uid]?.deviceNote ?? "";
    cache[result.device.uid] = {
      deviceNote: existingNote,
      discoveredAt: result.discoveredAt,
      modules: result.modules
    };
    changed = true;
  }

  if (changed) {
    await saveDeviceFeatureCache(cache);
  }
}

export async function discoverCommandsForDevices(devices: Device[], input: DiscoverCommandsInput = {}) {
  const featureCache = await readDeviceFeatureCache();
  const devicesWithNotes = devices.map((device) => ({
    ...device,
    deviceNote: featureCache[device.uid]?.deviceNote ?? device.deviceNote ?? ""
  }));
  const results = await mapWithConcurrency(devicesWithNotes, input.concurrency ?? 3, (device) =>
    discoverDeviceCommands(device, input)
  );
  await saveSuccessfulFeatureDiscoveries(results);
  return results;
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

  const results = await discoverCommandsForDevices(devices, input);
  const responseResults = await Promise.all(
    results.map(async (result) =>
      result.ok
        ? {
            ...result,
            modules: await documentModules(result.modules)
          }
        : result
    )
  );

  return {
    ok: results.every((result) => result.ok),
    deviceTag: deviceTag ?? null,
    count: results.length,
    devices: responseResults
  };
}

export const discoverCommandsTool = defineTool<DiscoverCommandsInput>(import.meta.url, {
  inputSchema: {
    deviceTag: z
      .string()
      .optional()
      .describe(
        "Optional device UID, IP address, or partial device name. Omit to inspect all cached devices."
      ),
    timeout: z.number().int().positive().default(10).describe("Socket timeout in seconds. Defaults to 10."),
    password: z.string().optional().describe("Optional micrOS app password if auth is enabled."),
    verbose: z.boolean().optional().describe("Enable verbose micrOS client logging."),
    concurrency: z
      .number()
      .int()
      .positive()
      .max(20)
      .default(3)
      .describe("Maximum devices to inspect in parallel when deviceTag is omitted. Defaults to 3.")
  },
  handler: discoverCommands
});
