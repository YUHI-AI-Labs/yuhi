/**
 * Minimal MCP stdio server (JSON-RPC 2.0). Implemented directly rather than pulling in
 * an SDK: the surface is three methods, and the VSIX/CLI self-containment rules make a
 * new runtime dependency expensive.
 */

import { ContextStore, asSessionId, type SessionId } from "@yuhi/context-store";
import { ContextRuntime } from "@yuhi/context-runtime";

import { TOOL_DEFINITIONS, callTool, type ToolDeps } from "./tools.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "yuhi-context";

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number | string | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string | null; result: unknown }
  | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string } };

/**
 * Handle one JSON-RPC message. Returns `undefined` for notifications (no id), which by
 * protocol must produce no response.
 */
export async function handleMcpMessage(
  message: JsonRpcRequest,
  deps: ToolDeps,
  version: string,
): Promise<JsonRpcResponse | undefined> {
  const id = message.id ?? null;

  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version },
      },
    };
  }
  if (message.method === "notifications/initialized" || message.id === undefined) {
    return undefined;
  }
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFINITIONS } };
  }
  if (message.method === "tools/call") {
    const name = typeof message.params?.["name"] === "string" ? (message.params["name"] as string) : "";
    const rawArgs = message.params?.["arguments"];
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    try {
      const outcome = await callTool(name, args, deps);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: outcome.text }],
          ...(outcome.isError ? { isError: true } : {}),
        },
      };
    } catch (err) {
      // Error text is never content-derived: an error must not become a leak.
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `[Yuhi] tool failed: ${err instanceof Error ? err.name : "unknown"}` }],
          isError: true,
        },
      };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}

export interface McpServerConfig {
  readonly storeRoot: string;
  readonly sessionId: string;
  readonly version?: string;
}

export function configFromEnv(env: Record<string, string | undefined>): McpServerConfig | undefined {
  const storeRoot = env["YUHI_CONTEXT_ROOT"];
  const sessionId = env["YUHI_SESSION_ID"];
  if (!storeRoot || !sessionId) return undefined;
  return { storeRoot, sessionId, ...(env["YUHI_VERSION"] ? { version: env["YUHI_VERSION"] } : {}) };
}

export async function createToolDeps(config: McpServerConfig): Promise<ToolDeps> {
  const store = await ContextStore.open({ root: config.storeRoot });
  const sessionId: SessionId = asSessionId(config.sessionId);
  return { store, runtime: new ContextRuntime({ store }), sessionId };
}

/** Read newline-delimited JSON-RPC from stdin and write responses to stdout. */
export async function runStdioServer(config: McpServerConfig, io?: { input?: AsyncIterable<Buffer>; output?: (line: string) => void }): Promise<void> {
  const deps = await createToolDeps(config);
  const write = io?.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  const input = io?.input ?? process.stdin;

  let buffered = "";
  for await (const chunk of input) {
    buffered += chunk.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (line === "") continue;
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(line) as JsonRpcRequest;
      } catch {
        write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
        continue;
      }
      const response = await handleMcpMessage(parsed, deps, config.version ?? "0.4.0");
      if (response) write(JSON.stringify(response));
    }
  }
}
