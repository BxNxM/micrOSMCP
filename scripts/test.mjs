#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  deviceSearchFields,
  fieldsMatchQuery,
  normalizeCommandPipeline,
  parseModuleHelp,
  parseModules,
  pruneDeviceFeaturesForQuery
} from "../dist/mcp/tools/common.js";
import { documentModules } from "../dist/mcp/function-docs.js";
import { buildCommandModuleHint, checkCommandPipeline, runCommand } from "../dist/mcp/tools/run-command.js";
import { toolDefinitions } from "../dist/mcp/tool-registry.js";
import { addTokenUsage } from "../dist/ui/chat-bridge.js";
import {
  accessUrls,
  ensureSelfSignedCertificate,
  readJsonBody
} from "../dist/ui/server.js";
import {
  audioRecordingSupport,
  shouldSubmitChatOnKeyDown,
  speechRecognitionSupport,
  stopMediaStreamTracks,
  stopSpeechRecognition,
  tokenUsageLabel,
  toolEventTitle
} from "../ui/assets/chat.js";
import { defaultValueFromSchema, includeBooleanArgument, showToolParameter } from "../ui/assets/tool-form.js";

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
  "mcp/function-docs.ts",
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
  "data/sfuncman.json",
  "ui/assets/app.js",
  "ui/assets/chat.css",
  "ui/assets/chat.js",
  "ui/assets/index.html",
  "ui/assets/styles.css",
  "ui/assets/tool-form.js",
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

function testFuzzyFieldMatching() {
  assert.equal(fieldsMatchQuery(["Outdoor temperature sensor"], "temprature"), true);
  assert.equal(fieldsMatchQuery(["TerraceSensor"], "TeraceSensor"), true);
  assert.equal(fieldsMatchQuery(["measure"], "mesaure"), true);
  assert.equal(fieldsMatchQuery(["temperature"], "temprature", 0), false);
  assert.equal(fieldsMatchQuery(["temperature"], "temprature", 1), true);
  assert.equal(fieldsMatchQuery(["temperature"], "tmpreaturx", 1), false);
  assert.equal(fieldsMatchQuery(["temperature"], "tmpreaturx", 2), true);
  assert.equal(fieldsMatchQuery(["task"], "test"), false, "short fuzzy terms should not create broad matches");
  assert.equal(fieldsMatchQuery(["temperature"], "pressure"), false, "unrelated terms should not match");
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

  assert.ok(dockerignore.includes("data/*"), ".dockerignore must exclude local data/ runtime state");
  assert.ok(
    dockerignore.includes("!data/sfuncman.json"),
    ".dockerignore should admit only the static function manual from data/"
  );
  assert.match(
    dockerfile,
    /^\s*COPY\s+data\/sfuncman\.json\s+\.\/reference\/sfuncman\.json\s*$/m,
    "Docker build stage should copy the static function manual outside runtime data"
  );
  assert.doesNotMatch(
    dockerfile,
    /^\s*COPY\s+(?:--\S+\s+)*data(?:\s|\/)(?!sfuncman\.json)/m,
    "Dockerfile must not copy local runtime data"
  );
  assert.match(dockerfile, /^\s*RUN\s+mkdir\s+-p\s+data\s*$/m, "Docker image should create an empty data directory");
  assert.match(dockerfile, /^\s*COPY\s+media\s+\.\/media\s*$/m, "Docker build stage should include UI media assets");
  assert.match(
    dockerfile,
    /^\s*COPY\s+--from=build\s+\/app\/media\s+\.\/media\s*$/m,
    "Docker runtime should include UI media assets"
  );
}

