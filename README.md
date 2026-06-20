![test-webui](./media/mcp-test-webui.png?raw=true)
![example1](./media/mcp-tools.png?raw=true)

[![DockerHub](https://img.shields.io/badge/DockerHub-micrOS%20MCP-blue)](https://hub.docker.com/r/bxnxm/micros-mcp)

<a id="top"></a>
# micrOSMCP

Standalone TypeScript MCP server and browser tester UI for micrOS devices. Use it to discover devices, inspect the device cache, run micrOS commands, and discover each device's available module commands.

<a id="table-of-contents"></a>
## Table of Contents

- [Quick Start](#quick-start)
- [Use With An MCP Client](#mcp-client)
- [Commands](#commands)
- [Tools](#tools)
  - [`run_command`](#tool-run-command)
  - [`set_device_note`](#tool-set-device-note)
  - [`search_devices`](#tool-search-devices)
  - [`discover_devices`](#tool-discover-devices)
  - [`discover_commands`](#tool-discover-commands)
- [How Tools Are Defined](#how-tools-are-defined)
  - [Add A New Tool](#add-a-new-tool)
- [Device Cache](#device-cache)
- [Docker](#docker)
- [Architecture](#architecture)
- [Requirements](#requirements)

<a id="quick-start"></a>
## Quick Start

```sh
npm install
npm run start:ui
```

Open one of the URLs printed at startup. The native tester binds on all interfaces and prints localhost plus detected LAN addresses:

```text
https://127.0.0.1:3333
https://10.0.1.42:3333
```

The tester has no authentication layer. Localhost and LAN clients can use every UI API directly, including persisted server-side API-key detection and MCP tools. Run it only on a trusted network, or set `HOST=127.0.0.1` to restrict access to the local machine. Each AI assistant response shows a compact footer with aggregate input, output, and total token usage, including all model calls made during its tool loop.

The UI is the easiest way to verify everything locally. It includes an optional AI chat panel for testing the MCP tools with an OpenAI API key, plus manual tool forms that render schemas, keep JSON arguments editable, and give device dropdowns for device-targeted tools.

Browser microphone access for the listen button requires a secure origin, so the UI automatically creates and serves HTTPS with a self-signed certificate stored in `data/ui-self-signed-cert.pem` and its private key in `data/ui-self-signed-key.pem`. The certificate includes localhost and detected LAN addresses and is reused until it expires or the address list changes. The server prints `https://` URLs for every detected local address.

Client devices must trust `data/ui-self-signed-cert.pem` before their browsers will permit microphone access. Accepting the certificate warning is sufficient in browsers that then treat the connection as secure, including Safari in typical local setups; other clients may require installing the certificate as trusted.

`MICROS_UI_CERT_HOSTS` adds IP addresses or DNS hostnames to the generated certificate. Multiple values are comma-separated:

```sh
MICROS_UI_CERT_HOSTS=gateway.local,10.0.1.42 npm run start:ui
```

The hostname must resolve to the UI host from the client device. Changing this list or the detected addresses regenerates the certificate, so clients must accept or trust the replacement certificate. The UI always uses HTTPS, even when `MICROS_UI_CERT_HOSTS` is omitted; it never falls back to HTTP. Browsers with speech recognition use live dictation; Safari falls back to recording audio and transcribing it with the saved OpenAI API key.

Stopping dictation immediately aborts browser speech recognition. A final dictation result, chat send or clear, tab hiding, and page exit also release capture. The recording fallback stops every media track before transcription, so the browser microphone indicator should turn off as soon as capture ends.

The AI chat API key, selected model, and Speak setting are saved locally by the UI server in `data/ui_chat_config.json` so reloads can reuse them. The saved key remains server-side: browser configuration responses expose only whether a key exists, never the key itself. Override the config path with `MICROS_CHAT_CONFIG_PATH` if needed. The model dropdown loads available OpenAI Chat Completions models from supported tool-calling families using the saved key; non-chat and specialized model variants are omitted because the tester's MCP bridge requires function tools. Browser speech recognition and speech synthesis are used for the optional listen/speak controls when the current browser supports them.

<a id="mcp-client"></a>
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

<a id="commands"></a>
## Commands

```sh
npm run help                  # Show start modes and environment variables
npm run build                 # Clean dist, compile TypeScript, and copy MCP metadata
npm run start                 # Start stdio MCP server from dist/
npm run start:test            # Build and run minimal MCP/tool contract tests
npm run start -- ui           # Start UI from dist/ without rebuilding
npm run start:mcp             # Explicit stdio MCP mode
MICROS_INITIALIZE_ON_START=0 npm run start:mcp  # MCP mode without startup discovery or feature scan
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
MICROS_FUNCTION_MANUAL_PATH=/path/to/sfuncman.json npm run start
MICROS_NETWORK_PREFIX=10.0.1 npm run start
MICROS_CHAT_CONFIG_PATH=/path/to/ui_chat_config.json npm run start -- ui
MICROS_UI_MAX_BODY_BYTES=12582912 npm run start -- ui
HOST=0.0.0.0 PORT=3333 npm run start -- ui
```

<a id="tools"></a>
## Tools

The MCP server exposes six tools.

| Tool | Purpose |
| --- | --- |
| `search_devices` | Primary device and feature lookup before command execution. Search cached identity, notes, modules, complete function signatures, and optional live status. |
| `list_devices` | Return a compact cached device inventory with device identity, note, and known module names only. |
| `discover_devices` | Run a fresh `/24` network discovery, update the device cache, and refresh cached features for discovered devices. |
| `run_command` | Run a command or command pipeline on one selected device. |
| `set_device_note` | Read, append, or replace the persistent note for a cached device. |
| `discover_commands` | Run `modules`, then `<module> help >json`, to map and cache a device's command surface. |

<a id="tool-run-command"></a>
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

Commands pass through a denial policy before device lookup or socket execution. Configuration reads such as `conf` and `conf webui` are allowed. Configuration writes are denied in direct and pipeline forms, including `conf webui true`, `conf<a>webui true`, and the equivalent array representation. Controlled denials return `ok: false`, the matching policy `rule`, and `deniedCommand`.

When the first word of the first command exactly matches a cached module name, case-insensitively, the response includes an optional `moduleHint`. It contains that module's complete cached function list with signatures and available `sfuncman.json` documentation:

```json
{
  "moduleHint": {
    "matchedCommands": ["dht22"],
    "modules": [
      {
        "name": "dht22",
        "functions": [
          {
            "name": "measure",
            "signature": "measure log=False",
            "doc": "Measure with dht22"
          }
        ]
      }
    ]
  }
}
```

The hint is derived from cached discovery data and may be present in both successful and failed command responses. It is omitted unless the first token of the first command matches a module exactly; a module appearing only in a later pipeline command does not produce a hint.

<a id="tool-set-device-note"></a>
### `set_device_note`

Store persistent context about a device, such as location, attached peripherals, wiring, or command interpretation hints:

```json
{
  "deviceTag": "TerraceSensor",
  "note": "Mounted on the terrace. DHT22 readings are outdoor temperature and humidity.",
  "mode": "replace"
}
```

Use `mode: "append"` to add a line without replacing the existing note. Omit `note` or send an empty value to return the current note without changing it. Notes are stored by device name in `data/device_notes_cache.json`, survive feature rediscovery, and are shown by `list_devices` and `search_devices`.

<a id="tool-search-devices"></a>
### `search_devices`

Use this as the primary device selection tool when you know part of a device name or part of a capability:

```json
{
  "query": "dht22"
}
```

The query searches cached device identity fields, persistent device notes, and cached feature metadata, including module names and complete function signatures. Set `fuzziness` to `0` for literal substring matching, `1` for conservative typo tolerance (the default), or `2` for broader matching. Very short queries remain strict at the lower levels to avoid noisy results.

Multi-word searches use two passes. The complete query is tried first and its results are returned when any device matches. If it returns no devices, the tool retries with each individual word and returns devices matching any word. The response reports `matchMode` as `query` or `words` and lists the effective `matchedTerms`.

For each matching device, modules are selected using both the active query terms and words longer than two characters from its device note. Irrelevant modules are removed, while every selected module retains its complete function signatures. Each returned function also includes `name` and, when found in `data/sfuncman.json`, `doc`.

Common use cases:

- Device identity: `{"query":"TerraceSensor","fuzziness":0}` for a precise name, UID, or IP fragment.
- Capability: `{"query":"brightness"}` to find devices whose cached module signatures expose brightness control.
- Persistent context: `{"query":"outdoor temperature"}` to search device notes as a phrase, then as `outdoor` or `temperature` only when the phrase has no matches.
- Misspelling recovery: `{"query":"temprature","fuzziness":1}` for conservative typo tolerance.
- Broad recovery: `{"query":"kitchn diming","fuzziness":2}` when multiple words may be misspelled.
- Live availability: add `"status":"online"` to return only currently reachable matches.

Require live status while searching:

```json
{
  "query": "Terrace",
  "status": "online"
}
```

In the tester UI, status defaults to `Any`; choosing `online` or `offline` performs live TCP checks only for cached devices matching the text query.

<a id="tool-discover-devices"></a>
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

<a id="tool-discover-commands"></a>
### `discover_commands`

All cached devices:

```json
{}
```

One device by UID, IP, or partial device name:

```json
{
  "deviceTag": "TinyDevBoard"
}
```

The feature cache stores each module once with compact signature strings. The response expands each function with its parsed name and optional reference documentation:

```json
{
  "name": "gameOfLife",
  "functions": [
    {
      "name": "load",
      "signature": "load w=32 h=16 custom=None",
      "doc": "Load an initial state."
    },
    {
      "name": "next_gen",
      "signature": "next_gen w=32 h=16 raw=False"
    }
  ]
}
```

Discovery requests `<module> help >json` and parses the returned JSON signature array, with a text fallback for older firmware. Response documentation is matched by module name and the first word of each signature; lookup is case-insensitive as a fallback. A missing manual, module, function, null doc, or invalid manual does not fail the tool: the `doc` field is simply omitted. Override the manual path with `MICROS_FUNCTION_MANUAL_PATH`. Legacy caches containing raw help and flattened commands are normalized into the compact structure when read. Each discovery result uses the same top-level `uid`, `ip`, `port`, `deviceName`, and `deviceNote` fields as other device tools.

Use `password` if the device requires micrOS app authentication.

<a id="how-tools-are-defined"></a>
## How Tools Are Defined

Each MCP tool is defined in one file under `mcp/tools/` plus one adjacent Markdown description file. The TypeScript file owns:

- the business function, such as `runCommand(...)`
- the MCP definition object, such as `runCommandTool`

The file basename is the metadata source of truth: `mcp/tools/run-command.ts` becomes the MCP tool `run_command` with title `Run Command`. The adjacent `mcp/tools/run-command.md` file owns the MCP-facing tool description. This keeps each tool standalone while allowing the generic MCP registrar to discover tools dynamically.

Server-level MCP instructions are stored in `mcp/description.md` and loaded at startup. The tester chat system prompt is stored separately in `ui/chat-system-prompt.md`. `mcp/mcp-tools.ts` only discovers tool modules, registers the collected definitions, and formats MCP responses. Generic MCP helper code lives in `mcp/tool-definition.ts`, `mcp/tool-loader.ts`, and `mcp/tool-registry.ts`. `mcp/tools.ts` is the public barrel for tool functions, tool definitions, and shared types.

The rough call path is:

```text
MCP client
  -> mcp/index.ts
  -> registerMcpTools() in mcp/mcp-tools.ts
  -> loadToolDefinitions() in mcp/tool-loader.ts scans mcp/tools/
  -> focused definition + implementation in mcp/tools/<tool-name>.ts
  -> description text from mcp/tools/<tool-name>.md
  -> shared micrOS helpers in mcp/tools/common.ts when needed
```

<a id="add-a-new-tool"></a>
### Add A New Tool

1. Create a focused tool file under `mcp/tools/`, for example `mcp/tools/reboot-device.ts`.
2. Define the tool input type in that same file. Put types in `mcp/tools/common.ts` only when they are genuinely shared helper types.
3. In the same file, export the business function and an `McpToolDefinition`.
4. Add `mcp/tools/reboot-device.md` with the MCP-facing description.
5. Export the function and definition from `mcp/tools.ts` when other code or tests should import them directly.
6. Add a short README entry in the tool table or tool examples.
7. Run `npm run start:test` for focused contract tests and project entrypoint checks.

Implementation example:

```ts
// mcp/tools/example-tool.ts
import { z } from "zod";
import { cacheToDevices, readDeviceCache } from "./common.js";
import { defineTool } from "../tool-definition.js";

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

export const exampleToolDefinition = defineTool<ExampleToolInput>(import.meta.url, {
  inputSchema: {
    query: z.string().optional().describe("Optional filter text.")
  },
  handler: exampleTool
});
```

Description file:

```text
Describe what the tool does for MCP clients and humans.
```

Barrel export:

```ts
// mcp/tools.ts
export type { ExampleToolInput } from "./tools/example-tool.js";
export { exampleTool, exampleToolDefinition } from "./tools/example-tool.js";
```

Tool responses should be JSON-serializable objects. If a tool can fail in a controlled way, prefer returning `{ ok: false, error: "..." }`; the generic registrar in `mcp/mcp-tools.ts` marks those responses as MCP errors when appropriate.

<a id="device-cache"></a>
## Device Cache

Default cache path:

```text
data/device_conn_cache.json
```

Cache format:

```json
{
  "device_uid": {
    "ip": "ip-address",
    "port": 9008,
    "deviceName": "device-name"
  }
}
```

If the cache is missing or invalid, the server creates it with these defaults:

- `__devuid__`: `192.168.4.1`, port `9008`, device name `__device_on_AP__`
- `__localhost__`: `127.0.0.1`, port `9008`, device name `__simulator__`

The first cache read also attempts one automatic discovery and continues with whatever cache is available. Discovery is additive: it updates discovered devices but does not delete stale cached entries.

At MCP startup, the server runs an initialization pass that scans for devices, then discovers each cached device's modules and functions. Successful feature discoveries are persisted in:

```text
data/device_feature_cache.json
```

Feature cache entries contain only discovery data. Device names remain in the connection cache, and user notes remain in the notes cache, avoiding duplicated fields across runtime files.
Legacy three-element connection arrays and feature records with duplicated metadata are migrated and overwritten in the compact format when read.

Persistent user notes are stored separately by device name in:

```text
data/device_notes_cache.json
```

Optional function documentation is read from the static `data/sfuncman.json` reference file. It enriches `search_devices`, `discover_commands`, and command module hints without being copied into the feature cache.

`list_devices` stays compact: it includes device identity, persistent notes, and known module names, but not function-level feature details. Use `search_devices` as the normal device and capability lookup before `run_command`, and `discover_commands` when cached module/function details need refreshing. Startup progress is logged to stderr so MCP stdout remains protocol-safe while clients can show that discovery is pending. Set `MICROS_INITIALIZE_ON_START=0` to skip startup initialization, for example when you need the stdio server to start without touching the network.

<a id="docker"></a>
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
docker run --rm -p 3333:3333 -e MICROS_NETWORK_PREFIX=10.0.1 -e MICROS_UI_CERT_HOSTS=gateway.local,10.0.1.42 -v micros-mcp-data:/app/data micros-mcp:latest ui
```

Set `MICROS_NETWORK_PREFIX` to your LAN `/24` prefix, such as `10.0.1`. In native host mode this prefix is auto-detected; in Docker mode it must be injected because the container usually sees Docker's network interface instead of your LAN interface.

Persist the device cache:

```sh
docker volume create micros-mcp-data

docker run --rm -i -e MICROS_NETWORK_PREFIX=10.0.1 -v micros-mcp-data:/app/data micros-mcp:latest mcp

OR

docker run --rm -p 3333:3333 -e MICROS_NETWORK_PREFIX=10.0.1 -e MICROS_UI_CERT_HOSTS=gateway.local,10.0.1.42 -v micros-mcp-data:/app/data micros-mcp:latest ui
```

Image contents:

- Included: compiled MCP server in `dist/mcp`, compiled optional UI server in `dist/ui`, UI static assets in `ui/assets`, the static function manual, `scripts/start.mjs`, `package.json`, and production `node_modules`.
- Generated at runtime: `/app/data`. The image creates this as an empty directory.
- Excluded from the Docker build context: runtime files under `data/`, `dist/`, `node_modules/`, Git metadata, and local archive files. Only `data/sfuncman.json` is admitted as static reference data; device caches, device notes, certificates, and optional UI chat config files are not copied from the local checkout into the image.

Docker network notes:

- Native mode: the server auto-detects the active local IPv4 prefix and logs it as `native/auto-detected`.
- Docker mode: pass `MICROS_NETWORK_PREFIX` and the server logs it as `containerized/injected`.
- If Docker still cannot find devices, confirm the container can route TCP traffic to micrOS devices on port `9008`. Docker Desktop, host firewalls, VPNs, or Wi-Fi client isolation can block this even when the prefix is correct.
- Native and Docker UI modes bind to `0.0.0.0:3333` by default so LAN access and published container ports work consistently. The tester has no authentication; expose it only on trusted networks, or override native mode with `HOST=127.0.0.1`. Omitting `MICROS_UI_CERT_HOSTS` does not enable HTTP.
- A container normally sees its own addresses rather than the Docker host's LAN address. Add every host LAN IP or DNS name used by clients to `MICROS_UI_CERT_HOSTS`, such as `gateway.local,10.0.1.42`.
- Ensure names such as `gateway.local` resolve to the Docker host, then open `https://gateway.local:3333`. Without a matching certificate entry, browsers report a hostname mismatch.
- Mount `/app/data` as a persistent volume to reuse the generated certificate across container restarts and avoid unnecessary certificate warnings.

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

<a id="architecture"></a>
## Architecture

MCP means Model Context Protocol. It lets a client application start this server, list available tools, and call them with structured JSON arguments.

For this project, MCP is the adapter layer between a client and micrOS devices:

```text
MCP client -> stdio -> micrOSMCP -> TCP socket -> micrOS device
```

The implementation mirrors the useful behavior of micrOS `socketClient.py` and `micrOSClient.py`, but it is standalone TypeScript and does not call Python.

Project structure:

- `mcp/`: standalone MCP stdio server. This owns tool registration, tool definitions, micrOS socket/discovery helpers, and the public tool barrel.
- `ui/`: tester mini app. This owns the local HTTPS bridge, optional AI chat bridge, and static browser assets under `ui/assets/`.
- `data/`: local runtime state plus the tracked static `sfuncman.json` function reference. Connection, feature, note, certificate, and optional UI chat config files live here by default and are ignored by git.
- `scripts/`: operational entrypoints for start modes, Docker image export, and minimal tests.
- `Dockerfile`: minimal runtime image for stdio MCP or the tester UI endpoint.

Runtime flow:

1. MCP client calls a tool, for example `run_command`.
2. `mcp/index.ts` starts the MCP server and registers tools through `mcp/mcp-tools.ts`.
3. `mcp/mcp-tools.ts` asks `mcp/tool-loader.ts` to discover tool modules from `mcp/tools/`.
4. The matching file under `mcp/tools/` owns the Zod schema, reads the cache, selects a device, opens a TCP socket if needed, and performs the micrOS operation.
5. The result is serialized as formatted JSON text and returned to the MCP client.

<a id="requirements"></a>
## Requirements

- Node.js 20 or newer.
- Network access from the host or container to micrOS devices on TCP port `9008`.
- Docker, only if you want to build or run the container image.
