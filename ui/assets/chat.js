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
        <button data-chat-clear class="chat-clear" type="button" title="Clear chat" aria-label="Clear chat">
          Clear
        </button>
      </div>
    </div>

    <div data-chat-log class="chat-log" aria-live="polite"></div>

    <form data-chat-form class="chat-form">
      <button data-chat-listen type="button" title="Listen" aria-label="Listen" aria-pressed="false">
        <span aria-hidden="true">◉</span>
      </button>
      <textarea data-chat-input rows="2" placeholder="Ask about devices or request a tool call."></textarea>
      <button data-chat-send type="submit">Send</button>
      <span data-chat-listen-status class="chat-listen-status" role="status"></span>
    </form>
  `;
  return section;
}

export function speechRecognitionSupport({
  SpeechRecognition,
  webkitSpeechRecognition,
  isSecureContext,
  protocol,
  hostname,
  port
} = {}) {
  const recognitionConstructor = SpeechRecognition || webkitSpeechRecognition || null;

  if (!recognitionConstructor) {
    return {
      ok: false,
      reason: "Speech recognition is not available in this browser.",
      Recognition: null
    };
  }

  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const secure = Boolean(isSecureContext) || protocol === "https:" || isLocalhost;

  if (!secure) {
    const localUrl = `http://127.0.0.1${port ? `:${port}` : ""}`;

    return {
      ok: false,
      reason: `Microphone requires HTTPS or localhost. Open the UI from ${localUrl} on this machine.`,
      Recognition: null
    };
  }

  return {
    ok: true,
    reason: "",
    Recognition: recognitionConstructor
  };
}

export function audioRecordingSupport({
  mediaDevices,
  MediaRecorder,
  isSecureContext,
  protocol,
  hostname,
  port
} = {}) {
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const secure = Boolean(isSecureContext) || protocol === "https:" || isLocalhost;

  if (!secure) {
    const localUrl = `http://127.0.0.1${port ? `:${port}` : ""}`;

    return {
      ok: false,
      reason: `Microphone requires HTTPS or localhost. Open the UI from ${localUrl} on this machine.`
    };
  }

  if (!mediaDevices?.getUserMedia || !MediaRecorder) {
    return {
      ok: false,
      reason: "Audio recording is not available in this browser."
    };
  }

  return {
    ok: true,
    reason: ""
  };
}

function preferredAudioMimeType(MediaRecorder) {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((type) => MediaRecorder?.isTypeSupported?.(type)) ?? "";
}

