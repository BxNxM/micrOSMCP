function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function appendInlineMarkdown(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) {
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
    }

    const token = match[0];

    if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      const link = document.createElement("a");
      link.href = linkMatch?.[2] ?? "#";
      link.textContent = linkMatch?.[1] ?? token;
      link.target = "_blank";
      link.rel = "noreferrer";
      parent.append(link);
    } else {
      const emphasis = document.createElement("em");
      emphasis.textContent = token.slice(1, -1);
      parent.append(emphasis);
    }

    cursor = match.index + token.length;
  }

  if (cursor < text.length) {
    parent.append(document.createTextNode(text.slice(cursor)));
  }
}

function splitCollapsedTableRows(text) {
  return String(text || "No text response.")
    .split("\n")
    .flatMap((line) => {
      const tableStart = line.search(/\|[^|]+\|/);

      if (tableStart > 0 && line.slice(tableStart).split("|").length > 4) {
        return [line.slice(0, tableStart).trimEnd(), line.slice(tableStart).replace(/\|\s+\|/g, "|\n|")];
      }

      return line.replace(/\|\s+\|/g, "|\n|");
    })
    .join("\n")
    .split("\n");
}

function isTableLine(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}

function parseTableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function parseAlignment(cells) {
  if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    return null;
  }

  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");

    if (left && right) {
      return "center";
    }

    return right ? "right" : "left";
  });
}

function appendTableCell(row, tagName, text, align) {
  const cell = document.createElement(tagName);
  cell.style.textAlign = align;
  appendInlineMarkdown(cell, text);
  row.append(cell);
}

