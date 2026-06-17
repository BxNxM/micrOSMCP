#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deviceSearchFields,
  normalizeCommandPipeline,
  parseModuleHelp,
  parseModules,
  pruneDeviceFeaturesForQuery
} from "../dist/mcp/tools/common.js";
import { toolDefinitions } from "../dist/mcp/tool-registry.js";
import { accessUrls, ensureSelfSignedCertificate } from "../dist/ui/server.js";
import {
  audioRecordingSupport,
  shouldSubmitChatOnKeyDown,
  speechRecognitionSupport,
  toolEventTitle
} from "../ui/assets/chat.js";

const requiredPaths = [
  "AGENTS.md",
  "Dockerfile",
  "README.md",
  "package.json",
  "scripts/clean-dist.mjs",
  "scripts/docker-build.mjs",
  "scripts/copy-mcp-metadata.mjs",
  "scripts/start.mjs",
  "scripts/test.mjs",
  "mcp/description.md",
  "mcp/initialize.ts",
  "mcp/index.ts",
  "mcp/metadata.ts",
  "mcp/mcp-tools.ts",
  "mcp/tool-definition.ts",
  "mcp/tool-loader.ts",
  "mcp/tool-registry.ts",
  "mcp/tools.ts",
  "mcp/tools/common.ts",
  "mcp/tools/set-device-note.ts",
  "ui/assets/app.js",
  "ui/assets/chat.css",
  "ui/assets/chat.js",
  "ui/assets/index.html",
  "ui/assets/styles.css",
  "ui/chat-system-prompt.md",
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

function listMarkdownFiles(dir) {
  const files = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      files.push(...listMarkdownFiles(path));
    } else if (path.endsWith(".md")) {
      files.push(path);
    }
  }

  return files;
}

function testMcpMetadataFilesCopied() {
  for (const sourcePath of listMarkdownFiles("mcp")) {
    const distPath = `dist/${sourcePath}`;

    assert.ok(existsSync(distPath), `${distPath} should be copied by npm run build`);
    assert.equal(readFileSync(distPath, "utf8"), readFileSync(sourcePath, "utf8"), `${distPath} should match ${sourcePath}`);
  }
}

function testDockerExcludesRuntimeData() {
  const dockerignore = readFileSync(".dockerignore", "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const dockerfile = readFileSync("Dockerfile", "utf8");

  assert.ok(
    dockerignore.includes("data") || dockerignore.includes("data/") || dockerignore.includes("data/**"),
    ".dockerignore must exclude local data/ runtime state from the Docker build context"
  );
  assert.doesNotMatch(dockerfile, /^\s*COPY\s+(?:--\S+\s+)*data(?:\s|\/)/m, "Dockerfile must not copy local data/");
  assert.match(dockerfile, /^\s*RUN\s+mkdir\s+-p\s+data\s*$/m, "Docker image may only create an empty data directory");
  assert.match(dockerfile, /^\s*COPY\s+media\s+\.\/media\s*$/m, "Docker build stage should include UI media assets");
  assert.match(
    dockerfile,
    /^\s*COPY\s+--from=build\s+\/app\/media\s+\.\/media\s*$/m,
    "Docker runtime should include UI media assets"
  );
}

function testCliHelpEntrypoints() {
  assertCommand("node", ["scripts/start.mjs", "--help"], /Usage:/);
  assertCommand("node", ["scripts/docker-build.mjs", "--help"], /Usage:/);
}

function testNetworkPrefixEnvironmentOverride() {
  const result = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      "const mod = await import('./dist/mcp/tools/common.js'); console.log(JSON.stringify(mod.resolveNetworkPrefix()));"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MICROS_NETWORK_PREFIX: "10.0.1"
      }
    }
  );

  if (result.error) {
    throw result.error;
  }

  assert.equal(result.status, 0, `network prefix env test failed:\n${result.stdout}\n${result.stderr}`);
  assert.deepEqual(
    JSON.parse(result.stdout),
    { networkPrefix: "10.0.1", source: "injected" },
    "MICROS_NETWORK_PREFIX should mark discovery as injected"
  );
}