function audioFilename(mimeType) {
  if (mimeType.includes("mp4")) {
    return "microsmcp-recording.mp4";
  }

  if (mimeType.includes("ogg")) {
    return "microsmcp-recording.ogg";
  }

  return "microsmcp-recording.webm";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.split(",")[1] ?? "");
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read recorded audio.")));
    reader.readAsDataURL(blob);
  });
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
  const clearChatButton = root.querySelector("[data-chat-clear]");
  const chatLog = root.querySelector("[data-chat-log]");
  const chatForm = root.querySelector("[data-chat-form]");
  const chatInput = root.querySelector("[data-chat-input]");
  const listenButton = root.querySelector("[data-chat-listen]");
  const listenStatus = root.querySelector("[data-chat-listen-status]");
  const sendChat = root.querySelector("[data-chat-send]");

  let chatMessages = [];
  let recognition = null;
  let isListening = false;
  let mediaRecorder = null;
  let mediaStream = null;
  let audioChunks = [];
  let voiceMode = "none";
  let saveTimer = null;
  let chatVersion = 0;

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
    if (isListening || !speakReplies.checked || !("speechSynthesis" in window) || !text) {
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

  function clearChatHistory() {
    chatVersion += 1;
    chatMessages = [];
    chatLog.textContent = "";
    chatInput.value = "";
    stopSpeaking();

    if (isListening) {
      if (recognition) {
        recognition.stop();
      } else if (mediaRecorder?.state === "recording") {
        mediaRecorder.stop();
      }
    }

    sendChat.disabled = false;
    listenButton.disabled = voiceMode === "none";
    listenStatus.textContent = listenButton.disabled ? listenStatus.textContent : "";
    appendChatMessage("assistant", "Ready.");
    chatInput.focus();
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
    const requestVersion = chatVersion;

    try {
      const payload = await callChat();

      if (requestVersion !== chatVersion) {
        return;
      }

      const reply = payload.message || "Done.";
      setChatMessageText(pending, reply);
      chatMessages.push({ role: "assistant", content: reply });
      appendToolEvents(payload.toolEvents, pending);
      speak(reply);
    } catch (error) {
      if (requestVersion !== chatVersion) {
        return;
      }

      pending.className = "chat-message error";
      setChatMessageText(pending, error instanceof Error ? error.message : "Chat request failed.");
    } finally {
      sendChat.disabled = false;
      listenButton.disabled = voiceMode === "none";
      chatInput.focus();
    }
  }

  async function transcribeBlob(blob) {
    const base64 = await blobToBase64(blob);
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        apiKey: apiTokenInput.value,
        audio: {
          base64,
          type: blob.type || "audio/webm",
          filename: audioFilename(blob.type || "audio/webm")
        }
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Transcription failed.");
    }

    return payload.text ?? "";
  }

  function resetListenButton() {
    isListening = false;
    listenButton.classList.remove("listening");
    listenButton.setAttribute("aria-pressed", "false");
    listenButton.title = voiceMode === "recording" ? "Record" : "Listen";
    listenButton.setAttribute("aria-label", voiceMode === "recording" ? "Record" : "Listen");
  }

  function setupSpeechRecognition() {
    const support = speechRecognitionSupport({
      SpeechRecognition: window.SpeechRecognition,
      webkitSpeechRecognition: window.webkitSpeechRecognition,
      isSecureContext: window.isSecureContext,
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      port: window.location.port
    });

    if (support.ok) {
      voiceMode = "speech";
      recognition = new support.Recognition();
    } else {
      const recordingSupport = audioRecordingSupport({
        mediaDevices: navigator.mediaDevices,
        MediaRecorder: window.MediaRecorder,
        isSecureContext: window.isSecureContext,
        protocol: window.location.protocol,
        hostname: window.location.hostname,
        port: window.location.port
      });

      if (!recordingSupport.ok) {
        listenButton.disabled = true;
        listenButton.title = support.reason.includes("secure") ? support.reason : recordingSupport.reason;
        listenStatus.textContent = listenButton.title;
        return;
      }

      voiceMode = "recording";
      listenButton.disabled = false;
      listenButton.title = "Record";
      listenButton.setAttribute("aria-label", "Record");
      listenStatus.textContent = "Safari fallback: record audio, then transcribe it with OpenAI.";
      return;
    }

    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.addEventListener("start", () => {
      isListening = true;
      stopSpeaking();
      listenButton.classList.add("listening");
      listenButton.setAttribute("aria-pressed", "true");
      listenButton.title = "Stop listening";
      listenButton.setAttribute("aria-label", "Stop listening");
      listenStatus.textContent = "";
    });
    recognition.addEventListener("end", () => {
      resetListenButton();
    });
    recognition.addEventListener("error", (event) => {
      const message =
        event.error === "not-allowed"
          ? "Microphone permission was denied by the browser."
          : event.error
            ? `Speech recognition stopped: ${event.error}.`
            : "Speech recognition stopped.";

      listenStatus.textContent = message;
      listenButton.title = message;
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

  async function startRecording() {
    if (!apiTokenInput.value.trim()) {
      listenStatus.textContent = "OpenAI API token is required for Safari microphone transcription.";
      apiTokenInput.focus();
      return;
    }

    try {
      stopSpeaking();
      listenStatus.textContent = "";
      audioChunks = [];
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredAudioMimeType(window.MediaRecorder);
      mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size > 0) {
          audioChunks.push(event.data);
        }
      });
      mediaRecorder.addEventListener("stop", () => {
        const tracks = mediaStream?.getTracks?.() ?? [];
        tracks.forEach((track) => track.stop());
        mediaStream = null;
        const blob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || mimeType || "audio/webm" });
        audioChunks = [];

        if (blob.size === 0) {
          listenStatus.textContent = "No audio was recorded.";
          return;
        }

        listenButton.disabled = true;
        listenStatus.textContent = "Transcribing...";
        void transcribeBlob(blob)
          .then((text) => {
            if (text.trim()) {
              chatInput.value = text.trim();
              listenStatus.textContent = "";
              chatInput.focus();
            } else {
              listenStatus.textContent = "No speech was detected.";
            }
          })
          .catch((error) => {
            listenStatus.textContent = error instanceof Error ? error.message : "Transcription failed.";
          })
          .finally(() => {
            listenButton.disabled = false;
          });
      });
      mediaRecorder.start();
      isListening = true;
      listenButton.classList.add("listening");
      listenButton.setAttribute("aria-pressed", "true");
      listenButton.title = "Stop recording";
      listenButton.setAttribute("aria-label", "Stop recording");
    } catch (error) {
      resetListenButton();
      listenStatus.textContent = error instanceof Error ? error.message : "Could not start microphone.";
    }
  }

  function toggleListening() {
    if (voiceMode === "recording") {
      if (mediaRecorder?.state === "recording") {
        mediaRecorder.stop();
        resetListenButton();
        return;
      }

      void startRecording();
      return;
    }

    if (!recognition) {
      return;
    }

    if (isListening) {
      recognition.stop();
      return;
    }

    try {
      stopSpeaking();
      listenStatus.textContent = "";
      recognition.start();
    } catch (error) {
      isListening = false;
      listenButton.classList.remove("listening");
      listenStatus.textContent = error instanceof Error ? error.message : "Could not start microphone.";
    }
  }

  chatForm.addEventListener("submit", sendChatMessage);
  listenButton.addEventListener("click", toggleListening);
  clearChatButton.addEventListener("click", clearChatHistory);
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
