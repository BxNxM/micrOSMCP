import {
  cacheToDevices,
  deviceCachePath,
  deviceFeatureCachePath,
  readDeviceCache,
  readDeviceFeatureCache
} from "./common.js";
import { defineTool } from "./definition.js";

export type ListDevicesInput = {};

export async function listDevices(_input: ListDevicesInput = {}) {
  const cache = await readDeviceCache();
  const featureCache = await readDeviceFeatureCache();
  const devices = cacheToDevices(cache).map((device) => {
    const modules = featureCache[device.uid]?.modules.map((module) => module.name) ?? [];

    return {
      ...device,
      moduleCount: modules.length,
      modules,
      featuresDiscoveredAt: featureCache[device.uid]?.discoveredAt ?? null
    };
  });

  return {
    count: devices.length,
    devices,
    cachePath: deviceCachePath,
    featureCachePath: deviceFeatureCachePath
  };
}

export const listDevicesTool = defineTool<ListDevicesInput>({
  name: "list_devices",
  title: "List Devices",
  description: "Return a compact cached device inventory with device identity and known module names only.",
  inputSchema: {},
  handler: () => listDevices()
});
