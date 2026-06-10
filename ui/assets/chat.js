function formatJson(value) {
  return JSON.stringify(value, null, 2);
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

  function appendChatMessage(role, text) {
    const message = document.createElement("div");
    message.className = `chat-message ${role}`;
    message.textContent = text || (role === "assistant" ? "No text response." : "");
    chatLog.append(message);
    chatLog.scrollTop = chatLog.scrollHeight;
    return message;
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

  function appendToolEvents(toolEvents) {
    for (const event of toolEvents ?? []) {
      appendChatMessage("tool", `${event.name}\n${formatJson(event.result)}`);
      onToolEvent?.(event);
    }
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
      pending.textContent = reply;
      chatMessages.push({ role: "assistant", content: reply });
      appendToolEvents(payload.toolEvents);
      speak(reply);
    } catch (error) {
      pending.className = "chat-message error";
      pending.textContent = error instanceof Error ? error.message : "Chat request failed.";
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
