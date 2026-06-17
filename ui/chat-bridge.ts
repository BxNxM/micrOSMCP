import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function loadChatSystemPrompt(promptUrl?: URL) {
  if (promptUrl) {
    return (await readFile(promptUrl, "utf8")).trim();
  }

  const candidates = [
    new URL("./chat-system-prompt.md", import.meta.url),
    new URL("../../ui/chat-system-prompt.md", import.meta.url)
  ];
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      return (await readFile(candidate, "utf8")).trim();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

const chatSystemPrompt = await loadChatSystemPrompt();

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatRequestBody = {
  apiKey?: unknown;
  model?: unknown;
  messages?: unknown;
};

type TranscribeRequestBody = {
  apiKey?: unknown;
  audio?: unknown;
};

export type ChatConfig = {
  apiKey: string;
  model: string;
  speakReplies: boolean;
};

export const chatConfigPath =
  process.env.MICROS_CHAT_CONFIG_PATH ?? resolve(process.cwd(), "data/ui_chat_config.json");

const defaultChatConfig: ChatConfig = {
  apiKey: "",
  model: "gpt-4.1-mini",
  speakReplies: false
};

function normalizeChatConfig(input: unknown): ChatConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return defaultChatConfig;
  }

  const candidate = input as Partial<ChatConfig>;

  return {
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : "",
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : defaultChatConfig.model,
    speakReplies: typeof candidate.speakReplies === "boolean" ? candidate.speakReplies : defaultChatConfig.speakReplies
  };
}

export async function readChatConfig(): Promise<ChatConfig> {
  try {
    return normalizeChatConfig(JSON.parse(await readFile(chatConfigPath, "utf8")));
  } catch {
    return defaultChatConfig;
  }
}

