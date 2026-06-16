import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Socket } from "node:net";
import { networkInterfaces } from "node:os";

export type DeviceStatus = "online" | "offline";

export type Device = {
  uid: string;
  ip: string;
  port: number;
  fuid: string;
  status?: DeviceStatus | "unknown";
  deviceNote?: string;
  features?: CachedDeviceFeatures;
};

export type DeviceCache = Record<string, [string, number, string]>;

export type DiscoveredModuleFunction = {
  name: string;
  parameters: string[];
  signature: string;
};

export type DiscoveredModule = {
  name: string;
  helpCommand: string;
  rawHelp: string[];
  functions: DiscoveredModuleFunction[];
};

export type DiscoveredCommand = {
  module: string;
  function: string;
  parameters: string[];
  command: string;
  signature: string;
};

export type CachedDeviceFeatures = {
  deviceName: string;
  deviceNote: string;
  discoveredAt: string | null;
  modulesCommand: string;
  rawModules: string[];
  modules: DiscoveredModule[];
  commands: DiscoveredCommand[];
};

export type DeviceFeatureCache = Record<string, CachedDeviceFeatures>;
export type DeviceNotesCache = Record<string, string>;

export type DiscoverDevicesOptions = {
  port?: number;
  networkPrefix?: string;
  startHost?: number;
  endHost?: number;
  concurrency?: number;
  timeoutMs?: number;
};

export type NetworkPrefixSource = "input" | "injected" | "auto";

export type NetworkPrefixResolution = {
  networkPrefix: string | null;
  source: NetworkPrefixSource;
};

export const deviceCachePath =
  process.env.MICROS_DEVICE_CACHE_PATH ??
  resolve(process.cwd(), "data/device_conn_cache.json");
export const deviceFeatureCachePath =
  process.env.MICROS_DEVICE_FEATURE_CACHE_PATH ??
  resolve(process.cwd(), "data/device_feature_cache.json");
export const deviceNotesCachePath =
  process.env.MICROS_DEVICE_NOTES_CACHE_PATH ??
  resolve(process.cwd(), "data/device_notes_cache.json");
export const defaultPort = 9008;

const defaultCache: DeviceCache = {
  __devuid__: ["192.168.4.1", defaultPort, "__device_on_AP__"],
  __localhost__: ["127.0.0.1", defaultPort, "__simulator__"]
};
let attemptedAutoDiscover = false;

function normalizeDeviceCache(input: unknown): DeviceCache {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const normalized: DeviceCache = {};

  for (const [uid, value] of Object.entries(input)) {
    if (!Array.isArray(value) || value.length < 3) {
      continue;
    }

    const [ip, port, fuid] = value;

    if (typeof uid !== "string" || typeof ip !== "string" || typeof fuid !== "string") {
      continue;
    }

    const numericPort = Number(port);

    if (!Number.isInteger(numericPort) || numericPort <= 0) {
      continue;
    }

    normalized[uid] = [ip, numericPort, fuid];
  }

  return normalized;
}

function stringArray(input: unknown) {
  return Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : [];
}

export function emptyCachedDeviceFeatures(deviceNote = "", deviceName = ""): CachedDeviceFeatures {
  return {
    deviceName,
    deviceNote,
    discoveredAt: null,
    modulesCommand: "modules",
    rawModules: [],
    modules: [],
    commands: []
  };
}

