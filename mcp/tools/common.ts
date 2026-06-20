import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Socket } from "node:net";
import { networkInterfaces } from "node:os";

export type DeviceStatus = "online" | "offline";

export type Device = {
  uid: string;
  ip: string;
  port: number;
  deviceName: string;
  status?: DeviceStatus | "unknown";
  deviceNote?: string;
  features?: CachedDeviceFeatures;
};

export type DeviceConnection = {
  ip: string;
  port: number;
  deviceName: string;
};

export type DeviceCache = Record<string, DeviceConnection>;

export type DiscoveredModule = {
  name: string;
  functions: string[];
};

export type CachedDeviceFeatures = {
  deviceNote: string;
  discoveredAt: string | null;
  modules: DiscoveredModule[];
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
  __devuid__: { ip: "192.168.4.1", port: defaultPort, deviceName: "__device_on_AP__" },
  __localhost__: { ip: "127.0.0.1", port: defaultPort, deviceName: "__simulator__" }
};
let attemptedAutoDiscover = false;

function normalizeDeviceCache(input: unknown): DeviceCache {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const normalized: DeviceCache = {};

  for (const [uid, value] of Object.entries(input)) {
    const legacy = Array.isArray(value) && value.length >= 3 ? value : null;
    const entry = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    const ip = legacy?.[0] ?? entry?.ip;
    const port = legacy?.[1] ?? entry?.port;
    const deviceName = legacy?.[2] ?? entry?.deviceName;

    if (typeof uid !== "string" || typeof ip !== "string" || typeof deviceName !== "string") {
      continue;
    }

    const numericPort = Number(port);

    if (!Number.isInteger(numericPort) || numericPort <= 0) {
      continue;
    }

    normalized[uid] = { ip, port: numericPort, deviceName };
  }

  return normalized;
}

