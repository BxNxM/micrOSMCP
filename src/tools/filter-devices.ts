import {
  cacheToDevices,
  type Device,
  type FilterDevicesInput,
  nodeIsOnline,
  readDeviceCache
} from "./common.js";

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
