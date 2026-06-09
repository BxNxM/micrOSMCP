import { cacheToDevices, deviceCachePath, type ListDevicesInput, readDeviceCache } from "./common.js";

export async function listDevices(_input: ListDevicesInput = {}) {
  const cache = await readDeviceCache();

  return {
    devices: cacheToDevices(cache),
    micrOSCache: cache,
    cachePath: deviceCachePath
  };
}
