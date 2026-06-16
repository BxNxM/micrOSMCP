![test-webui](./media/mcp-test-webui.png?raw=true)
![example1](./media/mcp-tools.png?raw=true)

# micrOSMCP

Standalone TypeScript MCP server and browser tester UI for micrOS devices. Use it to discover devices, inspect the device cache, run micrOS commands, and discover each device's available module commands.

## Quick Start

```sh
npm install
npm run start:ui
```

Open one of the printed URLs. The UI binds on all interfaces by default and prints localhost plus any detected LAN addresses, such as:

```text
http://127.0.0.1:3333
http://10.0.1.42:3333
```

The UI is the easiest way to verify everything locally. It includes an optional AI chat panel for testing the MCP tools with an OpenAI API token, plus manual tool forms that render schemas, keep JSON arguments editable, and give device dropdowns for device-targeted tools.

Browser microphone access for the listen button requires a secure origin. Use the printed `127.0.0.1` URL on the host machine, or serve the UI over HTTPS; plain `http://10.0.1.x` LAN URLs usually disable microphone input in the browser. Browsers with speech recognition use live dictation; Safari falls back to recording audio and transcribing it with the saved OpenAI token.

The AI chat token is saved locally by the UI server in `data/ui_chat_config.json` so reloads can reuse it. Override that path with `MICROS_CHAT_CONFIG_PATH` if you want to keep the token somewhere else. The model dropdown loads available LLM-style OpenAI models for the saved token. Browser speech recognition and speech synthesis are used for the optional listen/speak controls when the current browser supports them.

## Use With An MCP Client

Build first:

```sh
npm install
npm run build
```

Codex-style `config.toml`:

```toml
[mcp_servers.microsmcp]
command = "npm"
args = ["run", "--silent", "start"]
cwd = "/Users/bnm/Development/micrOSMCP"
```

Generic JSON-style MCP config:

```json
{
  "mcpServers": {
    "microsmcp": {
      "command": "npm",
      "args": ["run", "--silent", "start"],
      "cwd": "/Users/bnm/Development/micrOSMCP"
    }
  }
}
```

Use `--silent` with npm in MCP client config so npm does not print lifecycle banners to stdout before the MCP protocol starts. The direct equivalent is:

```json
{
  "mcpServers": {
    "microsmcp": {
      "command": "node",
      "args": ["/Users/bnm/Development/micrOSMCP/scripts/start.mjs", "mcp"],
      "cwd": "/Users/bnm/Development/micrOSMCP"
    }
  }
}
```

## Commands

```sh
npm run help                  # Show start modes and environment variables
npm run build                 # Compile TypeScript into dist/
npm run start                 # Start stdio MCP server from dist/
npm run start:test            # Build and run minimal MCP/tool contract tests
npm run start -- ui           # Start UI from dist/ without rebuilding
npm run start:mcp             # Explicit stdio MCP mode
npm run start:ui              # Build, then start the browser tester UI
npm run docker:build          # Build and export Docker image tar
```

Forwarded start help:

```sh
npm run start -- --help
```

Useful environment variables:

```sh
MICROS_DEVICE_CACHE_PATH=/path/to/device_conn_cache.json npm run start
MICROS_DEVICE_FEATURE_CACHE_PATH=/path/to/device_feature_cache.json npm run start
MICROS_DEVICE_NOTES_CACHE_PATH=/path/to/device_notes_cache.json npm run start
MICROS_NETWORK_PREFIX=10.0.1 npm run start
MICROS_CHAT_CONFIG_PATH=/path/to/ui_chat_config.json npm run start -- ui
HOST=0.0.0.0 PORT=3333 npm run start -- ui
```

## Tools

The MCP server exposes six tools.

| Tool | Purpose |
| --- | --- |
| `filter_devices` | Main device selection tool: filter cached devices by name, UID, IP, note, module, function, command, feature text, and optional live status. Feature-query results are pruned to relevant modules. |
| `list_devices` | Return a compact cached device inventory with device identity, note, and known module names only. |
| `discover_devices` | Run a fresh `/24` network discovery, update the device cache, and refresh cached features for discovered devices. |
| `run_command` | Run a command or command pipeline on one selected device. |
| `set_device_note` | Add, append, replace, or clear persistent notes for a cached device. |
| `discover_commands` | Run `modules`, then `<module> help`, to map and cache a device's command surface. |