function normalizeDeviceFeatureCache(input: unknown): DeviceFeatureCache {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const normalized: DeviceFeatureCache = {};

  for (const [uid, value] of Object.entries(input)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const entry = value as Record<string, unknown>;
    const deviceName = typeof entry.deviceName === "string" ? entry.deviceName : "";
    const deviceNote = typeof entry.deviceNote === "string" ? entry.deviceNote : "";
    const discoveredAt = typeof entry.discoveredAt === "string" ? entry.discoveredAt : null;
    const modulesCommand = typeof entry.modulesCommand === "string" ? entry.modulesCommand : "modules";

    const modules = Array.isArray(entry.modules)
      ? entry.modules.flatMap((moduleEntry): DiscoveredModule[] => {
          if (!moduleEntry || typeof moduleEntry !== "object" || Array.isArray(moduleEntry)) {
            return [];
          }

          const module = moduleEntry as Record<string, unknown>;
          const name = typeof module.name === "string" ? module.name : null;
          const helpCommand = typeof module.helpCommand === "string" ? module.helpCommand : null;

          if (!name || !helpCommand) {
            return [];
          }

          const functions = Array.isArray(module.functions)
            ? module.functions.flatMap((fnEntry): DiscoveredModuleFunction[] => {
                if (!fnEntry || typeof fnEntry !== "object" || Array.isArray(fnEntry)) {
                  return [];
                }

                const fn = fnEntry as Record<string, unknown>;
                const fnName = typeof fn.name === "string" ? fn.name : null;
                const signature = typeof fn.signature === "string" ? fn.signature : null;

                if (!fnName || !signature) {
                  return [];
                }

                return [
                  {
                    name: fnName,
                    parameters: stringArray(fn.parameters),
                    signature
                  }
                ];
              })
            : [];

          return [
            {
              name,
              helpCommand,
              rawHelp: stringArray(module.rawHelp),
              functions
            }
          ];
        })
      : [];

    const commands = Array.isArray(entry.commands)
      ? entry.commands.flatMap((commandEntry): DiscoveredCommand[] => {
          if (!commandEntry || typeof commandEntry !== "object" || Array.isArray(commandEntry)) {
            return [];
          }

          const command = commandEntry as Record<string, unknown>;
          const moduleName = typeof command.module === "string" ? command.module : null;
          const functionName = typeof command.function === "string" ? command.function : null;
          const commandText = typeof command.command === "string" ? command.command : null;
          const signature = typeof command.signature === "string" ? command.signature : null;

          if (!moduleName || !functionName || !commandText || !signature) {
            return [];
          }

          return [
            {
              module: moduleName,
              function: functionName,
              parameters: stringArray(command.parameters),
              command: commandText,
              signature
            }
          ];
        })
      : [];

    normalized[uid] = {
      deviceName,
      deviceNote,
      discoveredAt,
      modulesCommand,
      rawModules: stringArray(entry.rawModules),
      modules,
      commands
    };
  }

  return normalized;
}

function normalizeDeviceNotesCache(input: unknown): DeviceNotesCache {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const normalized: DeviceNotesCache = {};

  for (const [uid, note] of Object.entries(input)) {
    if (typeof uid === "string" && typeof note === "string") {
      normalized[uid] = note;
    }
  }

  return normalized;
}

function stripDeviceNotesFromFeatureCache(cache: DeviceFeatureCache) {
  return Object.fromEntries(
    Object.entries(cache).map(([uid, features]) => {
      const { deviceNote: _deviceNote, ...featureData } = features;
      return [uid, featureData];
    })
  );
}

export function cacheToDevices(cache: DeviceCache): Device[] {
  return Object.entries(cache).map(([uid, [ip, port, fuid]]) => ({
    uid,
    ip,
    port,
    fuid
  }));
}

export function deviceNoteKey(device: Pick<Device, "uid" | "fuid">) {
  return device.fuid || device.uid;
}

function deviceNoteKeyForUid(uid: string, cache: DeviceCache) {
  const fuid = cache[uid]?.[2];
  return fuid || uid;
}

function notesByUid(notesCache: DeviceNotesCache, deviceCache: DeviceCache) {
  const notes: DeviceNotesCache = {};
  const knownNoteKeys = new Set<string>();

  for (const [uid, [_ip, _port, fuid]] of Object.entries(deviceCache)) {
    knownNoteKeys.add(uid);
    knownNoteKeys.add(fuid);

    const note = notesCache[fuid] ?? notesCache[uid];

    if (note !== undefined) {
      notes[uid] = note;
    }
  }

  for (const [key, note] of Object.entries(notesCache)) {
    if (knownNoteKeys.has(key) || notes[key] !== undefined) {
      continue;
    }

    notes[key] = note;
  }

  return notes;
}

function featuresWithDeviceContext(
  featureCache: DeviceFeatureCache,
  notesCache: DeviceNotesCache,
  deviceCache: DeviceCache
) {
  const deviceNotesByUid = notesByUid(notesCache, deviceCache);
  const withContext: DeviceFeatureCache = {};

  for (const [uid, features] of Object.entries(featureCache)) {
    withContext[uid] = {
      ...features,
      deviceName: deviceNoteKeyForUid(uid, deviceCache),
      deviceNote: deviceNotesByUid[uid] ?? features.deviceNote
    };
  }

  for (const [uid, note] of Object.entries(deviceNotesByUid)) {
    withContext[uid] = withContext[uid] ?? emptyCachedDeviceFeatures("", deviceNoteKeyForUid(uid, deviceCache));
    withContext[uid] = {
      ...withContext[uid],
      deviceName: deviceNoteKeyForUid(uid, deviceCache),
      deviceNote: note
    };
  }

  return withContext;
}

