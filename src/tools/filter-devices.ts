import { z } from "zod";
import {
  cacheToDevices,
  type Device,
  type DeviceStatus,
  nodeIsOnline,
  readDeviceCache
} from "./common.js";
import { defineTool } from "./definition.js";

export type FilterDevicesInput = {
  query: string;
  status?: DeviceStatus;
  includeStatus?: boolean;
};

export async function filterDevices(input: FilterDevicesInput) {
  const cache = await readDeviceCache();
  const query = input.query.trim().toLowerCase();
  const includeStatus = Boolean(input.includeStatus) || input.status !== undefined;
  const matches: Device[] = [];

  for (const device of cacheToDevices(cache)) {
    const fields = [device.uid, device.ip, String(device.port), device.fuid];

    if (query && !fields.some((field) => field.toLowerCase().includes(query))) {
      continue;
    }

    if (includeStatus) {
      device.status = (await nodeIsOnline(device.ip, device.port)) ? "online" : "offline";
    }

    if (input.status && device.status !== input.status) {
      continue;
    }

    matches.push(device);
  }

  return {
    query: input.query,
    status: input.status ?? null,
    count: matches.length,
    devices: matches
  };
}

export const filterDevicesTool = defineTool<FilterDevicesInput>({
  name: "filter_devices",
  title: "Filter Devices",
  description: "Filter cached micrOS devices by UID, FUID, IP address, or port.",
  inputSchema: {
    query: z.string().min(1).describe("Text to filter across cached micrOS device fields."),
    status: z.enum(["online", "offline"]).optional().describe("Optional live status filter."),
    includeStatus: z.boolean().optional().describe("Check live online/offline status for matched devices.")
  },
  handler: filterDevices
});
