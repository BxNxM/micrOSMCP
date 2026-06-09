#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const requiredPaths = [
  "Dockerfile",
  "README.md",
  "package.json",
  "scripts/start.mjs",
  "scripts/docker-build.mjs",
  "src/index.ts",
  "src/mcp-tools.ts",
  "src/tools.ts",
  "src/tools/common.ts",
  "public/index.html"
];

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

try {
  const missing = requiredPaths.filter((path) => !existsSync(path));

  if (missing.length > 0) {
    throw new Error(`Missing required project files:\n${missing.map((path) => `- ${path}`).join("\n")}`);
  }

  run("npm", ["run", "build"]);
  run("node", ["scripts/start.mjs", "--help"]);
  run("node", ["scripts/docker-build.mjs", "--help"]);

  console.log("Project check passed.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