export function attachDeviceFeatures(devices: Device[], featureCache: DeviceFeatureCache) {
  return devices.map((device) => {
    const features = featureCache[device.uid];

    return {
      ...device,
      deviceNote: features?.deviceNote ?? "",
      ...(features ? { features } : {})
    };
  });
}

export async function readCachedDevicesWithFeatures() {
  const cache = await readDeviceCache();
  const featureCache = await readDeviceFeatureCache();

  return {
    cache,
    featureCache,
    devices: attachDeviceFeatures(cacheToDevices(cache), featureCache)
  };
}

export function deviceSearchFields(device: Device) {
  return [
    ...deviceIdentityFields(device),
    ...deviceFeatureSearchFields(device.features)
  ];
}

export function deviceIdentityFields(device: Device) {
  return [device.uid, device.ip, String(device.port), device.fuid];
}

export function fieldsMatchQuery(fields: string[], query: string) {
  const normalized = query.trim().toLowerCase();
  return normalized.length > 0 && fields.some((field) => field.toLowerCase().includes(normalized));
}

export function deviceFeatureSearchFields(features?: CachedDeviceFeatures) {
  if (!features) {
    return [];
  }

  return [
    features.deviceNote,
    features.deviceName,
    ...(features.discoveredAt ? [features.discoveredAt] : []),
    features.modulesCommand,
    ...features.rawModules,
    ...features.modules.flatMap((module) => [
      module.name,
      module.helpCommand,
      ...module.rawHelp,
      ...module.functions.flatMap((fn) => [fn.name, fn.signature, ...fn.parameters])
    ]),
    ...features.commands.flatMap((command) => [
      command.module,
      command.function,
      command.command,
      command.signature,
      ...command.parameters
    ])
  ];
}

function moduleSearchFields(module: DiscoveredModule) {
  return [
    module.name,
    module.helpCommand,
    ...module.rawHelp,
    ...module.functions.flatMap((fn) => [fn.name, fn.signature, ...fn.parameters])
  ];
}

function functionSearchFields(fn: DiscoveredModuleFunction) {
  return [fn.name, fn.signature, ...fn.parameters];
}

function commandSearchFields(command: DiscoveredCommand) {
  return [command.module, command.function, command.command, command.signature, ...command.parameters];
}

export function pruneDeviceFeaturesForQuery(features: CachedDeviceFeatures | undefined, query: string) {
  if (!features || query.trim().length === 0) {
    return features;
  }

  const modules = features.modules.flatMap((module): DiscoveredModule[] => {
    if (!fieldsMatchQuery(moduleSearchFields(module), query)) {
      return [];
    }

    const moduleNameMatches = fieldsMatchQuery([module.name, module.helpCommand, ...module.rawHelp], query);
    const functions = moduleNameMatches
      ? module.functions
      : module.functions.filter((fn) => fieldsMatchQuery(functionSearchFields(fn), query));

    return [
      {
        ...module,
        rawHelp: moduleNameMatches
          ? module.rawHelp
          : module.rawHelp.filter((line) => fieldsMatchQuery([line], query)),
        functions
      }
    ];
  });
  const moduleNames = new Set(modules.map((module) => module.name));
  const commands = features.commands.filter(
    (command) => moduleNames.has(command.module) || fieldsMatchQuery(commandSearchFields(command), query)
  );

  return {
    ...features,
    rawModules: modules.map((module) => module.name),
    modules,
    commands
  };
}

async function readRawDeviceCache(): Promise<DeviceCache | null> {
  try {
    const raw = await readFile(deviceCachePath, "utf8");
    return { ...defaultCache, ...normalizeDeviceCache(JSON.parse(raw)) };
  } catch {
    return null;
  }
}

export async function saveDeviceCache(cache: DeviceCache) {
  await mkdir(dirname(deviceCachePath), { recursive: true });
  await writeFile(deviceCachePath, `${JSON.stringify({ ...defaultCache, ...cache }, null, 4)}\n`);
}

