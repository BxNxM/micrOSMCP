import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

export type DeviceStatus = "online" | "offline";

export type Device = {
  uid: string;
  ip: string;
  port: number;
  fuid: string;
  status?: DeviceStatus | "unknown";
};

export type DeviceCache = Record<string, [string, number, string]>;

export type DiscoverDevicesOptions = {
  port?: number;
  networkPrefix?: string;
  startHost?: number;
  endHost?: number;
  concurrency?: number;
  timeoutMs?: number;
};

export const deviceCachePath =
  process.env.MICROS_DEVICE_CACHE_PATH ??
  fileURLToPath(new URL("../../data/device_conn_cache.json", import.meta.url));
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

export function cacheToDevices(cache: DeviceCache): Device[] {
  return Object.entries(cache).map(([uid, [ip, port, fuid]]) => ({
    uid,
    ip,
    port,
    fuid
  }));
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

export function getLocalNetworkPrefix() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address.split(".").slice(0, 3).join(".");
      }
    }
  }

  return null;
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
  const openHosts = await scanOpenPort({
    port,
    networkPrefix: input.networkPrefix ?? getLocalNetworkPrefix(),
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
    networkPrefix: input.networkPrefix ?? getLocalNetworkPrefix(),
    openHosts,
    discovered,
    updatedCache: nextCache,
    cachePath: deviceCachePath
  };
}