### `run_command`

String pipeline using the micrOS `<a>` separator:

```json
{
  "deviceTag": "TinyDevBoard",
  "command": "version<a>conf webui"
}
```

Array pipeline:

```json
{
  "deviceTag": "TinyDevBoard",
  "command": ["version", "conf webui"]
}
```

Use read-only commands such as `version` for smoke tests. Other micrOS commands may change device state.

### `set_device_note`

Store persistent context about a device, such as location, attached peripherals, wiring, or command interpretation hints:

```json
{
  "deviceTag": "TerraceSensor",
  "note": "Mounted on the terrace. DHT22 readings are outdoor temperature and humidity.",
  "mode": "replace"
}
```

Use `mode: "append"` to add a line without replacing existing notes, or `mode: "clear"` to remove the note. Notes are stored by device name in `data/device_notes_cache.json`, survive feature rediscovery, and are shown by `list_devices` and `filter_devices`.

### `filter_devices`

Use this as the primary device selection tool when you know part of a device name or part of a capability:

```json
{
  "query": "dht22"
}
```

The query matches cached device identity fields, persistent device notes, and cached feature metadata, including module names, function names, command signatures, parameters, and raw help text. Matching devices include `deviceNote` plus cached `features` when available. If the query matches the device identity, full features are returned; if it matches a note, feature, module, or command, irrelevant modules and commands are removed to keep context compact.

Check live status while filtering:

```json
{
  "query": "Terrace",
  "includeStatus": true
}
```

### `discover_devices`

```json
{
  "networkPrefix": "10.0.1",
  "startHost": 2,
  "endHost": 254,
  "port": 9008,
  "timeoutMs": 1000,
  "concurrency": 50,
  "refreshFeatures": true,
  "featureTimeout": 3,
  "featureConcurrency": 3
}
```

If `networkPrefix` is omitted, the server uses `MICROS_NETWORK_PREFIX` when set, otherwise the active local IPv4 interface. Startup logs whether the scan prefix was native auto-detected or injected through the environment for container mode.

Discovery is a fresh network scan every time this tool runs. By default, it also refreshes the feature cache for newly discovered devices, but the tool response stays compact with module and command counts rather than full function details. Set `refreshFeatures` to `false` when you only want to update device addresses. Use `featureConcurrency` to control how many discovered devices are inspected in parallel during feature refresh.

### `discover_commands`

All cached devices:

```json
{}
```

One device by UID, FUID, IP, or partial device name:

```json
{
  "deviceTag": "TinyDevBoard"
}
```

The response includes per-module raw help plus a flattened `commands` list:

```json
{
  "module": "gameOfLife",
  "function": "load",
  "parameters": ["w=32", "h=16", "custom=None"],
  "command": "gameOfLife load w=32 h=16 custom=None",
  "signature": "load w=32 h=16 custom=None"
}
```

Use `password` if the device requires micrOS app authentication.

## How Tools Are Defined

Each MCP tool is defined in one file under `mcp/tools/`. That file owns both:

- the business function, such as `runCommand(...)`
- the MCP definition object, such as `runCommandTool`

That keeps the tool name, title, description, Zod input schema, and behavior together. `mcp/mcp-tools.ts` only registers the collected definitions and formats MCP responses. `mcp/tools.ts` is the public barrel for tool functions, tool definitions, and shared types.

The rough call path is:

```text
MCP client
  -> mcp/index.ts
  -> registerMicrOSTools() in mcp/mcp-tools.ts
  -> toolDefinitions from mcp/tools/registry.ts
  -> focused definition + implementation in mcp/tools/<tool-name>.ts
  -> shared micrOS helpers in mcp/tools/common.ts when needed
```

### Add A New Tool

1. Create a focused tool file under `mcp/tools/`, for example `mcp/tools/reboot-device.ts`.
2. Define the tool input type in that same file. Put types in `mcp/tools/common.ts` only when they are genuinely shared helper types.
3. In the same file, export the business function and a `MicrOSToolDefinition`.
4. Add the `*Tool` definition to `mcp/tools/registry.ts`.
5. Export the function and definition from `mcp/tools.ts`.
6. Add a short README entry in the tool table or tool examples.
7. Run `npm run start:test` for focused contract tests and project entrypoint checks.