export async function saveChatConfig(input: unknown): Promise<ChatConfig> {
  const config = normalizeChatConfig(input);
  await mkdir(dirname(chatConfigPath), { recursive: true });
  await writeFile(chatConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function isLikelyLlmModel(id: string) {
  const excludedTokens = ["audio", "image", "realtime", "transcribe", "tts", "whisper"];

  if (excludedTokens.some((token) => id.includes(token))) {
    return false;
  }

  return (
    id.startsWith("gpt-") ||
    /^o\d/.test(id) ||
    id.startsWith("chatgpt-")
  );
}

function sortModelIds(modelIds: string[]) {
  return [...new Set(modelIds)].sort((left, right) => {
    const leftMini = left.includes("mini") ? 1 : 0;
    const rightMini = right.includes("mini") ? 1 : 0;

    if (leftMini !== rightMini) {
      return leftMini - rightMini;
    }

    return left.localeCompare(right);
  });
}

function audioExtension(mimeType: string) {
  if (mimeType.includes("mp4")) {
    return "mp4";
  }

  if (mimeType.includes("mpeg")) {
    return "mp3";
  }

  if (mimeType.includes("wav")) {
    return "wav";
  }

  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  return "webm";
}

export async function listOpenAiModels(input: unknown = {}) {
  const savedConfig = await readChatConfig();
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : savedConfig.apiKey;

  if (!apiKey) {
    return {
      models: [savedConfig.model || defaultChatConfig.model],
      selectedModel: savedConfig.model || defaultChatConfig.model,
      needsApiKey: true
    };
  }

  const response = await fetch("https://api.openai.com/v1/models", {
    headers: {
      authorization: `Bearer ${apiKey}`
    }
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error?.message ?? `OpenAI models request failed with ${response.status}.`;
    throw new Error(message);
  }

  const apiModels = Array.isArray(payload?.data)
    ? payload.data.map((model: any) => model?.id).filter((id: unknown): id is string => typeof id === "string")
    : [];
  const selectedModel = savedConfig.model || defaultChatConfig.model;
  const models = sortModelIds([...apiModels.filter(isLikelyLlmModel), selectedModel]);

  return {
    models,
    selectedModel,
    needsApiKey: false
  };
}

export async function transcribeAudio(body: TranscribeRequestBody) {
  const savedConfig = await readChatConfig();
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : savedConfig.apiKey;

  if (!apiKey) {
    throw new Error("Expected an OpenAI API key.");
  }

  const audio = body.audio && typeof body.audio === "object" ? (body.audio as Record<string, unknown>) : {};
  const base64 = typeof audio.base64 === "string" ? audio.base64 : "";
  const mimeType = typeof audio.type === "string" && audio.type.trim() ? audio.type.trim() : "audio/webm";

  if (!base64) {
    throw new Error("Expected recorded audio.");
  }

  const bytes = Buffer.from(base64, "base64");
  const formData = new FormData();
  formData.set("model", process.env.MICROS_TRANSCRIPTION_MODEL ?? "whisper-1");
  formData.set(
    "file",
    new Blob([bytes], { type: mimeType }),
    typeof audio.filename === "string" && audio.filename.trim()
      ? audio.filename.trim()
      : `microsmcp-recording.${audioExtension(mimeType)}`
  );

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`
    },
    body: formData
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error?.message ?? `OpenAI transcription request failed with ${response.status}.`;
    throw new Error(message);
  }

  return {
    text: typeof payload?.text === "string" ? payload.text : ""
  };
}

function parseToolText(payload: any) {
  const text = payload?.content?.find?.((entry: any) => entry.type === "text")?.text;

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function cleanOpenAIMessage(message: unknown): ChatMessage | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidate = message as Partial<ChatMessage>;

  if (candidate.role !== "user" && candidate.role !== "assistant") {
    return null;
  }

  return {
    role: candidate.role,
    content: typeof candidate.content === "string" ? candidate.content : ""
  };
}

async function openAiChatCompletion(apiKey: string, body: unknown) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.error?.message ?? `OpenAI request failed with ${response.status}.`;
    throw new Error(message);
  }

  return payload;
}

export async function createChatReply(client: Client, body: ChatRequestBody) {
  const savedConfig = await readChatConfig();
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : savedConfig.apiKey;

  if (!apiKey) {
    throw new Error("Expected an OpenAI API key.");
  }

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : savedConfig.model;
  const incomingMessages = Array.isArray(body.messages) ? body.messages.map(cleanOpenAIMessage).filter(Boolean) : [];
  const listedTools = await client.listTools();
  const tools = (listedTools.tools ?? []).map((tool: any) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters: tool.inputSchema ?? {
        type: "object",
        properties: {}
      }
    }
  }));

  const messages: any[] = [
    {
      role: "system",
      content: chatSystemPrompt
    },
    ...incomingMessages
  ];
  const toolEvents: unknown[] = [];

  for (let step = 0; step < 4; step += 1) {
    const completion = await openAiChatCompletion(apiKey, {
      model,
      messages,
      tools,
      tool_choice: "auto"
    });
    const assistantMessage = completion?.choices?.[0]?.message;

    if (!assistantMessage) {
      throw new Error("OpenAI did not return a chat message.");
    }

    messages.push(assistantMessage);

    if (!Array.isArray(assistantMessage.tool_calls) || assistantMessage.tool_calls.length === 0) {
      return {
        message: assistantMessage.content ?? "",
        toolEvents
      };
    }

    for (const toolCall of assistantMessage.tool_calls) {
      const name = toolCall?.function?.name;
      const rawArguments = toolCall?.function?.arguments ?? "{}";
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(rawArguments);
      } catch {
        args = {};
      }

      const payload = await client.callTool({
        name,
        arguments: args
      });
      const result = parseToolText(payload) ?? payload;

      toolEvents.push({
        name,
        arguments: args,
        result
      });
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: typeof result === "string" ? result : JSON.stringify(result)
      });
    }
  }

  return {
    message: "Stopped after multiple tool calls. Please narrow the request and try again.",
    toolEvents
  };
}