export async function readDeviceFeatureCache(): Promise<DeviceFeatureCache> {
  const notesCache = await readDeviceNotesCache();
  const deviceCache = (await readRawDeviceCache()) ?? defaultCache;

  try {
    const raw = await readFile(deviceFeatureCachePath, "utf8");
    return featuresWithDeviceContext(normalizeDeviceFeatureCache(JSON.parse(raw)), notesCache, deviceCache);
  } catch {
    return featuresWithDeviceContext({}, notesCache, deviceCache);
  }
}

export async function saveDeviceFeatureCache(cache: DeviceFeatureCache) {
  const notesCache = await readDeviceNotesCache();
  const deviceCache = await readDeviceCacheWithoutAutoDiscover();

  for (const [uid, features] of Object.entries(cache)) {
    cache[uid] = {
      ...features,
      deviceName: deviceNoteKeyForUid(uid, deviceCache)
    };

    if (features.deviceNote.trim().length > 0) {
      const noteKey = deviceNoteKeyForUid(uid, deviceCache);
      notesCache[noteKey] = features.deviceNote;
      delete notesCache[uid];
    }
  }

  await saveDeviceNotesCache(notesCache);
  await mkdir(dirname(deviceFeatureCachePath), { recursive: true });
  await writeFile(deviceFeatureCachePath, `${JSON.stringify(stripDeviceNotesFromFeatureCache(cache), null, 4)}\n`);
}

export async function readDeviceNotesCache(): Promise<DeviceNotesCache> {
  try {
    const raw = await readFile(deviceNotesCachePath, "utf8");
    return normalizeDeviceNotesCache(JSON.parse(raw));
  } catch {
    return {};
  }
}

export async function saveDeviceNotesCache(cache: DeviceNotesCache) {
  const withoutEmptyNotes = Object.fromEntries(
    Object.entries(cache).filter(([_uid, note]) => note.trim().length > 0)
  );
  await mkdir(dirname(deviceNotesCachePath), { recursive: true });
  await writeFile(deviceNotesCachePath, `${JSON.stringify(withoutEmptyNotes, null, 4)}\n`);
}

export async function readDeviceCache(): Promise<DeviceCache> {
  const cache = await readRawDeviceCache();

  if (cache !== null) {
    return cache;
  }

  await saveDeviceCache(defaultCache);

  if (!attemptedAutoDiscover) {
    attemptedAutoDiscover = true;
    try {
      const discovery = await discoverAndSaveDevices();
      return discovery.updatedCache;
    } catch {
      return defaultCache;
    }
  }

  return defaultCache;
}

async function readDeviceCacheWithoutAutoDiscover(): Promise<DeviceCache> {
  const cache = await readRawDeviceCache();

  if (cache !== null) {
    return cache;
  }

  await saveDeviceCache(defaultCache);
  return defaultCache;
}

export function selectDevice(devices: Device[], deviceTag: string) {
  return devices.find(
    (device) => device.uid === deviceTag || device.fuid === deviceTag || device.ip === deviceTag
  );
}

export function findDevices(devices: Device[], deviceTag?: string) {
  const query = deviceTag?.trim();

  if (!query) {
    return devices;
  }

  const exact = selectDevice(devices, query);

  if (exact) {
    return [exact];
  }

  const normalized = query.toLowerCase();
  return devices.filter((device) =>
    [device.uid, device.fuid, device.ip].some((field) => field.toLowerCase().includes(normalized))
  );
}

export function normalizeCommandPipeline(command: string | string[], separator = "<a>") {
  const pipeline = Array.isArray(command) ? command : command.split(separator);
  return pipeline.map((entry) => entry.trim()).filter(Boolean);
}

export function socketErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function connectSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();

    const cleanup = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
    };

    const onConnect = () => {
      cleanup();
      socket.setTimeout(timeoutMs);
      resolve(socket);
    };

    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };

    const onTimeout = () => {
      cleanup();
      socket.destroy();
      reject(new Error(`Connection timed out: ${host}:${port}`));
    };

    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.setTimeout(timeoutMs);
    socket.connect(port, host);
  });
}

