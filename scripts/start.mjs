#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "help";

const modes = {
  mcp: {
    file: "dist/index.js",
    description: "Start the stdio MCP server. Use this mode from MCP client config."
  },
  ui: {
    file: "dist/ui.js",
    description: "Start the local browser test UI. The UI starts an internal MCP bridge."
  },
  "test-ui": {
    file: "dist/ui.js",
    description: "Alias for ui."
  }
};

function printHelp() {
  console.error(`Usage:
  node scripts/start.mjs mcp
  node scripts/start.mjs ui

Modes:
  mcp      ${modes.mcp.description}
  ui       ${modes.ui.description}

Build first:
  npm run build
`);
}

if (mode === "help" || mode === "--help" || mode === "-h") {
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