function testChatConfigPersistence() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-chat-config-"));
  const configPath = join(tempDir, "ui_chat_config.json");
  writeFileSync(configPath, JSON.stringify({ apiKey: "test-key", model: "test-model" }));

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          "const config = await import('./dist/ui/chat-bridge.js');",
          "const legacy = await config.readChatConfig();",
          "const saved = await config.saveChatConfig({ apiKey: 'new-key', model: 'new-model', speakReplies: true });",
          "const reloaded = await config.readChatConfig();",
          "console.log(JSON.stringify({ legacy, saved, reloaded }));"
        ].join(" ")
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          MICROS_CHAT_CONFIG_PATH: configPath
        }
      }
    );

    assert.equal(result.status, 0, `chat config persistence test failed:\n${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.legacy.speakReplies, false, "legacy chat config should default Speak to off");
    assert.deepEqual(
      parsed.saved,
      { apiKey: "new-key", model: "new-model", speakReplies: true },
      "saved chat config should include the Speak setting"
    );
    assert.deepEqual(parsed.reloaded, parsed.saved, "Speak setting should persist across config reads");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testUiAccessUrls() {
  assert.deepEqual(
    accessUrls("0.0.0.0", 3333, ["192.168.1.50", "10.0.1.42"], "10.0.1"),
    ["https://127.0.0.1:3333", "https://10.0.1.42:3333", "https://192.168.1.50:3333"],
    "wildcard UI bind should print localhost and prioritize the micrOS LAN address"
  );
  assert.deepEqual(
    accessUrls("127.0.0.1", 3333, ["10.0.1.42"], "10.0.1"),
    ["https://127.0.0.1:3333"],
    "explicit loopback UI bind should only print loopback"
  );
  assert.deepEqual(
    accessUrls("0.0.0.0", 3333, ["10.0.1.42"], "10.0.1", "http"),
    ["http://127.0.0.1:3333", "http://10.0.1.42:3333"],
    "URL formatting should support an explicit protocol"
  );
}

function testUiTabStructure() {
  const html = readFileSync("ui/assets/index.html", "utf8");
  assert.match(html, /src="\/media\/logo\.png"/, "tester UI should show the project logo");
  assert.match(html, /role="tablist"/, "tester UI should expose a tab list");
  assert.match(html, /data-view-tab="chat"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-view-tab="chat"/, "chat should be the default selected tab");
  assert.match(html, /data-view-panel="chat"/, "tester UI should have a chat tab panel");
  assert.match(html, /data-view-panel="tools"[^>]*hidden/, "MCP tools tab panel should be hidden initially");
  assert.match(html, /id="mcpDescription"/, "MCP tools tab should include the server description");
  assert.match(html, /id="mcpVersion"/, "MCP tools tab should include server version metadata");
}

async function testUiSelfSignedCertificate() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-tls-"));

  try {
    const hosts = ["localhost", "127.0.0.1", "10.0.1.42"];
    const generated = await ensureSelfSignedCertificate(tempDir, hosts);
    const certificate = new X509Certificate(generated.cert);

    assert.equal(certificate.checkHost("localhost"), "localhost", "generated certificate should cover localhost");
    assert.equal(certificate.checkIP("10.0.1.42"), "10.0.1.42", "generated certificate should cover LAN IPs");
    assert.equal(statSync(join(tempDir, "ui-self-signed-key.pem")).mode & 0o777, 0o600, "private key should be owner-only");

    const reused = await ensureSelfSignedCertificate(tempDir, hosts);
    assert.deepEqual(reused.cert, generated.cert, "valid generated certificates should be reused");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function testSpeechRecognitionSupport() {
  class FakeSpeechRecognition {}
  class FakeMediaRecorder {}
  const mediaDevices = {
    async getUserMedia() {
      return {};
    }
  };

  assert.equal(
    speechRecognitionSupport({
      webkitSpeechRecognition: FakeSpeechRecognition,
      isSecureContext: false,
      protocol: "http:",
      hostname: "10.0.1.42"
    }).ok,
    false,
    "microphone should be unavailable on insecure LAN origins"
  );
  assert.equal(
    speechRecognitionSupport({
      webkitSpeechRecognition: FakeSpeechRecognition,
      isSecureContext: true,
      protocol: "http:",
      hostname: "10.0.1.42"
    }).ok,
    true,
    "microphone should be available when the LAN origin is secure"
  );
  assert.equal(
    speechRecognitionSupport({
      webkitSpeechRecognition: FakeSpeechRecognition,
      isSecureContext: false,
      protocol: "http:",
      hostname: "127.0.0.1"
    }).ok,
    true,
    "microphone should stay available on localhost"
  );
  assert.equal(
    audioRecordingSupport({
      mediaDevices,
      MediaRecorder: FakeMediaRecorder,
      isSecureContext: false,
      protocol: "http:",
      hostname: "127.0.0.1"
    }).ok,
    true,
    "Safari recording fallback should be available on localhost"
  );
  assert.equal(
    audioRecordingSupport({
      mediaDevices,
      MediaRecorder: FakeMediaRecorder,
      isSecureContext: false,
      protocol: "http:",
      hostname: "10.0.1.42",
      port: "3333"
    }).ok,
    false,
    "Safari recording fallback should still require HTTPS or localhost"
  );
}

function testToolEventTitles() {
  assert.equal(
    toolEventTitle({ name: "list_devices", arguments: {} }),
    "list_devices tool",
    "regular tool event titles should retain the tool name"
  );
  assert.equal(
    toolEventTitle({ name: "filter_devices", arguments: { query: "temperature sensors" } }),
    "filter_devices tool: temperature sensors",
    "filter_devices event titles should include the query"
  );
  assert.equal(
    toolEventTitle({ name: "run_command", arguments: { command: "version" } }),
    "run_command tool: version",
    "run_command event titles should include string commands"
  );
  assert.equal(
    toolEventTitle({ name: "run_command", arguments: { command: ["version", "system info"], separator: "<a>" } }),
    "run_command tool: version <a> system info",
    "run_command event titles should include command pipelines"
  );
}

function testChatKeyboardSubmission() {
  assert.equal(shouldSubmitChatOnKeyDown({ key: "Enter" }), true, "Enter should submit chat messages");
  assert.equal(
    shouldSubmitChatOnKeyDown({ key: "Enter", shiftKey: true }),
    false,
    "Shift+Enter should insert a newline"
  );
  assert.equal(
    shouldSubmitChatOnKeyDown({ key: "Enter", isComposing: true }),
    false,
    "Enter should not submit while an input method is composing text"
  );
  assert.equal(shouldSubmitChatOnKeyDown({ key: "a" }), false, "other keys should not submit chat messages");
}

function testToolRegistry() {
  assert.equal(toolDefinitions.length, 6, "expected six registered tools");

  const names = toolDefinitions.map((tool) => tool.name);
  assert.deepEqual([...new Set(names)], names, "tool names must be unique");
  assert.deepEqual(names, [...names].sort(), "discovered tools should be sorted by inferred tool name");
  assert.ok(names.includes("filter_devices"), "filter_devices should be available as the primary device selection tool");
  assert.ok(names.includes("set_device_note"), "set_device_note should be available for persistent device context");

  for (const tool of toolDefinitions) {
    const expectedTitle = tool.name
      .split("_")
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ");

    assert.equal(typeof tool.name, "string", "tool name must be a string");
    assert.equal(tool.title, expectedTitle, `${tool.name} title should be inferred from its filename`);
    assert.equal(typeof tool.description, "string", `${tool.name} description must be a string`);
    assert.equal(
      tool.description,
      readFileSync(`dist/mcp/tools/${tool.name.replaceAll("_", "-")}.md`, "utf8").trim(),
      `${tool.name} description should be loaded from its Markdown metadata file`
    );
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

function testFeatureSearchFields() {
  const features = {
    deviceNote: "Mounted on the terrace near the DHT22 sensor.",
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
  assert.ok(fields.includes("Mounted on the terrace near the DHT22 sensor."), "device fields should include notes");
  assert.ok(fields.includes("dht22"), "device fields should include discovered module names");
  assert.ok(fields.includes("dht22 measure temperature=True"), "device fields should include command text");
  assert.deepEqual(pruned.modules.map((module) => module.name), ["dht22"], "feature pruning should keep matching modules only");
  assert.deepEqual(pruned.commands.map((command) => command.command), ["dht22 measure temperature=True"], "feature pruning should keep matching commands only");
}

async function testListDevicesCompactShape() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-test-"));
  const deviceCachePath = join(tempDir, "devices.json");
  const featureCachePath = join(tempDir, "features.json");
  const notesCachePath = join(tempDir, "notes.json");

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
        deviceNote: "Mounted on the terrace.",
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
  writeFileSync(
    notesCachePath,
    JSON.stringify({
      micr123OS: "Mounted on the terrace."
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
        MICROS_DEVICE_FEATURE_CACHE_PATH: featureCachePath,
        MICROS_DEVICE_NOTES_CACHE_PATH: notesCachePath
      }
    }
  );

  assert.equal(result.status, 0, `listDevices compact shape check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const device = parsed.devices.find((entry) => entry.uid === "micr123OS");

  assert.ok(device, "expected test device in compact list");
  assert.equal(device.deviceNote, "Mounted on the terrace.", "list_devices should expose device notes");
  assert.deepEqual(device.modules, ["dht22"], "list_devices should expose known module names");
  assert.equal(device.moduleCount, 1, "list_devices should expose module count");
  assert.equal("features" in device, false, "list_devices should not expose full feature details");
  assert.equal("featureCache" in parsed, false, "list_devices should not expose the full feature cache");
  assert.equal("micrOSCache" in parsed, false, "list_devices should not duplicate the raw device cache");
}

