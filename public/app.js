const toolList = document.querySelector("#toolList");
const toolCount = document.querySelector("#toolCount");
const refreshTools = document.querySelector("#refreshTools");
const runTool = document.querySelector("#runTool");
const selectedToolName = document.querySelector("#selectedToolName");
const selectedToolDescription = document.querySelector("#selectedToolDescription");
const parameterForm = document.querySelector("#parameterForm");
const argumentsInput = document.querySelector("#argumentsInput");
const schemaOutput = document.querySelector("#schemaOutput");
const resultOutput = document.querySelector("#resultOutput");

let tools = [];
let devices = [];
let selectedTool = null;

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function parseToolText(payload) {
  const text = payload?.content?.find((entry) => entry.type === "text")?.text;

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callTool(name, args = {}) {
  const response = await fetch("/api/call-tool", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name,
      arguments: args
    })
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Tool call failed.");
  }

  return payload;
}

async function refreshDevices() {
  try {
    const payload = await callTool("list_devices");
    const parsed = parseToolText(payload);
    devices = Array.isArray(parsed?.devices) ? parsed.devices : [];
  } catch {
    devices = [];
  }
}

function defaultValueFor(name, schema, toolName) {
  if (name === "deviceTag" || name === "deviceName") {
    const preferredDevice = devices.find((device) => !String(device.uid).startsWith("__")) ?? devices[0];
    return preferredDevice?.fuid || preferredDevice?.uid || "__localhost__";
  }

  if (name === "command") {
    return "version";
  }

  if (name === "query") {
    return "Tiny";
  }

  if (name === "port") {
    return 9008;
  }

  if (name === "timeout") {
    return 10;
  }

  if (name === "timeoutMs") {
    return 1000;
  }

  if (name === "concurrency") {
    return toolName === "discover_commands" ? 3 : 50;
  }

  if (name === "startHost") {
    return 2;
  }

  if (name === "endHost") {
    return 254;
  }

  if (schema?.type === "boolean") {
    return false;
  }

  return "";
}

function defaultArguments(tool) {
  const schema = tool.inputSchema ?? {};
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const args = {};

  for (const [name, property] of Object.entries(properties)) {
    const value = defaultValueFor(name, property, tool.name);

    if (required.has(name) || value !== "" && value !== false) {
      args[name] = value;
    }
  }

  return args;
}

function setResult(value, isError = false) {
  resultOutput.textContent = typeof value === "string" ? value : formatJson(value);
  resultOutput.classList.toggle("error", isError);
}

function propertyType(schema) {
  if (schema?.enum) {
    return "enum";
  }

  if (schema?.anyOf) {
    return "text";
  }

  return schema?.type ?? "text";
}

function createDeviceSelect(name, required, value) {
  const select = document.createElement("select");
  select.name = name;
  select.required = required;

  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.fuid || device.uid || device.ip;
    option.textContent = `${device.fuid || device.uid} (${device.ip})`;
    select.append(option);
  }

  const custom = document.createElement("option");
  custom.value = value || "__localhost__";
  custom.textContent = devices.length > 0 ? "Custom/default target" : "__localhost__";
  select.append(custom);
  select.value = value || select.options[0]?.value || "__localhost__";

  return select;
}

function createParameterControl(name, schema, required, value) {
  if (name === "deviceTag" || name === "deviceName") {
    return createDeviceSelect(name, required, value);
  }

  if (schema?.enum) {
    const select = document.createElement("select");
    select.name = name;
    select.required = required;

    if (!required) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "Any";
      select.append(empty);
    }

    for (const entry of schema.enum) {
      const option = document.createElement("option");
      option.value = entry;
      option.textContent = entry;
      select.append(option);
    }

    select.value = value || "";
    return select;
  }

  if (schema?.type === "boolean") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.checked = Boolean(value);
    return input;
  }

  if (schema?.type === "number" || schema?.type === "integer") {
    const input = document.createElement("input");
    input.type = "number";
    input.name = name;
    input.value = value === "" ? "" : String(value);
    input.required = required;

    if (schema.minimum !== undefined) {
      input.min = String(schema.minimum);
    }

    if (schema.maximum !== undefined) {
      input.max = String(schema.maximum);
    }

    return input;
  }

  if (name === "command") {
    const textarea = document.createElement("textarea");
    textarea.name = name;
    textarea.required = required;
    textarea.rows = 3;
    textarea.value = String(value || "version");
    return textarea;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.name = name;
  input.value = String(value ?? "");
  input.required = required;
  return input;
}