function renderTable(lines, startIndex) {
  const header = parseTableCells(lines[startIndex]);
  const alignment = parseAlignment(parseTableCells(lines[startIndex + 1] ?? ""));

  if (!alignment || alignment.length !== header.length) {
    return null;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "chat-table-wrap";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  header.forEach((cell, cellIndex) => {
    appendTableCell(headerRow, "th", cell, alignment[cellIndex] ?? "left");
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  let index = startIndex + 2;

  while (index < lines.length && isTableLine(lines[index])) {
    const cells = parseTableCells(lines[index]);

    if (cells.length !== header.length) {
      break;
    }

    const row = document.createElement("tr");
    cells.forEach((cell, cellIndex) => {
      appendTableCell(row, "td", cell, alignment[cellIndex] ?? "left");
    });
    tbody.append(row);
    index += 1;
  }

  table.append(tbody);
  wrapper.append(table);

  return {
    element: wrapper,
    nextIndex: index
  };
}

function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = splitCollapsedTableRows(text);
  let index = 0;

  function appendParagraph(paragraphLines) {
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join(" "));
    fragment.append(paragraph);
  }

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^```(\w+)?\s*$/);
    if (fenceMatch) {
      index += 1;
      const codeLines = [];

      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const heading = document.createElement(`h${headingMatch[1].length + 2}`);
      appendInlineMarkdown(heading, headingMatch[2]);
      fragment.append(heading);
      index += 1;
      continue;
    }

    if (isTableLine(line) && isTableLine(lines[index + 1] ?? "")) {
      const table = renderTable(lines, index);

      if (table) {
        fragment.append(table.element);
        index = table.nextIndex;
        continue;
      }
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const list = document.createElement("ul");

      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const item = document.createElement("li");
        appendInlineMarkdown(item, lines[index].replace(/^\s*[-*]\s+/, ""));
        list.append(item);
        index += 1;
      }

      fragment.append(list);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const list = document.createElement("ol");

      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        const item = document.createElement("li");
        appendInlineMarkdown(item, lines[index].replace(/^\s*\d+\.\s+/, ""));
        list.append(item);
        index += 1;
      }

      fragment.append(list);
      continue;
    }

    const paragraphLines = [];

    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index]) &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !isTableLine(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    appendParagraph(paragraphLines);
  }

  return fragment;
}

function createChatElement() {
  const section = document.createElement("section");
  section.className = "chat-panel";
  section.setAttribute("aria-label", "AI chat");
  section.innerHTML = `
    <div class="chat-header">
      <h2>AI Chat</h2>
      <div class="chat-settings">
        <label>
          <span>Token</span>
          <input data-chat-token type="password" autocomplete="off" placeholder="OpenAI API token" />
        </label>
        <label>
          <span>Model</span>
          <div class="model-control">
            <select data-chat-model></select>
            <button data-chat-refresh-models type="button" title="Refresh models" aria-label="Refresh models">
              <span aria-hidden="true">↻</span>
            </button>
          </div>
        </label>
        <label class="speak-toggle">
          <input data-chat-speak type="checkbox" />
          <span>Speak</span>
        </label>
      </div>
    </div>

    <div data-chat-log class="chat-log" aria-live="polite"></div>

    <form data-chat-form class="chat-form">
      <button data-chat-listen type="button" title="Listen" aria-label="Listen">
        <span aria-hidden="true">◉</span>
      </button>
      <textarea data-chat-input rows="2" placeholder="Ask about devices or request a tool call."></textarea>
      <button data-chat-send type="submit">Send</button>
    </form>
  `;
  return section;
}

export function initChat({ mount, onToolEvent } = {}) {
  if (!mount) {
    return;
  }

  const root = createChatElement();
  const apiTokenInput = root.querySelector("[data-chat-token]");
  const modelInput = root.querySelector("[data-chat-model]");
  const refreshModelsButton = root.querySelector("[data-chat-refresh-models]");
  const speakReplies = root.querySelector("[data-chat-speak]");
  const chatLog = root.querySelector("[data-chat-log]");
  const chatForm = root.querySelector("[data-chat-form]");
  const chatInput = root.querySelector("[data-chat-input]");
  const listenButton = root.querySelector("[data-chat-listen]");
  const sendChat = root.querySelector("[data-chat-send]");

  let chatMessages = [];
  let recognition = null;
  let saveTimer = null;

  function renderChatMessageBody(body, role, text) {
    body.textContent = "";

    if (role === "assistant") {
      body.append(renderMarkdown(text || "No text response."));
      return;
    }

    body.textContent = text || "";
  }

  function appendChatMessage(role, text) {
    const message = document.createElement("div");
    message.className = `chat-message ${role}`;
    const body = document.createElement("div");
    body.className = "chat-message-body";
    renderChatMessageBody(body, role, text || (role === "assistant" ? "No text response." : ""));
    message.append(body);
    chatLog.append(message);
    chatLog.scrollTop = chatLog.scrollHeight;
    return message;
  }

  function setChatMessageText(message, text) {
    const body = message.querySelector(".chat-message-body");
    const role = message.classList.contains("assistant") ? "assistant" : "plain";

    if (body) {
      renderChatMessageBody(body, role, text || "No text response.");
      return;
    }

    message.textContent = text || "No text response.";
  }

  function appendToolDetails(message, event) {
    const details = document.createElement("details");
    details.className = "chat-tool-details";

    const summary = document.createElement("summary");
    summary.textContent = `${event.name} raw tool response`;

    const output = document.createElement("pre");
    output.textContent = formatJson({
      name: event.name,
      arguments: event.arguments,
      result: event.result
    });

    details.append(summary, output);
    message.append(details);
  }

  function speak(text) {
    if (!speakReplies.checked || !("speechSynthesis" in window) || !text) {
      return;
    }

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  function stopSpeaking() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  function selectedModel() {
    return modelInput.value || "gpt-4.1-mini";
  }

  async function callChat() {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        apiKey: apiTokenInput.value,
        model: selectedModel(),
        messages: chatMessages
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Chat request failed.");
    }

    return payload;
  }

  async function loadChatConfig() {
    const response = await fetch("/api/chat-config");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Failed to load chat config.");
    }

    apiTokenInput.value = payload.apiKey ?? "";
    setModelOptions([payload.model || "gpt-4.1-mini"], payload.model || "gpt-4.1-mini");
  }

  async function saveChatConfig() {
    const response = await fetch("/api/chat-config", {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        apiKey: apiTokenInput.value,
        model: selectedModel()
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      appendChatMessage("error", payload.error || "Failed to save chat config.");
    }
  }

  function queueSaveChatConfig() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveChatConfig();
    }, 350);
  }

  function setModelOptions(models, selected) {
    const availableModels = [...new Set(models.filter(Boolean))];

    if (availableModels.length === 0) {
      availableModels.push(selected || "gpt-4.1-mini");
    }

    modelInput.textContent = "";

    for (const model of availableModels) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      modelInput.append(option);
    }

    modelInput.value = availableModels.includes(selected) ? selected : availableModels[0];
  }

  async function loadAvailableModels() {
    refreshModelsButton.disabled = true;

    try {
      if (!apiTokenInput.value.trim()) {
        setModelOptions([selectedModel()], selectedModel());
        return;
      }

      const response = await fetch("/api/chat-models", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          apiKey: apiTokenInput.value
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Failed to load models.");
      }

      setModelOptions(payload.models ?? [], payload.selectedModel ?? selectedModel());
    } catch (error) {
      appendChatMessage("error", error instanceof Error ? error.message : "Failed to load models.");
    } finally {
      refreshModelsButton.disabled = false;
    }
  }

  function queueSaveAndRefreshModels() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void saveChatConfig().then(loadAvailableModels);
    }, 500);
  }

  function appendToolEvents(toolEvents, message) {
    for (const event of toolEvents ?? []) {
      if (message) {
        appendToolDetails(message, event);
      } else {
        const toolMessage = appendChatMessage("tool", event.name);
        appendToolDetails(toolMessage, event);
      }

      onToolEvent?.(event);
    }

    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function sendChatMessage(event) {
    event.preventDefault();

    const text = chatInput.value.trim();

    if (!text) {
      return;
    }

    if (!apiTokenInput.value.trim()) {
      appendChatMessage("error", "OpenAI API token is required.");
      apiTokenInput.focus();
      return;
    }

    chatInput.value = "";
    chatMessages.push({ role: "user", content: text });
    appendChatMessage("user", text);
    sendChat.disabled = true;
    listenButton.disabled = true;
    const pending = appendChatMessage("assistant", "Thinking...");

    try {
      const payload = await callChat();
      const reply = payload.message || "Done.";
      setChatMessageText(pending, reply);
      chatMessages.push({ role: "assistant", content: reply });
      appendToolEvents(payload.toolEvents, pending);
      speak(reply);
    } catch (error) {
      pending.className = "chat-message error";
      setChatMessageText(pending, error instanceof Error ? error.message : "Chat request failed.");
    } finally {
      sendChat.disabled = false;
      listenButton.disabled = !recognition;
      chatInput.focus();
    }
  }

  function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      listenButton.disabled = true;
      listenButton.title = "Speech recognition is not available in this browser";
      return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.addEventListener("start", () => {
      listenButton.classList.add("listening");
    });
    recognition.addEventListener("end", () => {
      listenButton.classList.remove("listening");
    });
    recognition.addEventListener("result", (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join("")
        .trim();

      if (transcript) {
        chatInput.value = transcript;
      }
    });
  }

  function startListening() {
    if (recognition) {
      recognition.start();
    }
  }

  chatForm.addEventListener("submit", sendChatMessage);
  listenButton.addEventListener("click", startListening);
  refreshModelsButton.addEventListener("click", loadAvailableModels);
  speakReplies.addEventListener("change", () => {
    if (!speakReplies.checked) {
      stopSpeaking();
    }
  });
  apiTokenInput.addEventListener("input", queueSaveChatConfig);
  apiTokenInput.addEventListener("blur", queueSaveAndRefreshModels);
  modelInput.addEventListener("change", queueSaveChatConfig);

  setupSpeechRecognition();
  void loadChatConfig()
    .catch((error) => {
      appendChatMessage("error", error instanceof Error ? error.message : "Failed to load chat config.");
    })
    .finally(() => {
      void loadAvailableModels();
      appendChatMessage("assistant", "Ready.");
    });

  mount.replaceChildren(root);
}