export function emptyCachedDeviceFeatures(deviceNote = ""): CachedDeviceFeatures {
  return {
    deviceNote,
    discoveredAt: null,
    modules: []
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
    const deviceNote = typeof entry.deviceNote === "string" ? entry.deviceNote : "";
    const discoveredAt = typeof entry.discoveredAt === "string" ? entry.discoveredAt : null;
    const parsedModules = Array.isArray(entry.modules)
      ? entry.modules.flatMap((moduleEntry): DiscoveredModule[] => {
          if (!moduleEntry || typeof moduleEntry !== "object" || Array.isArray(moduleEntry)) {
            return [];
          }

          const module = moduleEntry as Record<string, unknown>;
          const name = typeof module.name === "string" ? module.name : null;

          if (!name) {
            return [];
          }

          const functions = Array.isArray(module.functions)
            ? module.functions.flatMap((fnEntry): string[] => {
                if (typeof fnEntry === "string" && fnEntry.trim()) {
                  return [fnEntry.trim()];
                }

                if (fnEntry && typeof fnEntry === "object" && !Array.isArray(fnEntry)) {
                  const signature = (fnEntry as Record<string, unknown>).signature;
                  return typeof signature === "string" && signature.trim() ? [signature.trim()] : [];
                }

                return [];
              })
            : [];

          return [{ name, functions }];
        })
      : [];
    const moduleFunctions = new Map(parsedModules.map((module) => [module.name, new Set(module.functions)]));

    if (Array.isArray(entry.commands)) {
      for (const commandEntry of entry.commands) {
        if (!commandEntry || typeof commandEntry !== "object" || Array.isArray(commandEntry)) {
          continue;
        }

        const command = commandEntry as Record<string, unknown>;
        const moduleName = typeof command.module === "string" ? command.module : null;
        const signature = typeof command.signature === "string" ? command.signature.trim() : "";

        if (moduleName && signature) {
          const functions = moduleFunctions.get(moduleName) ?? new Set<string>();
          functions.add(signature);
          moduleFunctions.set(moduleName, functions);
        }
      }
    }

    const modules = [...moduleFunctions].map(([name, functions]) => ({ name, functions: [...functions] }));

    normalized[uid] = {
      deviceNote,
      discoveredAt,
      modules
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
  return Object.entries(cache).map(([uid, { ip, port, deviceName }]) => ({
    uid,
    ip,
    port,
    deviceName
  }));
}

export function deviceNoteKey(device: Pick<Device, "uid" | "deviceName">) {
  return device.deviceName || device.uid;
}

function deviceNameForUid(uid: string, cache: DeviceCache) {
  const deviceName = cache[uid]?.deviceName;
  return deviceName || uid;
}

function notesByUid(notesCache: DeviceNotesCache, deviceCache: DeviceCache) {
  const notes: DeviceNotesCache = {};
  const knownNoteKeys = new Set<string>();

  for (const [uid, { deviceName }] of Object.entries(deviceCache)) {
    knownNoteKeys.add(uid);
    knownNoteKeys.add(deviceName);

    const note = notesCache[deviceName] ?? notesCache[uid];

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
      deviceNote: deviceNotesByUid[uid] ?? features.deviceNote
    };
  }

  for (const [uid, note] of Object.entries(deviceNotesByUid)) {
    withContext[uid] = withContext[uid] ?? emptyCachedDeviceFeatures();
    withContext[uid] = {
      ...withContext[uid],
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
  return [device.uid, device.ip, String(device.port), device.deviceName];
}

function fuzzyTokens(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export type SearchFuzziness = 0 | 1 | 2;

function fuzzyDistanceLimit(query: string, fuzziness: SearchFuzziness) {
  if (fuzziness === 0) {
    return 0;
  }

  if (fuzziness === 1) {
    return query.length >= 8 ? 2 : query.length >= 4 ? 1 : 0;
  }

  return query.length >= 8 ? 3 : query.length >= 5 ? 2 : query.length >= 3 ? 1 : 0;
}

function damerauLevenshteinWithin(left: string, right: string, limit: number) {
  if (Math.abs(left.length - right.length) > limit) {
    return false;
  }

  const rows = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));

  for (let row = 0; row <= left.length; row += 1) {
    rows[row][0] = row;
  }

  for (let column = 0; column <= right.length; column += 1) {
    rows[0][column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    let rowMinimum = limit + 1;

    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + substitutionCost
      );

      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        rows[row][column] = Math.min(rows[row][column], rows[row - 2][column - 2] + 1);
      }

      rowMinimum = Math.min(rowMinimum, rows[row][column]);
    }

    if (rowMinimum > limit) {
      return false;
    }
  }

  return rows[left.length][right.length] <= limit;
}

export function fieldsMatchQuery(fields: string[], query: string, fuzziness: SearchFuzziness = 1) {
  const normalized = query.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  if (fields.some((field) => field.toLowerCase().includes(normalized))) {
    return true;
  }

  const queryTokens = fuzzyTokens(query);
  const fuzzyQuery = /^[a-z0-9]+$/i.test(query.trim())
    ? normalized
    : queryTokens.length === 1
      ? queryTokens[0]
      : null;

  return (
    fuzzyQuery !== null &&
    fields.some((field) => {
      const candidates = [field.toLowerCase(), ...fuzzyTokens(field)];
      const limit = fuzzyDistanceLimit(fuzzyQuery, fuzziness);

      return limit > 0 && candidates.some((candidate) => damerauLevenshteinWithin(fuzzyQuery, candidate, limit));
    })
  );
}

export function deviceFeatureSearchFields(features?: CachedDeviceFeatures) {
  if (!features) {
    return [];
  }

  return [
    features.deviceNote,
    ...(features.discoveredAt ? [features.discoveredAt] : []),
    ...features.modules.flatMap((module) => [module.name, ...module.functions, ...module.functions.map((fn) => `${module.name} ${fn}`)])
  ];
}

function moduleSearchFields(module: DiscoveredModule) {
  return [module.name, ...module.functions, ...module.functions.map((fn) => `${module.name} ${fn}`)];
}