function collectFormArguments() {
  const properties = selectedTool?.inputSchema?.properties ?? {};
  const required = new Set(selectedTool?.inputSchema?.required ?? []);
  const args = {};

  for (const [name, schema] of Object.entries(properties)) {
    const field = parameterForm.elements.namedItem(name);

    if (!field) {
      continue;
    }

    if (schema.type === "boolean") {
      if (field.checked || required.has(name)) {
        args[name] = field.checked;
      }
      continue;
    }

    const rawValue = field.value?.trim?.() ?? "";

    if (rawValue === "" && !required.has(name)) {
      continue;
    }

    if (schema.type === "number" || schema.type === "integer") {
      args[name] = Number(rawValue);
      continue;
    }

    if (name === "command" && rawValue.includes("\n")) {
      args[name] = rawValue.split("\n").map((entry) => entry.trim()).filter(Boolean);
      continue;
    }

    args[name] = rawValue;
  }

  return args;
}

function syncJsonFromForm() {
  argumentsInput.value = formatJson(collectFormArguments());
}

function renderParameterForm(tool) {
  parameterForm.textContent = "";
  const schema = tool.inputSchema ?? {};
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const defaults = defaultArguments(tool);

  if (Object.keys(properties).length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-params";
    empty.textContent = "No parameters.";
    parameterForm.append(empty);
    return;
  }

  for (const [name, property] of Object.entries(properties)) {
    const label = document.createElement("label");
    label.className = "param-field";

    const heading = document.createElement("span");
    heading.className = "param-name";
    heading.textContent = `${name}${required.has(name) ? " *" : ""}`;

    const control = createParameterControl(name, property, required.has(name), defaults[name]);
    const description = document.createElement("small");
    description.textContent = property.description || propertyType(property);

    label.append(heading, control, description);
    parameterForm.append(label);
  }
}

function selectTool(tool) {
  selectedTool = tool;
  selectedToolName.textContent = tool.title || tool.name;
  selectedToolDescription.textContent = tool.description || "No description provided.";
  schemaOutput.textContent = formatJson(tool.inputSchema ?? {});
  renderParameterForm(tool);
  syncJsonFromForm();
  argumentsInput.disabled = false;
  runTool.disabled = false;

  for (const button of toolList.querySelectorAll(".tool-button")) {
    button.classList.toggle("active", button.dataset.name === tool.name);
  }
}

function renderTools() {
  toolList.textContent = "";
  toolCount.textContent = String(tools.length);

  for (const tool of tools) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tool-button";
    button.dataset.name = tool.name;

    const name = document.createElement("strong");
    name.textContent = tool.title || tool.name;

    const description = document.createElement("span");
    description.textContent = tool.description || tool.name;

    button.append(name, description);
    button.addEventListener("click", () => selectTool(tool));
    toolList.append(button);
  }

  if (tools.length > 0) {
    selectTool(tools[0]);
  }
}

async function loadTools() {
  refreshTools.disabled = true;
  setResult("Loading tools...");

  try {
    const response = await fetch("/api/tools");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load tools.");
    }

    tools = payload.tools ?? [];
    await refreshDevices();
    renderTools();
    setResult("Tools loaded.");
  } catch (error) {
    setResult(error instanceof Error ? error.message : "Failed to load tools.", true);
  } finally {
    refreshTools.disabled = false;
  }
}

async function callSelectedTool() {
  if (!selectedTool) {
    return;
  }

  let parsedArguments;

  try {
    parsedArguments = JSON.parse(argumentsInput.value || "{}");
  } catch (error) {
    setResult(error instanceof Error ? error.message : "Invalid JSON arguments.", true);
    return;
  }

  runTool.disabled = true;
  setResult(`Calling ${selectedTool.name}...`);

  try {
    const payload = await callTool(selectedTool.name, parsedArguments);
    setResult(payload, Boolean(payload.isError));

    if (selectedTool.name === "discover_devices") {
      await refreshDevices();
      selectTool(selectedTool);
    }
  } catch (error) {
    setResult(error instanceof Error ? error.message : "Tool call failed.", true);
  } finally {
    runTool.disabled = false;
  }
}

parameterForm.addEventListener("input", syncJsonFromForm);
parameterForm.addEventListener("change", syncJsonFromForm);
refreshTools.addEventListener("click", loadTools);
runTool.addEventListener("click", callSelectedTool);

await loadTools();
