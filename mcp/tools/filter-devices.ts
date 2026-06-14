import { z } from "zod";
import {
  type CachedDeviceFeatures,
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

type FilterDevice = Omit<Device, "features"> & {
  features?: Omit<CachedDeviceFeatures, "deviceNote">;
};

function stripNestedDeviceNote(features?: CachedDeviceFeatures) {
  if (!features) {
    return undefined;
  }

  const { deviceNote: _deviceNote, ...rest } = features;
  return rest;
}

export async function filterDevices(input: FilterDevicesInput) {
  const { devices } = await readCachedDevicesWithFeatures();
  const query = input.query.trim().toLowerCase();
  const includeStatus = Boolean(input.includeStatus) || input.status !== undefined;
  const matches: FilterDevice[] = [];

  for (const device of devices) {
    if (query && !fieldsMatchQuery(deviceSearchFields(device), query)) {
      continue;
    }

    const { features, ...deviceFields } = device;
    const outputDevice: FilterDevice = { ...deviceFields };
    const noteMatches = fieldsMatchQuery([outputDevice.deviceNote ?? ""], query);
    const outputFeatures =
      features && !fieldsMatchQuery(deviceIdentityFields(device), query) && !noteMatches
        ? pruneDeviceFeaturesForQuery(features, query)
        : features;

    const featuresWithoutNote = stripNestedDeviceNote(outputFeatures);

    if (featuresWithoutNote) {
      outputDevice.features = featuresWithoutNote;
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
    "Primary device selection tool: filter cached micrOS devices by name, UID, IP, port, note, module, function, command, or cached feature text. Feature-query results include only relevant feature modules to keep context compact.",
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe(
        "Text to filter across device identity fields, persistent notes, and discovered features. Device-name matches keep full features; feature matches prune irrelevant modules."
      ),
    status: z.enum(["online", "offline"]).optional().describe("Optional live status filter."),
    includeStatus: z.boolean().optional().describe("Check live online/offline status for matched devices.")
  },
  handler: filterDevices
});
