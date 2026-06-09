import { discoverAndSaveDevices, type DiscoverDevicesInput } from "./common.js";

export async function discoverDevices(input: DiscoverDevicesInput = {}) {
  return discoverAndSaveDevices(input);
}