Implementation example:

```ts
// mcp/tools/example-tool.ts
import { z } from "zod";
import { cacheToDevices, readDeviceCache } from "./common.js";
import { defineTool } from "./definition.js";

export type ExampleToolInput = {
  query?: string;
};

export async function exampleTool(input: ExampleToolInput = {}) {
  const cache = await readDeviceCache();
  const devices = cacheToDevices(cache);

  return {
    query: input.query ?? null,
    count: devices.length,
    devices
  };
}

export const exampleToolDefinition = defineTool<ExampleToolInput>({
  name: "example_tool",
  title: "Example Tool",
  description: "Describe what the tool does for MCP clients and humans.",
  inputSchema: {
    query: z.string().optional().describe("Optional filter text.")
  },
  handler: exampleTool
});
```

Registry export:

```ts
// mcp/tools/registry.ts
import { exampleToolDefinition } from "./example-tool.js";

export const toolDefinitions = [
  // existing tools...
  exampleToolDefinition
];
```

Barrel export:

```ts
// mcp/tools.ts
export type { ExampleToolInput } from "./tools/example-tool.js";
export { exampleTool, exampleToolDefinition } from "./tools/example-tool.js";
```

Tool responses should be JSON-serializable objects. If a tool can fail in a controlled way, prefer returning `{ ok: false, error: "..." }`; the generic registrar in `mcp/mcp-tools.ts` marks those responses as MCP errors when appropriate.

## Device Cache

Default cache path:

```text
data/device_conn_cache.json
```

Cache format:

```json
{
  "device_uid": ["ip-address", 9008, "device-fuid"]
}
```

If the cache is missing or invalid, the server creates it with these defaults:

- `__devuid__`: `192.168.4.1`, port `9008`, FUID `__device_on_AP__`
- `__localhost__`: `127.0.0.1`, port `9008`, FUID `__simulator__`

The first cache read also attempts one automatic discovery and continues with whatever cache is available. Discovery is additive: it updates discovered devices but does not delete stale cached entries.

At MCP startup, the server runs an initialization pass that scans for devices, then discovers each cached device's modules and functions. Successful feature discoveries are persisted in:

```text
data/device_feature_cache.json
```

Feature cache entries include the readable `deviceName` for quick inspection. User notes are not stored there.

Persistent user notes are stored separately by device name in:

```text
data/device_notes_cache.json
```

`list_devices` stays compact: it includes device identity, persistent notes, and known module names, but not function-level feature details. Use `filter_devices` for targeted feature lookup and `discover_commands` for full module/function details. Startup progress is logged to stderr so MCP stdout remains protocol-safe while clients can show that discovery is pending. Set `MICROS_INITIALIZE_ON_START=0` to skip startup initialization, for example when you need the stdio server to start without touching the network.

## Docker

Build and export a standalone Docker image archive:

```sh
npm run docker:build
```

Defaults:

```text
image: micros-mcp:latest
export: dist/micros-mcp_latest.tar.gz
```

The exported archive is a standard `docker save` artifact. Load it with `docker load` on another machine, then run the `micros-mcp:<tag>` image.

Customize:

```sh
npm run docker:build -- --image micros-mcp:dev
npm run docker:build -- --output dist/micros-mcp.tar
npm run docker:build -- --image micros-mcp:dev --output dist/micros-mcp_dev.tar.gz
```

Install an exported image on another machine:

```sh
docker load -i dist/micros-mcp_latest.tar.gz
```

Publish a public Docker Hub image:

```sh
docker login
docker build -t bxnxm/micros-mcp:latest .
docker push bxnxm/micros-mcp:latest
```

For a public multi-architecture image that supports common 64-bit Intel/AMD and ARM hosts, build and push with `buildx`:

```sh
docker login
docker buildx create --use
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t bxnxm/micros-mcp:latest \
  --push \
  .
```

The archive workflow above exports the image for the local Docker builder's platform. The `buildx` publish flow creates a registry manifest so compatible hosts pull the right architecture automatically.

