import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { createChatReply, listOpenAiModels, readChatConfig, saveChatConfig, transcribeAudio } from "./chat-bridge.js";

const preferredPort = Number(process.env.PORT ?? 3333);
const host = process.env.HOST ?? "0.0.0.0";
const uiAssetsDir = fileURLToPath(new URL("../../ui/assets", import.meta.url));
const mcpServerPath = fileURLToPath(new URL("../mcp/index.js", import.meta.url));
let client: Client | null = null;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendError(response: ServerResponse, statusCode: number, message: string) {
  sendJson(response, statusCode, { error: message });
}

function localIpv4Addresses() {
  const addresses: string[] = [];

  for (const networkInterface of Object.values(networkInterfaces())) {
    for (const address of networkInterface ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        addresses.push(address.address);
      }
    }
  }

  return [...new Set(addresses)];
}

export function displayHosts(boundHost: string, addresses = localIpv4Addresses(), networkPrefix = process.env.MICROS_NETWORK_PREFIX) {
  if (boundHost !== "0.0.0.0" && boundHost !== "::") {
    return [boundHost];
  }

  const prioritized = networkPrefix
    ? [
        ...addresses.filter((address) => address.startsWith(`${networkPrefix}.`)),
        ...addresses.filter((address) => !address.startsWith(`${networkPrefix}.`))
      ]
    : addresses;

  return ["127.0.0.1", ...prioritized];
}

export function accessUrls(boundHost: string, port: number, addresses = localIpv4Addresses(), networkPrefix = process.env.MICROS_NETWORK_PREFIX) {
  const urls = displayHosts(boundHost, addresses, networkPrefix).map((address) => `http://${address}:${port}`);
  return [...new Set(urls)];
}

function printAccessUrls(boundHost: string, port: number) {
  const urls = accessUrls(boundHost, port);

  console.log(`micrOSMCP test UI listening on ${boundHost}:${port}`);
  for (const url of urls) {
    console.log(`  ${url}`);
  }
}

async function serveStatic(pathname: string, response: ServerResponse) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = normalize(join(uiAssetsDir, requestedPath));
  const relativePath = relative(uiAssetsDir, absolutePath);

  if (relativePath === ".." || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(absolutePath);
    response.writeHead(200, {
      "content-type": contentTypes[extname(absolutePath)] ?? "application/octet-stream"
    });
    response.end(body);
  } catch {
    sendError(response, 404, "Not found");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (!client) {
      sendError(response, 503, "MCP bridge is not ready.");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/tools") {
      sendJson(response, 200, await client.listTools());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/call-tool") {
      const body = await readJsonBody(request);

      if (!body || typeof body.name !== "string") {
        sendError(response, 400, "Expected a tool name.");
        return;
      }

      sendJson(
        response,
        200,
        await client.callTool({
          name: body.name,
          arguments: typeof body.arguments === "object" && body.arguments !== null ? body.arguments : {}
        })
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      sendJson(response, 200, await createChatReply(client, await readJsonBody(request)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/transcribe") {
      sendJson(response, 200, await transcribeAudio(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chat-config") {
      sendJson(response, 200, await readChatConfig());
      return;
    }

    if ((request.method === "POST" || request.method === "PUT") && url.pathname === "/api/chat-config") {
      sendJson(response, 200, await saveChatConfig(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/chat-models") {
      sendJson(response, 200, await listOpenAiModels());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat-models") {
      sendJson(response, 200, await listOpenAiModels(await readJsonBody(request)));
      return;
    }

    if (request.method === "GET") {
      await serveStatic(url.pathname, response);
      return;
    }

    sendError(response, 405, "Method not allowed");
  } catch (error) {
    sendError(response, 500, error instanceof Error ? error.message : "Unknown error");
  }
});

function listen(port: number) {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && !process.env.PORT) {
      listen(port + 1);
      return;
    }

    console.error(error.message);
    process.exit(1);
  });

  server.listen(port, host, () => {
    printAccessUrls(host, port);
  });
}

async function startUiServer() {
  client = new Client({
    name: "microsmcp-ui",
    version: "0.1.0"
  });

  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    env: childEnv
  });

  await client.connect(transport);
  listen(preferredPort);
}

async function shutdown() {
  await client?.close();
  server.close(() => process.exit(0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await startUiServer();

  process.on("SIGINT", () => {
    void shutdown();
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });
}
