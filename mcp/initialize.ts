import { discoverCommands } from "./tools/discover-commands.js";
import { discoverDevices } from "./tools/discover-devices.js";

export type InitializeMicrOSStateInput = {
  discoverTimeoutMs?: number;
  commandTimeout?: number;
  commandConcurrency?: number;
  log?: (message: string) => void;
};

function initializationLog(input: InitializeMicrOSStateInput, message: string) {
  input.log?.(`[micrOSMCP] initialization: ${message}`);
}

export async function initializeMicrOSState(input: InitializeMicrOSStateInput = {}) {
  const discoverTimeoutMs = input.discoverTimeoutMs ?? 1000;
  const commandTimeout = input.commandTimeout ?? 3;
  const commandConcurrency = input.commandConcurrency ?? 3;

  initializationLog(input, `discovering devices with ${discoverTimeoutMs}ms scan timeout`);
  const deviceDiscovery = await discoverDevices({
    timeoutMs: discoverTimeoutMs,
    refreshFeatures: false
  });
  const networkMode =
    deviceDiscovery.networkPrefixSource === "injected"
      ? "containerized/injected"
      : deviceDiscovery.networkPrefixSource === "input"
        ? "tool-input"
        : "native/auto-detected";
  initializationLog(
    input,
    `network scan prefix ${deviceDiscovery.networkPrefix ?? "unavailable"} (${networkMode})`
  );
  initializationLog(
    input,
    `device discovery complete: ${deviceDiscovery.openHosts.length} open host(s), ${deviceDiscovery.discovered.length} micrOS device(s)`
  );

  initializationLog(
    input,
    `discovering features for cached devices with ${commandConcurrency} worker(s), ${commandTimeout}s command timeout`
  );
  const featureDiscovery = await discoverCommands({
    timeout: commandTimeout,
    concurrency: commandConcurrency
  });
  const successfulFeatureDiscoveries = featureDiscovery.devices.filter((device) => device.ok).length;
  initializationLog(
    input,
    `feature discovery complete: ${successfulFeatureDiscoveries}/${featureDiscovery.count} device(s) discovered`
  );

  return {
    devices: {
      openHosts: deviceDiscovery.openHosts.length,
      discovered: deviceDiscovery.discovered.length,
      networkPrefix: deviceDiscovery.networkPrefix,
      networkPrefixSource: deviceDiscovery.networkPrefixSource
    },
    features: {
      ok: featureDiscovery.ok,
      count: featureDiscovery.count,
      discovered: successfulFeatureDiscoveries
    }
  };
}

export async function initializeMicrOSStateSafely(input: InitializeMicrOSStateInput = {}) {
  if (process.env.MICROS_INITIALIZE_ON_START === "0") {
    initializationLog(input, "skipped because MICROS_INITIALIZE_ON_START=0");
    return {
      skipped: true,
      reason: "MICROS_INITIALIZE_ON_START=0"
    };
  }

  try {
    return await initializeMicrOSState(input);
  } catch (error) {
    initializationLog(input, `failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
