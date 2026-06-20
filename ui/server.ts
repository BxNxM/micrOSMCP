import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { X509Certificate, createPrivateKey, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import {
  createChatReply,
  listOpenAiModels,
  readPublicChatConfig,
  savePublicChatConfig,
  transcribeAudio
} from "./chat-bridge.js";

const preferredPort = Number(process.env.PORT ?? 3333);
const host = process.env.HOST ?? "0.0.0.0";
const tlsDataDir = resolve(process.cwd(), "data");
const uiAssetsDir = fileURLToPath(new URL("../../ui/assets", import.meta.url));
const logoPath = fileURLToPath(new URL("../../media/logo.png", import.meta.url));
const mcpServerPath = fileURLToPath(new URL("../mcp/index.js", import.meta.url));
const runFile = promisify(execFile);
const configuredBodyLimit = Number(process.env.MICROS_UI_MAX_BODY_BYTES ?? 12 * 1024 * 1024);
const maxJsonBodyBytes = Number.isFinite(configuredBodyLimit) && configuredBodyLimit > 0
  ? configuredBodyLimit
  : 12 * 1024 * 1024;
let client: Client | null = null;

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export async function readJsonBody(request: IncomingMessage, limit = maxJsonBodyBytes) {
  const chunks: Buffer[] = [];
  let size = 0;

  const contentLength = Number(request.headers?.["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    request.resume?.();
    throw new HttpRequestError(413, `Request body exceeds the ${limit}-byte limit.`);
  }

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;

    if (size > limit) {
      request.resume?.();
      throw new HttpRequestError(413, `Request body exceeds the ${limit}-byte limit.`);
    }

    chunks.push(bytes);
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

function certificateHosts(addresses = localIpv4Addresses()) {
  const configuredHosts = (process.env.MICROS_UI_CERT_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const boundHost = host === "0.0.0.0" || host === "::" ? [] : [host];
  return [...new Set(["localhost", "microsmcp.local", "127.0.0.1", "::1", ...addresses, ...boundHost, ...configuredHosts])];
}

function certificateCoversHosts(certificate: X509Certificate, hosts: string[]) {
  const validUntil = Date.parse(certificate.validTo);
  if (!Number.isFinite(validUntil) || validUntil < Date.now() + 24 * 60 * 60 * 1000) {
    return false;
  }

  return hosts.every((value) => {
    const isIpAddress = isIP(value) !== 0;
    return isIpAddress ? Boolean(certificate.checkIP(value)) : Boolean(certificate.checkHost(value));
  });
}

export async function ensureSelfSignedCertificate(
  dataDir = tlsDataDir,
  hosts = certificateHosts()
) {
  const certPath = join(dataDir, "ui-self-signed-cert.pem");
  const keyPath = join(dataDir, "ui-self-signed-key.pem");

  try {
    const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
    const certificate = new X509Certificate(cert);
    if (certificateCoversHosts(certificate, hosts) && certificate.checkPrivateKey(createPrivateKey(key))) {
      return { cert, key, certPath };
    }
  } catch {
    // Missing, invalid, or outdated certificates are replaced below.
  }

  await mkdir(dataDir, { recursive: true });
  const suffix = `${process.pid}-${randomUUID()}`;
  const temporaryCertPath = `${certPath}.${suffix}.tmp`;
  const temporaryKeyPath = `${keyPath}.${suffix}.tmp`;
  const subjectAltNames = hosts
    .map((value) => (isIP(value) !== 0 ? `IP:${value}` : `DNS:${value}`))
    .join(",");

  try {
    await runFile("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "365",
      "-subj", "/CN=microsmcp.local", "-addext", `subjectAltName=${subjectAltNames}`,
      "-keyout", temporaryKeyPath, "-out", temporaryCertPath
    ]);
    await chmod(temporaryKeyPath, 0o600);
    await Promise.all([rename(temporaryCertPath, certPath), rename(temporaryKeyPath, keyPath)]);
  } catch (error) {
    await Promise.all([rm(temporaryCertPath, { force: true }), rm(temporaryKeyPath, { force: true })]);
    throw new Error(`Could not generate the UI HTTPS certificate with OpenSSL: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  return { cert, key, certPath };
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

export function accessUrls(
  boundHost: string,
  port: number,
  addresses = localIpv4Addresses(),
  networkPrefix = process.env.MICROS_NETWORK_PREFIX,
  protocol = "https"
) {
  const urls = displayHosts(boundHost, addresses, networkPrefix).map((address) => `${protocol}://${address}:${port}`);
  return [...new Set(urls)];
}

function printAccessUrls(boundHost: string, port: number, protocol: string) {
  const urls = accessUrls(boundHost, port, localIpv4Addresses(), process.env.MICROS_NETWORK_PREFIX, protocol);

  console.log(`micrOSMCP test UI listening on ${boundHost}:${port}`);
  for (const url of urls) {
    console.log(`  ${url}`);
  }
}

async function serveStatic(pathname: string, response: ServerResponse) {
  if (pathname === "/media/logo.png") {
    const body = await readFile(logoPath);
    response.writeHead(200, { "content-type": contentTypes[".png"] });
    response.end(body);
    return;
  }

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

const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  try {
    if (!client) {
      sendError(response, 503, "MCP bridge is not ready.");
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/tools") {
      sendJson(response, 200, {
        ...await client.listTools(),
        instructions: client.getInstructions() ?? "",
        serverInfo: client.getServerVersion() ?? null
      });
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
      sendJson(response, 200, await readPublicChatConfig());
      return;
    }

    if ((request.method === "POST" || request.method === "PUT") && url.pathname === "/api/chat-config") {
      sendJson(response, 200, await savePublicChatConfig(await readJsonBody(request)));
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
    const statusCode = error instanceof HttpRequestError ? error.statusCode : 500;
    sendError(response, statusCode, error instanceof Error ? error.message : "Unknown error");
  }
};

async function createUiServer() {
  const { cert, key, certPath } = await ensureSelfSignedCertificate();
  return { server: createHttpsServer({ cert, key }, handleRequest), protocol: "https", certPath };
}

function listen(server: ReturnType<typeof createHttpsServer>, protocol: string, port: number, certPath: string) {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && !process.env.PORT) {
      listen(server, protocol, port + 1, certPath);
      return;
    }

    console.error(error.message);
    process.exit(1);
  });

  server.listen(port, host, () => {
    printAccessUrls(host, port, protocol);
    console.log(`Self-signed certificate: ${certPath}`);
    console.log("Trust this certificate on client devices to enable browser microphone access.");
  });
}

async function startUiServer() {
  const { server, protocol, certPath } = await createUiServer();
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
  listen(server, protocol, preferredPort, certPath);
  return server;
}

async function shutdown(server: ReturnType<typeof createHttpsServer>) {
  await client?.close();
  server.close(() => process.exit(0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = await startUiServer();

  process.on("SIGINT", () => {
    void shutdown(server);
  });

  process.on("SIGTERM", () => {
    void shutdown(server);
  });
}