export function pruneDeviceFeaturesForQuery(
  features: CachedDeviceFeatures | undefined,
  searchTerms: string | string[],
  fuzziness: SearchFuzziness = 1
) {
  const terms = (Array.isArray(searchTerms) ? searchTerms : [searchTerms]).map((term) => term.trim()).filter(Boolean);

  if (!features || terms.length === 0) {
    return features;
  }

  const modules = features.modules.flatMap((module): DiscoveredModule[] => {
    if (!terms.some((term) => fieldsMatchQuery(moduleSearchFields(module), term, fuzziness))) {
      return [];
    }

    return [module];
  });
  return {
    ...features,
    modules
  };
}

async function readRawDeviceCache(): Promise<DeviceCache | null> {
  try {
    const raw = await readFile(deviceCachePath, "utf8");
    const parsed = JSON.parse(raw);
    const cache = { ...defaultCache, ...normalizeDeviceCache(parsed) };
    const entries = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.values(parsed) : [];

    if (entries.some((entry) => Array.isArray(entry))) {
      await saveDeviceCache(cache);
    }

    return cache;
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
    const parsed = JSON.parse(raw);
    const features = featuresWithDeviceContext(normalizeDeviceFeatureCache(parsed), notesCache, deviceCache);
    const entries = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.values(parsed) : [];
    const needsMigration = entries.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        ["deviceName", "deviceNote", "modulesCommand", "rawModules", "commands"].some((key) => key in entry)
    );

    if (needsMigration) {
      await saveDeviceFeatureCache(features);
    }

    return features;
  } catch {
    return featuresWithDeviceContext({}, notesCache, deviceCache);
  }
}

export async function saveDeviceFeatureCache(cache: DeviceFeatureCache) {
  const notesCache = await readDeviceNotesCache();
  const deviceCache = await readDeviceCacheWithoutAutoDiscover();

  for (const [uid, features] of Object.entries(cache)) {
    if (features.deviceNote.trim().length > 0) {
      const noteKey = deviceNameForUid(uid, deviceCache);
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
    (device) => device.uid === deviceTag || device.deviceName === deviceTag || device.ip === deviceTag
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
    [device.uid, device.deviceName, device.ip].some((field) => field.toLowerCase().includes(normalized))
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
  const jsonModules = parseJsonStringArray(text);

  if (jsonModules) {
    return jsonModules;
  }

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

function parseJsonStringArray(text: string) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed.map((entry) => entry.trim()).filter(Boolean)
      : null;
  } catch {
    return null;
  }
}

function parseHelpLine(line: string) {
  const cleaned = line.trim().replace(/,$/, "");

  if (!cleaned) {
    return null;
  }

  const [name] = cleaned.split(/\s+/);

  if (!name || !/^[A-Za-z_]\w*$/.test(name)) {
    return null;
  }

  return cleaned;
}

export function parseModuleHelp(lines: string[]) {
  const cleaned = cleanOutputLines(lines);
  const jsonFunctions = parseJsonStringArray(cleaned.join("\n"));

  return (jsonFunctions ?? cleaned)
    .map(parseHelpLine)
    .filter((entry): entry is string => entry !== null);
}

function promptMatchesDevice(prompt: string, device: Device) {
  const promptHost = prompt.replace("$", "").trim();
  const deviceNameHost = device.deviceName.split(".")[0];
  return device.deviceName.includes("__simulator__") || promptHost === deviceNameHost;
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
      throw new Error(`Prompt mismatch: device ${this.device.deviceName}, prompt ${this.prompt}`);
    }

    if (this.password && promptData.includes("[password]")) {
      const authOutput = await this.sendCommand(this.password);
      if (authOutput.join("\n").includes("AuthFailed") || authOutput.join("\n").includes("Bye!")) {
        throw new Error(`Connection ${this.prompt} - AuthFailed`);
      }
    }

    if (this.verbose) {
      console.error(`[micrOS] connected ${this.device.deviceName} at ${this.device.ip}:${this.device.port}`);
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
    deviceName: ip
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
      deviceName: match[1]
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
    nextCache[device.uid] = {
      ip: device.ip,
      port: device.port,
      deviceName: device.deviceName
    };
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