function readUntil(socket: Socket, predicate: (data: string) => boolean, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      if (predicate(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before a complete response was received."));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Socket read timed out."));
    }, timeoutMs);

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function parsePrompt(raw: string) {
  const lines = raw.trim().split("\n");
  const lastLine = lines.at(-1) ?? "";
  const tokens = lastLine.trim().split(/\s+/);
  const dollarIndex = tokens.lastIndexOf("$");

  if (dollarIndex > 0) {
    return `${tokens[dollarIndex - 1]} $`;
  }

  const match = lastLine.match(/([^\s]+)\s+\$/);
  return match ? `${match[1]} $` : null;
}

function stripPrompt(raw: string, prompt: string) {
  return raw
    .replaceAll(prompt, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function cleanOutputLines(lines: string[]) {
  return lines.map((line) => line.trim()).filter(Boolean);
}

export function parseModules(lines: string[]) {
  const text = cleanOutputLines(lines).join("\n");
  const bracketMatch = text.match(/\[(.*)\]/s);

  if (bracketMatch) {
    return bracketMatch[1]
      .split(",")
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }

  return cleanOutputLines(lines)
    .flatMap((line) => line.split(","))
    .map((entry) => entry.trim().replace(/^[-*]\s*/, "").replace(/^['"]|['"]$/g, ""))
    .filter((entry) => /^[A-Za-z_][\w-]*$/.test(entry));
}

function parseHelpLine(line: string) {
  const cleaned = line.trim().replace(/,$/, "");

  if (!cleaned) {
    return null;
  }

  const [name, ...parameters] = cleaned.split(/\s+/);

  if (!name || !/^[A-Za-z_]\w*$/.test(name)) {
    return null;
  }

  return {
    name,
    parameters,
    signature: cleaned
  };
}

export function parseModuleHelp(lines: string[]) {
  return cleanOutputLines(lines)
    .map(parseHelpLine)
    .filter((entry): entry is NonNullable<ReturnType<typeof parseHelpLine>> => entry !== null);
}

function promptMatchesDevice(prompt: string, device: Device) {
  const promptHost = prompt.replace("$", "").trim();
  const fuidHost = device.fuid.split(".")[0];
  return device.fuid.includes("__simulator__") || promptHost === fuidHost;
}

export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>) {
  const results: R[] = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await task(items[index]);
      }
    })
  );

  return results;
}

// micrOS keeps a persistent TCP prompt per connection. Reusing one socket lets
// command pipelines and module-help discovery avoid repeated login handshakes.
export class MicrOSSocketClient {
  private socket: Socket | null = null;
  private prompt: string | null = null;

  constructor(
    private readonly device: Device,
    private readonly timeoutSeconds: number,
    private readonly password?: string,
    private readonly verbose = false,
    private readonly validatePrompt = true
  ) {}

  async connect() {
    const timeoutMs = this.timeoutSeconds * 1000;
    this.socket = await connectSocket(this.device.ip, this.device.port, timeoutMs);
    const promptData = await readUntil(this.socket, (data) => data.includes("$") || data.includes("Bye!"), timeoutMs);
    this.prompt = parsePrompt(promptData);

    if (!this.prompt) {
      throw new Error(`Cannot read micrOS prompt from ${this.device.ip}:${this.device.port}`);
    }

    if (this.validatePrompt && !promptMatchesDevice(this.prompt, this.device)) {
      throw new Error(`Prompt mismatch: device ${this.device.fuid}, prompt ${this.prompt}`);
    }

    if (this.password && promptData.includes("[password]")) {
      const authOutput = await this.sendCommand(this.password);
      if (authOutput.join("\n").includes("AuthFailed") || authOutput.join("\n").includes("Bye!")) {
        throw new Error(`Connection ${this.prompt} - AuthFailed`);
      }
    }

    if (this.verbose) {
      console.error(`[micrOS] connected ${this.device.fuid} at ${this.device.ip}:${this.device.port}`);
    }
  }

  async sendCommand(command: string) {
    if (!this.socket || !this.prompt) {
      throw new Error("Socket is not connected.");
    }

    if (command.trim().length === 0) {
      return [];
    }

    this.socket.write(command);

    // Reboot intentionally closes the prompt; do not wait for another one.
    if (command.includes("reboot")) {
      return ["Bye!"];
    }

    const timeoutMs = this.timeoutSeconds * 1000;
    const raw = await readUntil(
      this.socket,
      (data) => data.trim().split("\n").at(-1)?.includes(this.prompt ?? "") === true || data.includes("Bye!"),
      timeoutMs
    );

    return stripPrompt(raw, this.prompt);
  }