async function testFilterDevicesNoteShape() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-filter-test-"));
  const deviceCachePath = join(tempDir, "devices.json");
  const featureCachePath = join(tempDir, "features.json");
  const notesCachePath = join(tempDir, "notes.json");

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
        deviceNote: "Outdoor temperature sensor.",
        discoveredAt: "2026-06-14T00:00:00.000Z",
        modulesCommand: "modules",
        rawModules: ["['dht22']"],
        modules: [
          {
            name: "dht22",
            helpCommand: "dht22 help",
            rawHelp: ["measure"],
            functions: []
          }
        ],
        commands: []
      }
    })
  );
  writeFileSync(
    notesCachePath,
    JSON.stringify({
      TerraceSensor: "Outdoor temperature sensor."
    })
  );

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const mod = await import('./dist/mcp/tools/filter-devices.js'); const result = await mod.filterDevices({ query: 'temperature' }); console.log(JSON.stringify(result));"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MICROS_DEVICE_CACHE_PATH: deviceCachePath,
        MICROS_DEVICE_FEATURE_CACHE_PATH: featureCachePath,
        MICROS_DEVICE_NOTES_CACHE_PATH: notesCachePath
      }
    }
  );

  assert.equal(result.status, 0, `filterDevices note shape check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const device = parsed.devices[0];

  assert.equal(device.deviceNote, "Outdoor temperature sensor.", "filter_devices should expose deviceNote at device level");
  assert.ok(device.features, "filter_devices should include matched features");
  assert.equal("deviceNote" in device.features, false, "filter_devices should not duplicate deviceNote inside features");
  assert.equal("deviceName" in device.features, false, "filter_devices should not duplicate deviceName inside features");
  assert.deepEqual(
    device.features.modules.map((module) => module.name),
    ["dht22"],
    "single-module note matches should expose that module"
  );
}

async function testFilterDevicesNoteMatchKeepsAllFeatures() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-filter-note-test-"));
  const deviceCachePath = join(tempDir, "devices.json");
  const featureCachePath = join(tempDir, "features.json");
  const notesCachePath = join(tempDir, "notes.json");

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
        deviceNote: "Outdoor temperature and humidity sensor.",
        discoveredAt: "2026-06-14T00:00:00.000Z",
        modulesCommand: "modules",
        rawModules: ["['dht22', 'task']"],
        modules: [
          {
            name: "dht22",
            helpCommand: "dht22 help",
            rawHelp: ["measure"],
            functions: []
          },
          {
            name: "task",
            helpCommand: "task help",
            rawHelp: ["schedule"],
            functions: []
          }
        ],
        commands: []
      }
    })
  );
  writeFileSync(
    notesCachePath,
    JSON.stringify({
      TerraceSensor: "Outdoor temperature and humidity sensor."
    })
  );

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const mod = await import('./dist/mcp/tools/filter-devices.js'); const result = await mod.filterDevices({ query: 'temperature' }); console.log(JSON.stringify(result));"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MICROS_DEVICE_CACHE_PATH: deviceCachePath,
        MICROS_DEVICE_FEATURE_CACHE_PATH: featureCachePath,
        MICROS_DEVICE_NOTES_CACHE_PATH: notesCachePath
      }
    }
  );

  assert.equal(result.status, 0, `filterDevices note match feature check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const device = parsed.devices[0];

  assert.deepEqual(
    device.features.modules.map((module) => module.name),
    ["dht22", "task"],
    "note matches should keep all modules so AI can choose the right command"
  );
  assert.equal("deviceNote" in device.features, false, "note matches should still avoid nested deviceNote duplication");
  assert.equal("deviceName" in device.features, false, "note matches should still avoid nested deviceName duplication");
}

