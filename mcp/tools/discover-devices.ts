import { z } from "zod";
import { discoverAndSaveDevices, type DiscoverDevicesOptions } from "./common.js";
import type { DeviceCommandDiscoveryResult } from "./discover-commands.js";
import { discoverCommandsForDevices } from "./discover-commands.js";
import { defineTool } from "../tool-definition.js";

export type DiscoverDevicesInput = DiscoverDevicesOptions & {
  refreshFeatures?: boolean;
  featureTimeout?: number;
  featureConcurrency?: number;
  password?: string;
  verbose?: boolean;
};

export async function discoverDevices(input: DiscoverDevicesInput = {}) {
  const discovery = await discoverAndSaveDevices(input);

  if (input.refreshFeatures === false) {
    return {
      ...discovery,
      featureDiscovery: {
        skipped: true,
        reason: "refreshFeatures=false"
      }
    };
  }

  const deviceResults = await discoverCommandsForDevices(discovery.discovered, {
    timeout: input.featureTimeout ?? 3,
    concurrency: input.featureConcurrency ?? 3,
    password: input.password,
    verbose: input.verbose
  });

  return {
    ...discovery,
    featureDiscovery: {
      ok: deviceResults.every((device) => device.ok),
      count: deviceResults.length,
      discovered: deviceResults.filter((device) => device.ok).length,
      devices: deviceResults.map(compactFeatureDiscoveryResult)
    }
  };
}

function compactFeatureDiscoveryResult(result: DeviceCommandDiscoveryResult) {
  if (!result.ok) {
    return {
      ok: false,
      device: result.device,
      error: result.error
    };
  }

  return {
    ok: true,
    device: result.device,
    discoveredAt: result.discoveredAt,
    moduleCount: result.modules.length,
    commandCount: result.commands.length,
    modules: result.modules.map((module) => module.name)
  };
}

export const discoverDevicesTool = defineTool<DiscoverDevicesInput>(import.meta.url, {
  inputSchema: {
    port: z.number().int().positive().optional().describe("micrOS service port. Defaults to 9008."),
    networkPrefix: z
      .string()
      .regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/)
      .optional()
      .describe("IPv4 /24 prefix to scan, such as 10.0.1. Defaults to the active local network."),
    startHost: z.number().int().min(1).max(254).optional().describe("First host number to scan. Defaults to 2."),
    endHost: z.number().int().min(1).max(254).optional().describe("Last host number to scan. Defaults to 254."),
    concurrency: z.number().int().positive().max(254).optional().describe("Parallel connection checks. Defaults to 50."),
    timeoutMs: z.number().int().positive().optional().describe("Per-host socket timeout in milliseconds. Defaults to 1000."),
    refreshFeatures: z
      .boolean()
      .optional()
      .describe("Refresh module/function feature cache for newly discovered devices. Defaults to true."),
    featureTimeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Socket timeout in seconds for feature discovery after devices are found. Defaults to 3."),
    featureConcurrency: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .describe("Maximum discovered devices to inspect in parallel while refreshing features. Defaults to 3."),
    password: z.string().optional().describe("Optional micrOS app password for feature discovery if auth is enabled."),
    verbose: z.boolean().optional().describe("Enable verbose micrOS client logging during feature discovery.")
  },
  handler: discoverDevices
});
