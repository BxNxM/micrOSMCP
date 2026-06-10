import { cacheToDevices, deviceCachePath, readDeviceCache } from "./common.js";
import { defineTool } from "./definition.js";

export type ListDevicesInput = {};

export async function listDevices(_input: ListDevicesInput = {}) {
  const cache = await readDeviceCache();

  return {
    devices: cacheToDevices(cache),
    micrOSCache: cache,
    cachePath: deviceCachePath
  };
}

export const listDevicesTool = defineTool<ListDevicesInput>({
  name: "list_devices",
  title: "List Devices",
  description: "Return devices from the micrOS device cache.",
  inputSchema: {},
  handler: () => listDevices()
});