async function testFilterDevicesExactModuleMatchPrunesFeatures() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-filter-module-test-"));
  const deviceCachePath = join(tempDir, "devices.json");
  const featureCachePath = join(tempDir, "features.json");
  const notesCachePath = join(tempDir, "notes.json");

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
        deviceName: "TerraceSensor",
        discoveredAt: "2026-06-14T00:00:00.000Z",
        modulesCommand: "modules",
        rawModules: ["['dht22', 'task']"],
        modules: [
          {
            name: "dht22",
            helpCommand: "dht22 help",
            rawHelp: ["measure"],
            functions: []
          },
          {
            name: "task",
            helpCommand: "task help",
            rawHelp: ["schedule"],
            functions: []
          }
        ],
        commands: [
          {
            module: "dht22",
            function: "measure",
            parameters: [],
            command: "dht22 measure",
            signature: "measure"
          },
          {
            module: "task",
            function: "schedule",
            parameters: [],
            command: "task schedule",
            signature: "schedule"
          }
        ]
      }
    })
  );
  writeFileSync(
    notesCachePath,
    JSON.stringify({
      TerraceSensor: "dht22 is a temperature and humidity sensor."
    })
  );

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const mod = await import('./dist/mcp/tools/filter-devices.js'); const result = await mod.filterDevices({ query: 'dht22' }); console.log(JSON.stringify(result));"
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MICROS_DEVICE_CACHE_PATH: deviceCachePath,
        MICROS_DEVICE_FEATURE_CACHE_PATH: featureCachePath,
        MICROS_DEVICE_NOTES_CACHE_PATH: notesCachePath
      }
    }
  );

  assert.equal(result.status, 0, `filterDevices exact module match check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const device = parsed.devices[0];

  assert.deepEqual(
    device.features.modules.map((module) => module.name),
    ["dht22"],
    "exact module name matches should expose only that module"
  );
  assert.deepEqual(
    device.features.commands.map((command) => command.module),
    ["dht22"],
    "exact module name matches should expose only commands for that module"
  );
}

async function testSetDeviceNoteTool() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-note-test-"));
  const deviceCachePath = join(tempDir, "devices.json");
  const featureCachePath = join(tempDir, "features.json");
  const notesCachePath = join(tempDir, "notes.json");

  writeFileSync(
    deviceCachePath,
    JSON.stringify({
      micr123OS: ["10.0.1.20", 9008, "TerraceSensor"]
    })
  );
  writeFileSync(featureCachePath, "{}");
  writeFileSync(notesCachePath, "{}");

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      [
        "const fs = await import('node:fs');",
        "const note = await import('./dist/mcp/tools/set-device-note.js');",
        "const discover = await import('./dist/mcp/tools/discover-commands.js');",
        "const common = await import('./dist/mcp/tools/common.js');",
        "await note.setDeviceNote({ deviceTag: 'TerraceSensor', note: 'Mounted on the terrace.', mode: 'replace' });",
        "await discover.saveSuccessfulFeatureDiscoveries([{ ok: true, device: { uid: 'micr123OS', ip: '10.0.1.20', port: 9008, fuid: 'TerraceSensor' }, discoveredAt: '2026-06-14T00:00:00.000Z', modulesCommand: 'modules', rawModules: ['dht22'], modules: [], commands: [] }]);",
        "const cache = await common.readDeviceFeatureCache();",
        "const notes = await common.readDeviceNotesCache();",
        "const rawFeatures = JSON.parse(fs.readFileSync(process.env.MICROS_DEVICE_FEATURE_CACHE_PATH, 'utf8'));",
        "console.log(JSON.stringify({ features: cache.micr123OS, notes, rawFeatures: rawFeatures.micr123OS }));"
      ].join(" ")
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MICROS_DEVICE_CACHE_PATH: deviceCachePath,
        MICROS_DEVICE_FEATURE_CACHE_PATH: featureCachePath,
        MICROS_DEVICE_NOTES_CACHE_PATH: notesCachePath
      }
    }
  );

  assert.equal(result.status, 0, `setDeviceNote persistence check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.features.deviceNote, "Mounted on the terrace.", "device note should survive feature rediscovery");
  assert.equal(parsed.features.discoveredAt, "2026-06-14T00:00:00.000Z", "feature discovery data should still update");
  assert.equal(parsed.notes.TerraceSensor, "Mounted on the terrace.", "device note should be stored by device name");
  assert.equal("micr123OS" in parsed.notes, false, "device note should not keep the UID key after writing");
  assert.equal("deviceNote" in parsed.rawFeatures, false, "feature cache should not persist device notes");
  assert.equal(parsed.rawFeatures.deviceName, "TerraceSensor", "feature cache should persist device name");
}

