# micrOSMCP Agent Guide

This repository is a TypeScript MCP server with a small local tester UI. Keep this file focused on architecture and contributor workflow. Feature-level tool behavior belongs in `README.md`.

## Architecture Boundaries

- `mcp/` owns the standalone MCP stdio server and micrOS tool implementation.
- `mcp/index.ts` is only the stdio MCP bootstrap.
- `mcp/mcp-tools.ts` is the generic MCP registrar and response formatter.
- `mcp/tools.ts` is the public barrel for tool functions, tool definitions, and shared types.
- `mcp/tools/registry.ts` owns the ordered list of registered tool definitions.
- `mcp/tools/definition.ts` owns the shared `MicrOSToolDefinition` type.
- `mcp/tools/common.ts` owns shared micrOS infrastructure: cache access, device selection helpers, TCP socket client, discovery helpers, output parsers, and concurrency helpers.
- `mcp/tools/<tool-name>.ts` owns one tool's input type, Zod schema, MCP title/description, exported business function, and exported tool definition.
- `ui/` owns the local tester web app, including its server bridge and static assets. It should consume MCP schemas instead of duplicating tool knowledge.
- `data/` owns local runtime state such as the device cache and optional tester UI chat config.
- `scripts/` contains operational entrypoints and checks. Keep scripts protocol-safe when used by stdio MCP clients.

## Adding A Tool

1. Add `mcp/tools/<tool-name>.ts`.
2. Define the tool input type in that file unless it is genuinely shared.
3. Export a plain async business function.
4. Export a `MicrOSToolDefinition` beside the function. Keep name, title, description, input schema, and handler in that file.
5. Add the definition to `mcp/tools/registry.ts`.
6. Export the function, input type, and definition from `mcp/tools.ts`.
7. Update `README.md` only with user-facing feature details.
8. Run `npm run start:test` for focused contract tests and project entrypoint checks.

## Response Shape

- Tool handlers should return JSON-serializable objects.
- Controlled failures should return `{ ok: false, error: "..." }`.
- Successful side-effecting or command tools should include enough context for users to audit what happened.
- `mcp/mcp-tools.ts` is responsible for wrapping handler results into MCP text content and marking controlled failures as MCP errors.

## Code Style

- Keep MCP schema descriptions concise and human-readable; they appear in clients and in the tester UI.
- Do not duplicate schema metadata in the UI. The UI should render what MCP exposes.
- Keep reusable micrOS protocol behavior in `mcp/tools/common.ts`; keep tool-specific orchestration in the tool file.
- Add comments only around non-obvious protocol behavior, socket lifecycle, or safety-sensitive command behavior.
- Preserve the stdio contract: MCP mode must not print non-protocol helper text to stdout.
- Prefer `npm run start:test` for the minimal local verification pass.

## Documentation Split

- `README.md` is for users: setup, commands, tool behavior, Docker usage, and examples.
- `AGENTS.md` is for contributors and coding agents: architecture, extension workflow, and project conventions.
- Avoid copying feature-specific tool details into `AGENTS.md`; keep those in `README.md`.
