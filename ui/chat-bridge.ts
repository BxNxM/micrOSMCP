import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatRequestBody = {
  apiKey?: unknown;
  model?: unknown;
  messages?: unknown;
};

export type ChatConfig = {
  apiKey: string;
  model: string;
};

export const chatConfigPath =
  process.env.MICROS_CHAT_CONFIG_PATH ?? resolve(process.cwd(), "data/ui_chat_config.json");

const defaultChatConfig: ChatConfig = {
  apiKey: "",
  model: "gpt-4.1-mini"
};

function normalizeChatConfig(input: unknown): ChatConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return defaultChatConfig;
  }

  const candidate = input as Partial<ChatConfig>;

  return {
    apiKey: typeof candidate.apiKey === "string" ? candidate.apiKey : "",
    model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : defaultChatConfig.model
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

export async function listOpenAiModels(input: unknown = {}) {
  const savedConfig = await readChatConfig();
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : savedConfig.apiKey;

  if (!apiKey) {
    return {
      models: [savedConfig.model || defaultChatConfig.model],
      selectedModel: savedConfig.model || defaultChatConfig.model,
      needsToken: true
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
    needsToken: false
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
    throw new Error("Expected an OpenAI API token.");
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
      content:
        "You are testing a local micrOS MCP server. Use the available tools when a tool call is useful. Prefer read-only commands unless the user explicitly asks for a state change."
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