function testCliHelpEntrypoints() {
  assertCommand(
    "node",
    ["scripts/start.mjs", "--help"],
    /Usage:[\s\S]*MICROS_INITIALIZE_ON_START=0 npm run start:mcp/
  );
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
          "const publicRead = await config.readPublicChatConfig();",
          "const publicSaved = await config.savePublicChatConfig({ apiKey: '', model: 'public-model', speakReplies: false });",
          "const finalConfig = await config.readChatConfig();",
          "const fileMode = (await import('node:fs')).statSync(process.env.MICROS_CHAT_CONFIG_PATH).mode & 0o777;",
          "console.log(JSON.stringify({ legacy, saved, reloaded, publicRead, publicSaved, finalConfig, fileMode }));"
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
    assert.deepEqual(
      parsed.publicRead,
      { model: "new-model", speakReplies: true, hasApiKey: true },
      "browser config reads should report key availability without exposing the secret"
    );
    assert.equal("apiKey" in parsed.publicSaved, false, "browser config writes should not echo the API key");
    assert.equal(parsed.finalConfig.apiKey, "new-key", "an empty browser key should preserve the server-side key");
    assert.equal(parsed.finalConfig.model, "public-model");
    assert.equal(parsed.fileMode, 0o600, "the persisted API key file should be readable only by its owner");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testUiRequestLimit() {
  const oversized = Readable.from([Buffer.from('{"value":"'), Buffer.alloc(20, "x"), Buffer.from('"}')]);
  oversized.headers = {};
  await assert.rejects(
    readJsonBody(oversized, 16),
    (error) => error?.statusCode === 413,
    "oversized UI request bodies should fail with 413"
  );

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

function testToolFormPolicy() {
  assert.equal(defaultValueFromSchema({ type: "integer", default: 1 }), 1);
  assert.equal(defaultValueFromSchema({ type: "string" }), undefined);
  assert.equal(includeBooleanArgument({ type: "boolean", default: true }, false), true);
  assert.equal(includeBooleanArgument({ type: "boolean" }, false), false);
  const searchTool = toolDefinitions.find((tool) => tool.name === "search_devices");
  assert.equal(showToolParameter(searchTool, "includeStatus"), false);
  assert.equal(showToolParameter(searchTool, "status"), true, "status should remain visible with its Any option");
  assert.equal(showToolParameter({}, "includeStatus"), true, "forms should stay tool-independent without metadata");
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

function testVoiceCaptureCleanup() {
  const stoppedTracks = [];
  stopMediaStreamTracks({
    getTracks() {
      return [
        { stop: () => stoppedTracks.push("audio") },
        { stop: () => stoppedTracks.push("secondary") }
      ];
    }
  });
  assert.deepEqual(stoppedTracks, ["audio", "secondary"], "all microphone tracks should stop immediately");

  let abortCount = 0;
  let stopCount = 0;
  stopSpeechRecognition({
    abort: () => {
      abortCount += 1;
    },
    stop: () => {
      stopCount += 1;
    }
  });
  assert.equal(abortCount, 1, "explicit dictation cleanup should abort capture immediately");
  assert.equal(stopCount, 0, "graceful stop should not delay explicit microphone cleanup");

  stopSpeechRecognition({ stop: () => { stopCount += 1; } });
  assert.equal(stopCount, 1, "browsers without abort should fall back to stop");
}

function testToolEventTitles() {
  assert.equal(
    toolEventTitle({ name: "list_devices", arguments: {} }),
    "list_devices tool",
    "regular tool event titles should retain the tool name"
  );
  assert.equal(
    toolEventTitle({ name: "search_devices", arguments: { query: "temperature sensors" } }),
    "search_devices tool: temperature sensors",
    "search_devices event titles should include the query"
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

function testChatTokenUsage() {
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  usage = addTokenUsage(usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
  usage = addTokenUsage(usage, { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 });

  assert.deepEqual(usage, { inputTokens: 140, outputTokens: 30, totalTokens: 170 });
  assert.equal(tokenUsageLabel(usage), "170 tokens · 140 in · 30 out");
  assert.equal(tokenUsageLabel(null), "", "missing usage should not render a footer");
}

function testToolRegistry() {
  assert.equal(toolDefinitions.length, 6, "expected six registered tools");

  const names = toolDefinitions.map((tool) => tool.name);
  assert.deepEqual([...new Set(names)], names, "tool names must be unique");
  assert.deepEqual(names, [...names].sort(), "discovered tools should be sorted by inferred tool name");
  assert.ok(names.includes("search_devices"), "search_devices should be the primary device and feature lookup tool");
  assert.ok(names.includes("set_device_note"), "set_device_note should be available for persistent device context");
  const searchTool = toolDefinitions.find((tool) => tool.name === "search_devices");
  assert.ok(searchTool && "fuzziness" in searchTool.inputSchema, "search_devices should expose fuzziness");
  assert.equal(searchTool.title, "Search Devices");
  assert.match(searchTool.description, /before run_command/, "tool guidance should establish the command lookup workflow");
  assert.equal(searchTool.inputSchema.fuzziness.safeParse(0).success, true);
  assert.equal(searchTool.inputSchema.fuzziness.safeParse(2).success, true);
  assert.equal(searchTool.inputSchema.fuzziness.safeParse(3).success, false);
  assert.equal(searchTool.inputSchema.fuzziness.parse(undefined), 1, "fuzziness should expose its default value");
  const discoverTool = toolDefinitions.find((tool) => tool.name === "discover_devices");
  const discoverDefaults = {
    port: 9008,
    startHost: 2,
    endHost: 254,
    concurrency: 50,
    timeoutMs: 1000,
    refreshFeatures: true,
    featureTimeout: 3,
    featureConcurrency: 3
  };

  for (const [name, expected] of Object.entries(discoverDefaults)) {
    assert.equal(
      discoverTool.inputSchema[name].parse(undefined),
      expected,
      `discover_devices should expose the ${name} default`
    );
  }
  const noteTool = toolDefinitions.find((tool) => tool.name === "set_device_note");
  assert.equal(noteTool.inputSchema.mode.parse(undefined), "replace");
  assert.equal(noteTool.inputSchema.mode.safeParse("append").success, true);
  assert.equal(noteTool.inputSchema.mode.safeParse("clear").success, false, "set_device_note should not expose clear mode");
  const discoverCommandsTool = toolDefinitions.find((tool) => tool.name === "discover_commands");
  assert.equal(discoverCommandsTool.inputSchema.timeout.parse(undefined), 10);
  assert.equal(discoverCommandsTool.inputSchema.concurrency.parse(undefined), 3);
  const runCommandTool = toolDefinitions.find((tool) => tool.name === "run_command");
  assert.equal(runCommandTool.inputSchema.timeout.parse(undefined), 10);

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

async function testCommandDenials() {
  assert.equal(checkCommandPipeline("conf").denial, undefined);
  assert.equal(checkCommandPipeline("conf webui").denial, undefined);
  assert.equal(checkCommandPipeline("conf<a>webui").denial, undefined);
  assert.equal(checkCommandPipeline("version<a>conf webui").denial, undefined);

  for (const command of [
    "conf webui true",
    "conf<a>webui true",
    "conf<a>webui<a>true",
    ["conf", "webui true"],
    "version<a>conf webui true"
  ]) {
    const checked = checkCommandPipeline(command);
    assert.equal(checked.denial?.rule, "conf-write", `expected conf-write denial for ${JSON.stringify(command)}`);
  }

  const denied = await runCommand({ deviceTag: "unknown-device", command: "conf webui true" });
  assert.deepEqual(denied, {
    ok: false,
    error: "Command denied: Configuration writes are not allowed.",
    rule: "conf-write",
    deniedCommand: "conf webui true",
    commands: ["conf webui true"]
  }, "unsafe commands should be denied before device lookup");
}

function testModuleParsing() {
  assert.deepEqual(parseModules(["['rgb', 'system', 'task']"]), ["rgb", "system", "task"]);
  assert.deepEqual(parseModules(["rgb,", " system,", " task,"]), ["rgb", "system", "task"]);
}

function testHelpParsing() {
  assert.deepEqual(parseModuleHelp([" toggle state=<True,False> smooth=True,"]), [
    "toggle state=<True,False> smooth=True"
  ]);
  assert.deepEqual(
    parseModuleHelp(['["load width=128 height=64", "text \\"text\\" x y", "show"]']),
    ["load width=128 height=64", 'text "text" x y', "show"],
    "JSON help should preserve complete function signatures"
  );
}

function testDiscoverDevicesHidesCachePath() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-discover-response-test-"));
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      [
        "const mod = await import('./dist/mcp/tools/discover-devices.js');",
        "const result = await mod.discoverDevices({ networkPrefix: '127.0.0', startHost: 1, endHost: 1, port: 65534, timeoutMs: 1, concurrency: 1, refreshFeatures: false });",
        "console.log(JSON.stringify(result));"
      ].join(" ")
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MICROS_DEVICE_CACHE_PATH: join(tempDir, "devices.json"),
        MICROS_DEVICE_FEATURE_CACHE_PATH: join(tempDir, "features.json"),
        MICROS_DEVICE_NOTES_CACHE_PATH: join(tempDir, "notes.json")
      }
    }
  );

  assert.equal(result.status, 0, `discoverDevices response check failed:\n${result.stdout}\n${result.stderr}`);
  assert.equal("cachePath" in JSON.parse(result.stdout), false, "discover_devices should not expose the cache path");
}

async function testFunctionDocumentation() {
  const modules = await documentModules([
    { name: "DHT22", functions: ["MEASURE log=False", "missing value=1"] },
    { name: "missingModule", functions: ["run"] }
  ]);

  assert.equal(modules[0].functions[0].name, "MEASURE", "function name should preserve the discovered signature");
  assert.equal(
    modules[0].functions[0].signature,
    "MEASURE log=False",
    "documented responses should preserve the complete signature"
  );
  assert.match(modules[0].functions[0].doc ?? "", /Measure with dht22/, "manual lookup should enrich known functions");
  assert.equal("doc" in modules[0].functions[1], false, "unknown functions should omit doc");
  assert.equal("doc" in modules[1].functions[0], false, "unknown modules should omit doc");
}

async function testCommandModuleHint() {
  const hint = await buildCommandModuleHint(
    ["DHT22 measure", "version", "dht22 help"],
    [{ name: "dht22", functions: ["measure log=False", "help"] }]
  );

  assert.deepEqual(hint?.matchedCommands, ["DHT22 measure"]);
  assert.equal(hint?.modules.length, 1, "a module hint should contain the matched first module only");
  assert.equal(hint?.modules[0].name, "dht22");
  assert.equal(hint?.modules[0].functions[0].signature, "measure log=False");
  assert.match(hint?.modules[0].functions[0].doc ?? "", /Measure with dht22/);
  assert.equal(
    await buildCommandModuleHint(["version"], [{ name: "dht22", functions: ["measure"] }]),
    undefined,
    "commands that do not start with a cached module should not produce a hint"
  );
  assert.equal(
    await buildCommandModuleHint(["version", "dht22 measure"], [{ name: "dht22", functions: ["measure"] }]),
    undefined,
    "modules appearing only later in a pipeline should not produce a hint"
  );
  assert.equal(
    await buildCommandModuleHint(["dht2"], [{ name: "dht22", functions: ["measure"] }]),
    undefined,
    "module hint matching should not be fuzzy"
  );
}

function testRunCommandResponseIncludesModuleHint() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-run-hint-test-"));
  const deviceCachePath = join(tempDir, "devices.json");
  const featureCachePath = join(tempDir, "features.json");
  const notesCachePath = join(tempDir, "notes.json");

  writeFileSync(
    deviceCachePath,
    JSON.stringify({
      micr123OS: { ip: "127.0.0.1", port: 65534, deviceName: "TerraceSensor" }
    })
  );
  writeFileSync(
    featureCachePath,
    JSON.stringify({
      micr123OS: {
        discoveredAt: "2026-06-20T00:00:00.000Z",
        modules: [{ name: "dht22", functions: ["measure log=False", "logger", "load", "pinmap"] }]
      }
    })
  );
  writeFileSync(notesCachePath, "{}");

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      [
        "const mod = await import('./dist/mcp/tools/run-command.js');",
        "const result = await mod.runCommand({ deviceTag: 'TerraceSensor', command: 'dht22', timeout: 1 });",
        "console.log(JSON.stringify(result));"
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

  assert.equal(result.status, 0, `runCommand module hint check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.moduleHint.matchedCommands, ["dht22"]);
  assert.equal(parsed.moduleHint.modules[0].name, "dht22");
  assert.deepEqual(
    parsed.moduleHint.modules[0].functions.map((fn) => fn.signature),
    ["measure log=False", "logger", "load", "pinmap"],
    "a bare module command should return the full cached function section"
  );
  assert.equal(
    parsed.moduleHint.modules[0].functions.every((fn) => typeof fn.doc === "string" && fn.doc.length > 0),
    true,
    "all documented dht22 functions should include docs"
  );
}

function testFeatureSearchFields() {
  const features = {
    deviceName: "TerraceSensor",
    deviceNote: "Mounted on the terrace near the DHT22 sensor.",
    discoveredAt: "2026-06-14T00:00:00.000Z",
    modules: [
      {
        name: "dht22",
        functions: ["measure temperature=True"]
      },
      {
        name: "rgb",
        functions: ["toggle"]
      }
    ]
  };
  const fields = deviceSearchFields({
    uid: "micr123OS",
    ip: "10.0.1.20",
    port: 9008,
    deviceName: "TerraceSensor",
    features
  });
  const pruned = pruneDeviceFeaturesForQuery(features, "dht22");

  assert.ok(fields.includes("TerraceSensor"), "device fields should include deviceName");
  assert.ok(fields.includes("Mounted on the terrace near the DHT22 sensor."), "device fields should include notes");
  assert.ok(fields.includes("dht22"), "device fields should include discovered module names");
  assert.ok(fields.includes("dht22 measure temperature=True"), "device fields should include command text");
  assert.deepEqual(pruned.modules.map((module) => module.name), ["dht22"], "feature pruning should keep matching modules only");
  assert.deepEqual(
    pruned.modules[0].functions,
    ["measure temperature=True"],
    "selected modules should retain all functions"
  );
  assert.equal("commands" in pruned, false, "compact features should not duplicate functions as commands");
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
  const migratedDeviceCache = JSON.parse(readFileSync(deviceCachePath, "utf8"));

  assert.ok(device, "expected test device in compact list");
  assert.deepEqual(migratedDeviceCache.micr123OS, {
    ip: "10.0.1.20",
    port: 9008,
    deviceName: "TerraceSensor"
  }, "legacy device cache arrays should migrate to named connection objects");
  assert.equal(device.deviceNote, "Mounted on the terrace.", "list_devices should expose device notes");
  assert.deepEqual(device.modules, ["dht22"], "list_devices should expose known module names");
  assert.equal(device.moduleCount, 1, "list_devices should expose module count");
  assert.equal("features" in device, false, "list_devices should not expose full feature details");
  assert.equal("featureCache" in parsed, false, "list_devices should not expose the full feature cache");
  assert.equal("micrOSCache" in parsed, false, "list_devices should not duplicate the raw device cache");
  assert.equal("featureCachePath" in parsed, false, "list_devices should not expose the feature cache path");
  assert.equal("notesCachePath" in parsed, false, "list_devices should not expose the notes cache path");
  assert.equal("cachePath" in parsed, false, "list_devices should not expose the connection cache path");
}

async function testSearchDevicesNoteShape() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-search-test-"));
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
        deviceNote: "Outdoor dht22 temperature sensor.",
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
      TerraceSensor: "Outdoor dht22 temperature sensor."
    })
  );

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const mod = await import('./dist/mcp/tools/search-devices.js'); const result = await mod.searchDevices({ query: 'temperature' }); console.log(JSON.stringify(result));"
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

  assert.equal(result.status, 0, `searchDevices note shape check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const device = parsed.devices[0];

  assert.equal("featureCachePath" in parsed, false, "search_devices should not expose the feature cache path");
  assert.equal("notesCachePath" in parsed, false, "search_devices should not expose the notes cache path");
  assert.equal(device.deviceNote, "Outdoor dht22 temperature sensor.", "search_devices should expose deviceNote at device level");
  assert.ok(device.features, "search_devices should include matched features");
  assert.equal("deviceNote" in device.features, false, "search_devices should not duplicate deviceNote inside features");
  assert.equal("deviceName" in device.features, false, "search_devices should not duplicate deviceName inside features");
  assert.deepEqual(
    device.features.modules.map((module) => module.name),
    ["dht22"],
    "single-module note matches should expose that module"
  );
}

async function testSearchDevicesNoteMatchKeepsAllFeatures() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-search-note-test-"));
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
        deviceNote: "Outdoor dht22 temperature and humidity sensor.",
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
      TerraceSensor: "Outdoor dht22 temperature and humidity sensor."
    })
  );

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const mod = await import('./dist/mcp/tools/search-devices.js'); const result = await mod.searchDevices({ query: 'temperature' }); console.log(JSON.stringify(result));"
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

  assert.equal(result.status, 0, `searchDevices note match feature check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const device = parsed.devices[0];

  assert.deepEqual(
    device.features.modules.map((module) => module.name),
    ["dht22"],
    "note words should select relevant modules without retaining unrelated modules"
  );
  assert.equal("deviceNote" in device.features, false, "note matches should still avoid nested deviceNote duplication");
  assert.equal("deviceName" in device.features, false, "note matches should still avoid nested deviceName duplication");
}

async function testSearchDevicesExactModuleMatchPrunesFeatures() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-search-module-test-"));
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
      "const mod = await import('./dist/mcp/tools/search-devices.js'); const result = await mod.searchDevices({ query: 'dht22' }); console.log(JSON.stringify(result));"
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

  assert.equal(result.status, 0, `searchDevices exact module match check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const device = parsed.devices[0];

  assert.deepEqual(
    device.features.modules.map((module) => module.name),
    ["dht22"],
    "exact module name matches should expose only that module"
  );
  assert.deepEqual(
    device.features.modules[0].functions,
    [
      {
        name: "measure",
        signature: "measure",
        doc: "Measure with dht22\n    :return dict: temp, hum"
      }
    ],
    "selected modules should expose complete signatures and available documentation"
  );
  assert.equal("commands" in device.features, false, "search results should not duplicate module functions");
  assert.equal("rawModules" in device.features, false, "search results should not expose raw module output");
  assert.equal("helpCommand" in device.features.modules[0], false, "modules should not repeat their help command");
  assert.equal("rawHelp" in device.features.modules[0], false, "modules should not retain raw help alongside signatures");
}

async function testSearchDevicesMultiWordFallback() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-search-words-test-"));
  const deviceCachePath = join(tempDir, "devices.json");
  const featureCachePath = join(tempDir, "features.json");
  const notesCachePath = join(tempDir, "notes.json");

  writeFileSync(
    deviceCachePath,
    JSON.stringify({
      micrKitchenOS: ["10.0.1.20", 9008, "KitchenLight"],
      micrTerraceOS: ["10.0.1.21", 9008, "TerraceSensor"]
    })
  );
  writeFileSync(
    featureCachePath,
    JSON.stringify({
      micrKitchenOS: {
        deviceName: "KitchenLight",
        discoveredAt: "2026-06-20T00:00:00.000Z",
        modules: [{ name: "kitchenLight", functions: ["brightness percent=<0-100>"] }]
      },
      micrTerraceOS: {
        deviceName: "TerraceSensor",
        discoveredAt: "2026-06-20T00:00:00.000Z",
        modules: [{ name: "dht22", functions: ["measure"] }]
      }
    })
  );
  writeFileSync(
    notesCachePath,
    JSON.stringify({
      KitchenLight: "Kitchen dimming controller.",
      TerraceSensor: "Terrace temperature sensor."
    })
  );

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      [
        "const mod = await import('./dist/mcp/tools/search-devices.js');",
        "const phrase = await mod.searchDevices({ query: 'kitchen dimming', fuzziness: 0 });",
        "const words = await mod.searchDevices({ query: 'kitchen terrace', fuzziness: 0 });",
        "console.log(JSON.stringify({ phrase, words }));"
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

  assert.equal(result.status, 0, `searchDevices word fallback check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.phrase.matchMode, "query");
  assert.deepEqual(parsed.phrase.devices.map((device) => device.deviceName), ["KitchenLight"]);
  assert.equal(parsed.words.matchMode, "words");
  assert.deepEqual(parsed.words.matchedTerms, ["kitchen", "terrace"]);
  assert.deepEqual(parsed.words.devices.map((device) => device.deviceName), ["KitchenLight", "TerraceSensor"]);
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
        "const writeResult = await note.setDeviceNote({ deviceTag: 'TerraceSensor', note: 'Mounted on the terrace.', mode: 'replace' });",
        "const readResult = await note.setDeviceNote({ deviceTag: 'TerraceSensor', note: '   ', mode: 'append' });",
        "await discover.saveSuccessfulFeatureDiscoveries([{ ok: true, device: { uid: 'micr123OS', ip: '10.0.1.20', port: 9008, deviceName: 'TerraceSensor' }, discoveredAt: '2026-06-14T00:00:00.000Z', modules: [] }]);",
        "const cache = await common.readDeviceFeatureCache();",
        "const notes = await common.readDeviceNotesCache();",
        "const rawFeatures = JSON.parse(fs.readFileSync(process.env.MICROS_DEVICE_FEATURE_CACHE_PATH, 'utf8'));",
        "console.log(JSON.stringify({ features: cache.micr123OS, notes, rawFeatures: rawFeatures.micr123OS, readResult, writeResult }));"
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
  assert.equal(parsed.readResult.mode, "read", "an empty note should read without applying the requested write mode");
  assert.equal(parsed.readResult.deviceNote, "Mounted on the terrace.", "an empty note should return the current note");
  assert.equal("featureCachePath" in parsed.writeResult, false, "set_device_note should not expose the feature cache path");
  assert.equal("notesCachePath" in parsed.writeResult, false, "set_device_note should not expose the notes cache path");
  assert.equal(parsed.features.discoveredAt, "2026-06-14T00:00:00.000Z", "feature discovery data should still update");
  assert.equal(parsed.notes.TerraceSensor, "Mounted on the terrace.", "device note should be stored by device name");
  assert.equal("micr123OS" in parsed.notes, false, "device note should not keep the UID key after writing");
  assert.equal("deviceNote" in parsed.rawFeatures, false, "feature cache should not persist device notes");
  assert.equal("deviceName" in parsed.rawFeatures, false, "feature cache should not duplicate device name");
}

async function testDiscoverCommandsDeviceNoteShape() {
  const tempDir = mkdtempSync(join(tmpdir(), "microsmcp-discover-note-test-"));
  const deviceCachePath = join(tempDir, "devices.json");
  const featureCachePath = join(tempDir, "features.json");
  const notesCachePath = join(tempDir, "notes.json");

  writeFileSync(
    deviceCachePath,
    JSON.stringify({
      micrOfflineOS: ["127.0.0.1", 65534, "OfflineSensor"]
    })
  );
  writeFileSync(featureCachePath, "{}");
  writeFileSync(notesCachePath, JSON.stringify({ OfflineSensor: "Mounted in the test cabinet." }));

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const mod = await import('./dist/mcp/tools/discover-commands.js'); const result = await mod.discoverCommands({ deviceTag: 'OfflineSensor', timeout: 1 }); console.log(JSON.stringify(result));"
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

  assert.equal(result.status, 0, `discoverCommands note shape check failed:\n${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.devices[0].device.deviceNote, "Mounted in the test cabinet.");
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
        "await discover.saveSuccessfulFeatureDiscoveries([{ ok: true, device: { uid: 'micr123OS', ip: '10.0.1.20', port: 9008, deviceName: 'TerraceSensor' }, discoveredAt: '2026-06-14T00:00:00.000Z', modules: [] }]);",
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
  assert.equal("deviceName" in parsed.rawFeatures, false, "migrated feature cache should remove duplicate device name");
}

testRequiredProjectFiles();
testFuzzyFieldMatching();
testMcpMetadataFilesCopied();
testDockerExcludesRuntimeData();
testCliHelpEntrypoints();
testNetworkPrefixEnvironmentOverride();
testChatConfigPersistence();
await testUiRequestLimit();
testUiAccessUrls();
testUiTabStructure();
testToolFormPolicy();
await testUiSelfSignedCertificate();
testSpeechRecognitionSupport();
testVoiceCaptureCleanup();
testToolEventTitles();
testChatKeyboardSubmission();
testChatTokenUsage();
testToolRegistry();
testCommandParsing();
await testCommandDenials();
testModuleParsing();
testHelpParsing();
testDiscoverDevicesHidesCachePath();
await testFunctionDocumentation();
await testCommandModuleHint();
testRunCommandResponseIncludesModuleHint();
testFeatureSearchFields();
await testListDevicesCompactShape();
await testSearchDevicesNoteShape();
await testSearchDevicesNoteMatchKeepsAllFeatures();
await testSearchDevicesExactModuleMatchPrunesFeatures();
await testSearchDevicesMultiWordFallback();
await testDiscoverCommandsDeviceNoteShape();
await testSetDeviceNoteTool();
await testLegacyFeatureNotesMigrateOnFeatureSave();

console.log("MCP server tests passed.");
