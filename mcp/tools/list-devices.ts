import {
  cacheToDevices,
  readDeviceCache,
  readDeviceFeatureCache
} from "./common.js";
import { defineTool } from "../tool-definition.js";

export type ListDevicesInput = {};

export async function listDevices(_input: ListDevicesInput = {}) {
  const cache = await readDeviceCache();
  const featureCache = await readDeviceFeatureCache();
  const devices = cacheToDevices(cache).map((device) => {
    const modules = featureCache[device.uid]?.modules.map((module) => module.name) ?? [];

    return {
      ...device,
      deviceNote: featureCache[device.uid]?.deviceNote ?? "",
      moduleCount: modules.length,
      modules,
      featuresDiscoveredAt: featureCache[device.uid]?.discoveredAt ?? null
    };
  });

  return {
    count: devices.length,
    devices
  };
}

export const listDevicesTool = defineTool<ListDevicesInput>(import.meta.url, {
  inputSchema: {},
  handler: () => listDevices()
});
