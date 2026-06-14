#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deviceSearchFields,
  normalizeCommandPipeline,
  parseModuleHelp,
  parseModules,
  pruneDeviceFeaturesForQuery
} from "../dist/mcp/tools/common.js";
import { askUser } from "../dist/mcp/tools/ask-user.js";
import { toolDefinitions } from "../dist/mcp/tools/registry.js";

const requiredPaths = [
  "AGENTS.md",
  "Dockerfile",
  "README.md",
  "package.json",
  "scripts/docker-build.mjs",
  "scripts/start.mjs",
  "scripts/test.mjs",
  "mcp/initialize.ts",
  "mcp/index.ts",
  "mcp/mcp-tools.ts",
  "mcp/tools.ts",
  "mcp/tools/ask-user.ts",
  "mcp/tools/common.ts",
  "mcp/tools/definition.ts",
  "mcp/tools/registry.ts",
  "ui/assets/app.js",
  "ui/assets/chat.css",
  "ui/assets/chat.js",
  "ui/assets/index.html",
  "ui/assets/styles.css",
  "ui/chat-bridge.ts",
  "ui/server.ts"
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
  assert.equal(toolDefinitions.length, 6, "expected six registered tools");

  const names = toolDefinitions.map((tool) => tool.name);
  assert.deepEqual([...new Set(names)], names, "tool names must be unique");
  assert.equal(names[0], "filter_devices", "filter_devices should be the first/default device selection tool");
  assert.ok(names.includes("ask_user"), "ask_user should be available for required human clarification");

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

async function testAskUserTool() {
  assert.deepEqual(await askUser({ question: "Which device should I target?", choices: ["A", "B"] }), {
    ok: true,
    needsUserInput: true,
    question: "Which device should I target?",
    reason: null,
    choices: ["A", "B"]
  });
}

function testFeatureSearchFields() {
  const features = {
    discoveredAt: "2026-06-14T00:00:00.000Z",
    modulesCommand: "modules",
    rawModules: ["['dht22', 'rgb']"],
    modules: [
      {
        name: "dht22",
        helpCommand: "dht22 help",
        rawHelp: ["measure"],
        functions: [
          {
            name: "measure",
            parameters: ["temperature=True"],
            signature: "measure temperature=True"
          }
        ]
      },
      {
        name: "rgb",
        helpCommand: "rgb help",
        rawHelp: ["toggle"],
        functions: [
          {
            name: "toggle",
            parameters: [],
            signature: "toggle"
          }
        ]
      }
    ],
    commands: [
      {
        module: "dht22",
        function: "measure",
        parameters: ["temperature=True"],
        command: "dht22 measure temperature=True",
        signature: "measure temperature=True"
      },
      {
        module: "rgb",
        function: "toggle",
        parameters: [],
        command: "rgb toggle",
        signature: "toggle"
      }
    ]
  };
  const fields = deviceSearchFields({
    uid: "micr123OS",
    ip: "10.0.1.20",
    port: 9008,
    fuid: "TerraceSensor",
    features
  });
  const pruned = pruneDeviceFeaturesForQuery(features, "dht22");

  assert.ok(fields.includes("TerraceSensor"), "device fields should include FUID");
  assert.ok(fields.includes("dht22"), "device fields should include discovered module names");
  assert.ok(fields.includes("dht22 measure temperature=True"), "device fields should include command text");
  assert.deepEqual(pruned.modules.map((module) => module.name), ["dht22"], "feature pruning should keep matching modules only");
  assert.deepEqual(pruned.commands.map((command) => command.command), ["dht22 measure temperature=True"], "feature pruning should keep matching commands only");
}

async function testListDevicesCompactShape() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-test-"));
  const deviceCachePath = join(tempDir, "devices.json");
  const featureCachePath = join(tempDir, "features.json");

  writeFileSync(
    deviceCachePath,
    JSON.stringify({
      micr123OS: ["10.0.1.20", 9008, "TerraceSensor"]
    })
  );
  writeFileSync(
    featureCachePath,
    JSON.stringify({
      micr123OS: {
        discoveredAt: "2026-06-14T00:00:00.000Z",
        modulesCommand: "modules",
        rawModules: ["['dht22']"],
        modules: [
          {
            name: "dht22",
            helpCommand: "dht22 help",
            rawHelp: ["measure"],
            functions: [
              {
                name: "measure",
                parameters: ["temperature=True"],
                signature: "measure temperature=True"
              }
            ]
          }
        ],
        commands: [
          {
            module: "dht22",
            function: "measure",
            parameters: ["temperature=True"],
            command: "dht22 measure temperature=True",
            signature: "measure temperature=True"
          }
        ]
      }
    })
  );

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const mod = await import('./dist/mcp/tools/list-devices.js'); const result = await mod.listDevices(); console.log(JSON.stringify(result));"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MICROS_DEVICE_CACHE_PATH: deviceCachePath,
        MICROS_DEVICE_FEATURE_CACHE_PATH: featureCachePath
      }
    }
  );

  assert.equal(result.status, 0, `listDevices compact shape check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const device = parsed.devices.find((entry) => entry.uid === "micr123OS");

  assert.ok(device, "expected test device in compact list");
  assert.deepEqual(device.modules, ["dht22"], "list_devices should expose known module names");
  assert.equal(device.moduleCount, 1, "list_devices should expose module count");
  assert.equal("features" in device, false, "list_devices should not expose full feature details");
  assert.equal("featureCache" in parsed, false, "list_devices should not expose the full feature cache");
  assert.equal("micrOSCache" in parsed, false, "list_devices should not duplicate the raw device cache");
}

testRequiredProjectFiles();
testCliHelpEntrypoints();
testToolRegistry();
testCommandParsing();
testModuleParsing();
testHelpParsing();
await testAskUserTool();
testFeatureSearchFields();
await testListDevicesCompactShape();

console.log("MCP server tests passed.");
