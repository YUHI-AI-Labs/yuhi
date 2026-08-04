/**
 * Making Yuhi's retrieval tools reachable from the official Claude GUI.
 *
 * The CLI can pass Claude Code a config path on its own command line. Native GUI Mode cannot:
 * the official extension owns that command line, and Yuhi only controls the child's
 * environment. So registration goes through the mechanism Claude Code discovers by itself —
 * a project-scoped `.mcp.json` at the workspace root, which is the Prepared Workspace the
 * isolated window opens.
 *
 * Discovered the hard way: the first retrieval E2E recorded `retrievals: 0` not because the
 * agent declined, but because no tools were ever offered. A retrieval mode that silently
 * registers nothing is worse than one that is off, because the stats look like a choice.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RetrievalMode } from "../anthropic/transform.js";

export const PROJECT_MCP_FILENAME = ".mcp.json";
export const YUHI_MCP_SERVER_NAME = "yuhi";

export interface McpRegistrationInput {
  readonly preparedWorkspace: string;
  readonly contextRoot: string;
  readonly sessionId: string;
  /** Absolute path to the bundled stdio server (`dist/native-mcp.js`). */
  readonly serverScript: string;
  readonly nodeExecutable?: string;
}

export function yuhiMcpServerEntry(input: McpRegistrationInput): Record<string, unknown> {
  return {
    command: input.nodeExecutable ?? process.execPath,
    args: [input.serverScript],
    env: {
      YUHI_CONTEXT_ROOT: input.contextRoot,
      YUHI_SESSION_ID: input.sessionId,
    },
  };
}

/**
 * Merge Yuhi's server into any `.mcp.json` the repository already has.
 *
 * The Prepared Workspace can be a copy of a real project that ships its own MCP servers;
 * replacing that file would remove tools the developer expects to have.
 */
export function mergeMcpConfig(existing: unknown, entry: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const servers =
    typeof base["mcpServers"] === "object" && base["mcpServers"] !== null
      ? { ...(base["mcpServers"] as Record<string, unknown>) }
      : {};
  servers[YUHI_MCP_SERVER_NAME] = entry;
  base["mcpServers"] = servers;
  return base;
}

/** No-op when retrieval is `disabled` — the measured default registers nothing at all. */
export async function registerRetrievalTools(
  mode: RetrievalMode,
  input: McpRegistrationInput,
): Promise<string | undefined> {
  if (mode === "disabled") return undefined;
  const path = join(input.preparedWorkspace, PROJECT_MCP_FILENAME);
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch {
    existing = undefined;
  }
  const merged = mergeMcpConfig(existing, yuhiMcpServerEntry(input));
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return path;
}

/** Remove only Yuhi's entry; a repository's own servers survive the session. */
export async function unregisterRetrievalTools(preparedWorkspace: string): Promise<void> {
  const path = join(preparedWorkspace, PROJECT_MCP_FILENAME);
  let current: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    current = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const servers = current["mcpServers"];
  if (typeof servers !== "object" || servers === null) return;
  const rest = { ...(servers as Record<string, unknown>) };
  delete rest[YUHI_MCP_SERVER_NAME];
  if (Object.keys(rest).length === 0 && Object.keys(current).length === 1) {
    await rm(path, { force: true });
    return;
  }
  current["mcpServers"] = rest;
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}