Run as stdio MCP in Docker:

```sh
docker run --rm -i -e MICROS_NETWORK_PREFIX=10.0.1 -v micros-mcp-data:/app/data micros-mcp:latest mcp
```

Run the tester UI endpoint in Docker:

```sh
docker run --rm -p 3333:3333 -e MICROS_NETWORK_PREFIX=10.0.1 -v micros-mcp-data:/app/data micros-mcp:latest ui
```

Set `MICROS_NETWORK_PREFIX` to your LAN `/24` prefix, such as `10.0.1`. In native host mode this prefix is auto-detected; in Docker mode it must be injected because the container usually sees Docker's network interface instead of your LAN interface.

Persist the device cache:

```sh
docker volume create micros-mcp-data
docker run --rm -i -e MICROS_NETWORK_PREFIX=10.0.1 -v micros-mcp-data:/app/data micros-mcp:latest mcp
docker run --rm -p 3333:3333 -e MICROS_NETWORK_PREFIX=10.0.1 -v micros-mcp-data:/app/data micros-mcp:latest ui
```

Image contents:

- Included: compiled MCP server in `dist/mcp`, compiled optional UI server in `dist/ui`, UI static assets in `ui/assets`, `scripts/start.mjs`, `package.json`, and production `node_modules`.
- Generated at runtime: `/app/data`. The image creates this as an empty directory.
- Excluded from the Docker build context: local `data/` contents, `dist/`, `node_modules/`, Git metadata, and local archive files. Device caches, device notes, and optional UI chat config files are sensitive runtime data and are not copied from the local checkout into the image.

Docker network notes:

- Native mode: the server auto-detects the active local IPv4 prefix and logs it as `native/auto-detected`.
- Docker mode: pass `MICROS_NETWORK_PREFIX` and the server logs it as `containerized/injected`.
- If Docker still cannot find devices, confirm the container can route TCP traffic to micrOS devices on port `9008`. Docker Desktop, host firewalls, VPNs, or Wi-Fi client isolation can block this even when the prefix is correct.
- The UI binds to `0.0.0.0:3333` by default in native and Docker modes. In Docker, `-p 3333:3333` exposes it on the host; use the host's `http://127.0.0.1:3333` or LAN IP from outside the container.

Docker MCP client config:

```json
{
  "mcpServers": {
    "microsmcp": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "MICROS_NETWORK_PREFIX=10.0.1",
        "-v",
        "micros-mcp-data:/app/data",
        "micros-mcp:latest",
        "mcp"
      ]
    }
  }
}
```

## Architecture

MCP means Model Context Protocol. It lets a client application start this server, list available tools, and call them with structured JSON arguments.

For this project, MCP is the adapter layer between a client and micrOS devices:

```text
MCP client -> stdio -> micrOSMCP -> TCP socket -> micrOS device
```

The implementation mirrors the useful behavior of micrOS `socketClient.py` and `micrOSClient.py`, but it is standalone TypeScript and does not call Python.

Project structure:

- `mcp/`: standalone MCP stdio server. This owns tool registration, tool definitions, micrOS socket/discovery helpers, and the public tool barrel.
- `ui/`: tester mini app. This owns the local HTTP bridge, optional AI chat bridge, and static browser assets under `ui/assets/`.
- `data/`: local runtime state. The device cache and optional UI chat config live here by default and are ignored by git.
- `scripts/`: operational entrypoints for start modes, Docker image export, and minimal tests.
- `Dockerfile`: minimal runtime image for stdio MCP or the tester UI endpoint.

Runtime flow:

1. MCP client calls a tool, for example `run_command`.
2. `mcp/index.ts` starts the MCP server and registers tools through `mcp/mcp-tools.ts`.
3. `mcp/mcp-tools.ts` registers the collected definitions from `mcp/tools/registry.ts`.
4. The matching file under `mcp/tools/` owns the Zod schema, reads the cache, selects a device, opens a TCP socket if needed, and performs the micrOS operation.
5. The result is serialized as formatted JSON text and returned to the MCP client.

## Requirements

- Node.js 20 or newer.
- Network access from the host or container to micrOS devices on TCP port `9008`.
- Docker, only if you want to build or run the container image.
