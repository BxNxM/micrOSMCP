import { z } from "zod";
import { discoverAndSaveDevices, type DiscoverDevicesOptions } from "./common.js";
import { defineTool } from "./definition.js";

export type DiscoverDevicesInput = DiscoverDevicesOptions;

export async function discoverDevices(input: DiscoverDevicesInput = {}) {
  return discoverAndSaveDevices(input);
}

export const discoverDevicesTool = defineTool<DiscoverDevicesInput>({
  name: "discover_devices",
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
    concurrency: z.number().int().positive().max(254).optional().describe("Parallel connection checks. Defaults to 50."),
    timeoutMs: z.number().int().positive().optional().describe("Per-host socket timeout in milliseconds. Defaults to 1000.")
  },
  handler: discoverDevices
});
