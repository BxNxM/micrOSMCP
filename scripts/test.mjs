#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { normalizeCommandPipeline, parseModuleHelp, parseModules } from "../dist/tools/common.js";
import { toolDefinitions } from "../dist/tools/registry.js";

const requiredPaths = [
  "AGENTS.md",
  "Dockerfile",
  "README.md",
  "package.json",
  "public/index.html",
  "scripts/docker-build.mjs",
  "scripts/start.mjs",
  "scripts/test.mjs",
  "src/index.ts",
  "src/mcp-tools.ts",
  "src/tools.ts",
  "src/tools/common.ts",
  "src/tools/definition.ts",
  "src/tools/registry.ts"
];

function assertCommand(command, args, expectedText) {
  const result = spawnSync(command, args, { encoding: "utf8" });

  if (result.error) {
    throw result.error;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${output}`);
  assert.match(output, expectedText, `${command} ${args.join(" ")} did not print expected help text`);
}

function testRequiredProjectFiles() {
  const missing = requiredPaths.filter((path) => !existsSync(path));
  assert.deepEqual(missing, [], `missing required project files: ${missing.join(", ")}`);
}

function testCliHelpEntrypoints() {
  assertCommand("node", ["scripts/start.mjs", "--help"], /Usage:/);
  assertCommand("node", ["scripts/docker-build.mjs", "--help"], /Usage:/);
}

function testToolRegistry() {
  assert.equal(toolDefinitions.length, 5, "expected five registered tools");

  const names = toolDefinitions.map((tool) => tool.name);
  assert.deepEqual([...new Set(names)], names, "tool names must be unique");

  for (const tool of toolDefinitions) {
    assert.equal(typeof tool.name, "string", "tool name must be a string");
    assert.equal(typeof tool.title, "string", `${tool.name} title must be a string`);
    assert.equal(typeof tool.description, "string", `${tool.name} description must be a string`);
    assert.equal(typeof tool.handler, "function", `${tool.name} handler must be a function`);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === "object", `${tool.name} must expose an input schema`);
  }
}

function testCommandParsing() {
  assert.deepEqual(normalizeCommandPipeline("version<a>conf webui"), ["version", "conf webui"]);
  assert.deepEqual(normalizeCommandPipeline(["version", " conf webui "]), ["version", "conf webui"]);
}

function testModuleParsing() {
  assert.deepEqual(parseModules(["['rgb', 'system', 'task']"]), ["rgb", "system", "task"]);
  assert.deepEqual(parseModules(["rgb,", " system,", " task,"]), ["rgb", "system", "task"]);
}

function testHelpParsing() {
  assert.deepEqual(parseModuleHelp([" toggle state=<True,False> smooth=True,"]), [
    {
      name: "toggle",
      parameters: ["state=<True,False>", "smooth=True"],
      signature: "toggle state=<True,False> smooth=True"
    }
  ]);
}

testRequiredProjectFiles();
testCliHelpEntrypoints();
testToolRegistry();
testCommandParsing();
testModuleParsing();
testHelpParsing();

console.log("MCP server tests passed.");