async function testLegacyFeatureNotesMigrateOnFeatureSave() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-legacy-note-test-"));
  const deviceCachePath = join(tempDir, "devices.json");
  const featureCachePath = join(tempDir, "features.json");
  const notesCachePath = join(tempDir, "notes.json");

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
        deviceNote: "Legacy terrace note.",
        discoveredAt: "2026-06-13T00:00:00.000Z",
        modulesCommand: "modules",
        rawModules: [],
        modules: [],
        commands: []
      }
    })
  );
  writeFileSync(notesCachePath, "{}");

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      [
        "const fs = await import('node:fs');",
        "const discover = await import('./dist/mcp/tools/discover-commands.js');",
        "const common = await import('./dist/mcp/tools/common.js');",
        "await discover.saveSuccessfulFeatureDiscoveries([{ ok: true, device: { uid: 'micr123OS', ip: '10.0.1.20', port: 9008, fuid: 'TerraceSensor' }, discoveredAt: '2026-06-14T00:00:00.000Z', modulesCommand: 'modules', rawModules: ['dht22'], modules: [], commands: [] }]);",
        "const cache = await common.readDeviceFeatureCache();",
        "const notes = await common.readDeviceNotesCache();",
        "const rawFeatures = JSON.parse(fs.readFileSync(process.env.MICROS_DEVICE_FEATURE_CACHE_PATH, 'utf8'));",
        "console.log(JSON.stringify({ features: cache.micr123OS, notes, rawFeatures: rawFeatures.micr123OS }));"
      ].join(" ")
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MICROS_DEVICE_CACHE_PATH: deviceCachePath,
        MICROS_DEVICE_FEATURE_CACHE_PATH: featureCachePath,
        MICROS_DEVICE_NOTES_CACHE_PATH: notesCachePath
      }
    }
  );

  assert.equal(result.status, 0, `legacy note migration check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.features.deviceNote, "Legacy terrace note.", "legacy device note should remain in responses");
  assert.equal(parsed.notes.TerraceSensor, "Legacy terrace note.", "legacy device note should migrate to device name key");
  assert.equal("micr123OS" in parsed.notes, false, "legacy UID note key should be removed after migration");
  assert.equal("deviceNote" in parsed.rawFeatures, false, "migrated feature cache should not retain device notes");
  assert.equal(parsed.rawFeatures.deviceName, "TerraceSensor", "migrated feature cache should retain device name");
}

testRequiredProjectFiles();
testMcpMetadataFilesCopied();
testDockerExcludesRuntimeData();
testCliHelpEntrypoints();
testNetworkPrefixEnvironmentOverride();
testChatConfigPersistence();
testUiAccessUrls();
testUiTabStructure();
await testUiSelfSignedCertificate();
testSpeechRecognitionSupport();
testToolEventTitles();
testChatKeyboardSubmission();
testToolRegistry();
testCommandParsing();
testModuleParsing();
testHelpParsing();
testFeatureSearchFields();
await testListDevicesCompactShape();
await testFilterDevicesNoteShape();
await testFilterDevicesNoteMatchKeepsAllFeatures();
await testFilterDevicesExactModuleMatchPrunesFeatures();
await testSetDeviceNoteTool();
await testLegacyFeatureNotesMigrateOnFeatureSave();

console.log("MCP server tests passed.");
