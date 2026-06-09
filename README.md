# micrOSMCP

Standalone TypeScript MCP server for micrOS devices. It exposes device discovery, cache inspection, command execution, and command-surface discovery as Model Context Protocol tools.

## What MCP Is

MCP means Model Context Protocol. It is a protocol for connecting a client application to external tools and data sources.

An MCP client can be an AI assistant, desktop app, IDE, or any program that understands MCP. The client starts an MCP server process, asks it which tools are available, and calls those tools with structured JSON arguments.

For this project, MCP is the adapter layer between a client and micrOS devices:

- The MCP client does not need to know the micrOS TCP protocol.
- The MCP client sees named tools with JSON schemas.
- The server owns device discovery, cache management, socket connections, prompt parsing, and command execution.
- Tool responses are returned as text content containing formatted JSON.

## Architecture

The MCP server runs over stdio. The MCP client launches the server and communicates through standard input/output. The server then talks to micrOS devices over TCP:

```text
MCP client -> stdio -> micrOSMCP -> TCP socket -> micrOS device
```

The implementation mirrors the useful behavior of micrOS `socketClient.py` and `micrOSClient.py`, but it is standalone TypeScript and does not call Python.

Project structure:

- `src/index.ts`: minimal MCP stdio bootstrap.
- `src/mcp-tools.ts`: MCP tool registration, names, descriptions, schemas, and response formatting.
- `src/tools.ts`: collection barrel that re-exports the tool implementations.
- `src/tools/`: individual tool implementations and reusable micrOS helpers.
- `src/tools/common.ts`: shared device cache, socket client, discovery, parsing, and concurrency helpers.
- `src/ui.ts`: local HTTP server for the browser tester UI.
- `public/`: browser UI files for calling MCP tools without an AI client.
- `scripts/start.mjs`: mode-aware starter for compiled MCP or UI entrypoints.
- `data/device_conn_cache.json`: project-local micrOS device cache, created at runtime when needed.
- `package.json`: npm scripts, package metadata, and the `microsmcp` binary entry.

Runtime flow for a tool call:

1. MCP client calls a tool, for example `run_command`.
2. `src/index.ts` starts the MCP server and registers tools through `src/mcp-tools.ts`.
3. `src/mcp-tools.ts` validates input through the MCP SDK/Zod schema and calls the matching function from `src/tools.ts`.
4. The matching file under `src/tools/` reads the cache, selects a device, opens a TCP socket if needed, and performs the micrOS operation.
5. The result is serialized as formatted JSON text and returned to the MCP client.

To add another tool, create a focused file under `src/tools/`, export it from `src/tools.ts`, then register its MCP schema in `src/mcp-tools.ts`. Shared micrOS behavior should stay in `src/tools/common.ts` only when it is useful to more than one tool.

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

Override the cache path:

```sh
MICROS_DEVICE_CACHE_PATH=/path/to/device_conn_cache.json npm run start
```

## Tools

The MCP server exposes five tools.

### `list_devices`

Returns the project-local cache.

Arguments:

```json
{}
```

### `filter_devices`

Filters cached devices by UID, FUID, IP, or port. It can optionally perform live online/offline checks.

Example:

```json
{
  "query": "Tiny",
  "includeStatus": true
}
```

### `discover_devices`

Scans a `/24` network range, checks the micrOS TCP port, sends `hello`, parses UID/FUID, and updates the cache.

Example:

```json
{
  "networkPrefix": "10.0.1",
  "startHost": 2,
  "endHost": 254,
  "port": 9008,
  "timeoutMs": 1000,
  "concurrency": 50
}
```

If `networkPrefix` is omitted, the server uses the active local IPv4 interface.

### `run_command`

Selects a device by UID, FUID, or IP and runs a micrOS command pipeline over TCP.

Command pipelines support the micrOS `<a>` separator:

```json
{
  "deviceTag": "TinyDevBoard",
  "command": "version<a>conf webui"
}
```

Or an array:

```json
{
  "deviceTag": "TinyDevBoard",
  "command": ["version", "conf webui"]
}
```

Use read-only commands such as `version` for smoke tests. Other micrOS commands may change device state.

### `discover_commands`

Discovers the available micrOS command surface for cached devices. It runs `modules`, parses the module list, then runs `<module> help` for each module.

Discover commands on all cached devices:

```json
{}
```

Discover commands on one device by UID, FUID, IP, or partial device name:

```json
{
  "deviceName": "TinyDevBoard"
}
```

Optional arguments:

```json
{
  "deviceName": "TinyDevBoard",
  "timeout": 10,
  "concurrency": 3
}
```

`deviceTag` is also accepted as an alias for `deviceName`. Use `password` if the device requires micrOS app authentication.

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

## Install

```sh
npm install
npm run build
```

Node.js `20` or newer is required.

## Start The MCP Server

Build first, then start the compiled stdio MCP server in a terminal:

```sh
npm run build
npm run start
```

`npm run start` is equivalent to:

```sh
node scripts/start.mjs mcp
```

For MCP client configuration, prefer the direct starter or npm's silent mode so npm does not print lifecycle banners to stdout before the MCP protocol starts:

```sh
npm run --silent start
```

Other useful start commands:

```sh
npm run start:mcp
npm run start:ui
npm run ui
```

Use `node scripts/start.mjs mcp` or `npm run --silent start` from MCP client configuration. Use `npm run start:ui` when you want the local browser tester. The UI command builds first, then starts an HTTP tester that launches an internal MCP bridge.

Development command:

```sh
npm run dev
```

`npm run dev` starts the TypeScript MCP server directly with `tsx`. It is useful while developing, but the compiled `npm run start` path is the safer choice for MCP client configuration.

## Tester UI

Run a local UI for testing tools without an AI client:

```sh
npm run start:ui
```

Open the printed URL, usually:

```text
http://127.0.0.1:3333
```

The UI renders parameter fields from MCP schemas, keeps an editable JSON payload in sync, and provides cached-device dropdowns for device-targeted tools.

## MCP Client Config

Codex-style MCP config:

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

You can also call the starter directly:

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

Run `npm run build` after TypeScript changes so `npm run start` has current compiled files.
