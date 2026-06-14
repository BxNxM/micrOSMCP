import { z } from "zod";
import {
  type Device,
  deviceIdentityFields,
  deviceSearchFields,
  deviceFeatureCachePath,
  fieldsMatchQuery,
  type DeviceStatus,
  nodeIsOnline,
  pruneDeviceFeaturesForQuery,
  readCachedDevicesWithFeatures
} from "./common.js";
import { defineTool } from "./definition.js";

export type FilterDevicesInput = {
  query: string;
  status?: DeviceStatus;
  includeStatus?: boolean;
};

export async function filterDevices(input: FilterDevicesInput) {
  const { devices } = await readCachedDevicesWithFeatures();
  const query = input.query.trim().toLowerCase();
  const includeStatus = Boolean(input.includeStatus) || input.status !== undefined;
  const matches: Device[] = [];

  for (const device of devices) {
    if (query && !fieldsMatchQuery(deviceSearchFields(device), query)) {
      continue;
    }

    const outputDevice = { ...device };

    if (outputDevice.features && !fieldsMatchQuery(deviceIdentityFields(outputDevice), query)) {
      outputDevice.features = pruneDeviceFeaturesForQuery(outputDevice.features, query);
    }

    if (includeStatus) {
      outputDevice.status = (await nodeIsOnline(outputDevice.ip, outputDevice.port)) ? "online" : "offline";
    }

    if (input.status && outputDevice.status !== input.status) {
      continue;
    }

    matches.push(outputDevice);
  }

  return {
    query: input.query,
    status: input.status ?? null,
    count: matches.length,
    devices: matches,
    featureCachePath: deviceFeatureCachePath
  };
}

export const filterDevicesTool = defineTool<FilterDevicesInput>({
  name: "filter_devices",
  title: "Filter Devices",
  description:
    "Primary device selection tool: filter cached micrOS devices by name, UID, IP, port, module, function, command, or cached feature text. Feature-query results include only relevant feature modules to keep context compact.",
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe(
        "Text to filter across device identity fields and discovered features. Device-name matches keep full features; feature matches prune irrelevant modules."
      ),
    status: z.enum(["online", "offline"]).optional().describe("Optional live status filter."),
    includeStatus: z.boolean().optional().describe("Check live online/offline status for matched devices.")
  },
  handler: filterDevices
});
