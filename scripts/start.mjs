#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const helpRequested = args.includes("--help") || args.includes("-h") || args.includes("help");
const mode = helpRequested ? "help" : args[0] ?? "mcp";

const modes = {
  mcp: {
    file: "dist/mcp/index.js",
    description: "Start the stdio MCP server. Use this mode from MCP client config."
  },
  ui: {
    file: "dist/ui/server.js",
    description: "Start the local browser test UI. The UI starts an internal MCP bridge."
  },
  "test-ui": {
    file: "dist/ui/server.js",
    description: "Alias for ui."
  }
};

function printHelp() {
  console.error(`Usage:
  npm run start
  npm run start -- --help
  npm run start -- ui
  npm run start:mcp
  npm run start:ui

Direct:
  node scripts/start.mjs
  node scripts/start.mjs mcp
  node scripts/start.mjs ui

Modes:
  mcp      ${modes.mcp.description}
  ui       ${modes.ui.description}
  test-ui  ${modes["test-ui"].description}

Environment:
  MICROS_DEVICE_CACHE_PATH          Override data/device_conn_cache.json.
  MICROS_DEVICE_FEATURE_CACHE_PATH  Override data/device_feature_cache.json.
  MICROS_DEVICE_NOTES_CACHE_PATH    Override data/device_notes_cache.json.
  MICROS_NETWORK_PREFIX             Override automatic /24 discovery prefix, e.g. 10.0.1.
  MICROS_CHAT_CONFIG_PATH           Override data/ui_chat_config.json for the tester web app.
  HOST                              UI bind host. Default: 0.0.0.0.
  PORT                              UI port. Default: 3333.

Examples:
  MICROS_DEVICE_CACHE_PATH=/tmp/device_conn_cache.json npm run start
  MICROS_DEVICE_NOTES_CACHE_PATH=/tmp/device_notes_cache.json npm run start
  MICROS_NETWORK_PREFIX=10.0.1 npm run start
  MICROS_CHAT_CONFIG_PATH=/tmp/ui_chat_config.json npm run start -- ui
  HOST=127.0.0.1 PORT=3333 npm run start -- ui

Build first:
  npm run build
`);
}

if (mode === "help") {
  printHelp();
  process.exit(0);
}

const selected = modes[mode];

if (!selected) {
  console.error(`Unknown mode: ${mode}`);
  printHelp();
  process.exit(1);
}

const entry = resolve(rootDir, selected.file);

if (!existsSync(entry)) {
  console.error(`Missing ${selected.file}. Run npm run build first.`);
  process.exit(1);
}

const child = spawn(process.execPath, [entry], {
  cwd: rootDir,
  env: process.env,
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
