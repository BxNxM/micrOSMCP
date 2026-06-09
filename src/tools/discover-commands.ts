import {
  cacheToDevices,
  type Device,
  type DiscoverCommandsInput,
  findDevices,
  mapWithConcurrency,
  MicrOSSocketClient,
  parseModuleHelp,
  parseModules,
  readDeviceCache,
  socketErrorMessage
} from "./common.js";

async function discoverDeviceCommands(
  device: Device,
  input: Pick<DiscoverCommandsInput, "timeout" | "password" | "verbose">
) {
  const client = new MicrOSSocketClient(device, input.timeout ?? 10, input.password, Boolean(input.verbose));

  try {
    await client.connect();
    const moduleLines = await client.sendCommand("modules");
    const modules = parseModules(moduleLines);
    const moduleDetails = [];
    const commands = [];

    for (const moduleName of modules) {
      const helpLines = await client.sendCommand(`${moduleName} help`);
      const functions = parseModuleHelp(helpLines);

      for (const fn of functions) {
        commands.push({
          module: moduleName,
          function: fn.name,
          parameters: fn.parameters,
          command: `${moduleName} ${fn.signature}`,
          signature: fn.signature
        });
      }

      moduleDetails.push({
        name: moduleName,
        helpCommand: `${moduleName} help`,
        rawHelp: helpLines,
        functions
      });
    }

    return {
      ok: true,
      device,
      modulesCommand: "modules",
      rawModules: moduleLines,
      modules: moduleDetails,
      commands
    };
  } catch (error) {
    return {
      ok: false,
      device,
      modulesCommand: "modules",
      error: socketErrorMessage(error)
    };
  } finally {
    client.close();
  }
}

export async function discoverCommands(input: DiscoverCommandsInput = {}) {
  const cache = await readDeviceCache();
  const deviceName = input.deviceTag ?? input.deviceName;
  const devices = findDevices(cacheToDevices(cache), deviceName);

  if (deviceName && devices.length === 0) {
    return {
      ok: false,
      deviceName,
      error: `Unknown device: ${deviceName}`,
      devices: []
    };
  }

  const results = await mapWithConcurrency(devices, input.concurrency ?? 3, (device) =>
    discoverDeviceCommands(device, input)
  );

  return {
    ok: results.every((result) => result.ok),
    deviceName: deviceName ?? null,
    count: results.length,
    devices: results
  };
}