  async runPipeline(commands: string[]) {
    await this.connect();
    const replies: string[][] = [];

    try {
      for (const command of commands) {
        replies.push(await this.sendCommand(command));
      }
    } finally {
      this.close();
    }

    return replies;
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

export async function nodeIsOnline(ip: string, port = defaultPort, timeoutMs = 1000) {
  try {
    const socket = await connectSocket(ip, port, timeoutMs);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

function autoDetectNetworkPrefix() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address.split(".").slice(0, 3).join(".");
      }
    }
  }

  return null;
}

export function resolveNetworkPrefix(inputNetworkPrefix?: string): NetworkPrefixResolution {
  if (inputNetworkPrefix) {
    return {
      networkPrefix: inputNetworkPrefix,
      source: "input"
    };
  }

  if (process.env.MICROS_NETWORK_PREFIX) {
    return {
      networkPrefix: process.env.MICROS_NETWORK_PREFIX,
      source: "injected"
    };
  }

  return {
    networkPrefix: autoDetectNetworkPrefix(),
    source: "auto"
  };
}

export function getLocalNetworkPrefix() {
  return resolveNetworkPrefix().networkPrefix;
}

async function scanOpenPort({
  port = defaultPort,
  networkPrefix = getLocalNetworkPrefix(),
  startHost = 2,
  endHost = 254,
  concurrency = 50,
  timeoutMs = 1000
}: Required<Pick<DiscoverDevicesOptions, "port" | "startHost" | "endHost" | "concurrency" | "timeoutMs">> & {
  networkPrefix: string | null;
}) {
  const prefix = networkPrefix;

  if (!prefix) {
    return [];
  }

  const first = Math.max(1, Math.min(startHost, endHost));
  const last = Math.min(254, Math.max(startHost, endHost));
  const hosts = Array.from({ length: last - first + 1 }, (_, index) => `${prefix}.${first + index}`);
  const online: string[] = [];

  for (let index = 0; index < hosts.length; index += concurrency) {
    const chunk = hosts.slice(index, index + concurrency);
    const results = await Promise.all(
      chunk.map(async (host) => ({
        host,
        isOnline: await nodeIsOnline(host, port, timeoutMs)
      }))
    );

    online.push(...results.filter((result) => result.isOnline).map((result) => result.host));
  }

  return online;
}

async function handshakeDevice(ip: string, port = defaultPort, timeoutSeconds = 3): Promise<Device | null> {
  const device: Device = {
    uid: ip,
    ip,
    port,
    fuid: ip
  };
  const client = new MicrOSSocketClient(device, timeoutSeconds, undefined, false, false);

  try {
    const replies = await client.runPipeline(["hello"]);
    const text = replies.flat().join("\n");
    const match = text.match(/hello:([^:\n]+):([^:\n]+)/);

    if (!match) {
      return null;
    }

    return {
      uid: match[2],
      ip,
      port,
      fuid: match[1]
    };
  } catch {
    return null;
  } finally {
    client.close();
  }
}

export async function discoverAndSaveDevices(input: DiscoverDevicesOptions = {}) {
  const port = input.port ?? defaultPort;
  const timeoutMs = input.timeoutMs ?? 1000;
  const prefixResolution = resolveNetworkPrefix(input.networkPrefix);
  const openHosts = await scanOpenPort({
    port,
    networkPrefix: prefixResolution.networkPrefix,
    startHost: input.startHost ?? 2,
    endHost: input.endHost ?? 254,
    concurrency: input.concurrency ?? 50,
    timeoutMs
  });
  const handshakeTimeoutSeconds = Math.max(3, Math.ceil(timeoutMs / 1000));
  const devices = await Promise.all(openHosts.map((host) => handshakeDevice(host, port, handshakeTimeoutSeconds)));
  const discovered = devices.filter((device): device is Device => device !== null);
  const existing = await readDeviceCacheWithoutAutoDiscover();
  const nextCache: DeviceCache = { ...existing };

  for (const device of discovered) {
    nextCache[device.uid] = [device.ip, device.port, device.fuid];
  }

  await saveDeviceCache(nextCache);

  return {
    port,
    networkPrefix: prefixResolution.networkPrefix,
    networkPrefixSource: prefixResolution.source,
    openHosts,
    discovered,
    updatedCache: nextCache,
    cachePath: deviceCachePath
  };
}
