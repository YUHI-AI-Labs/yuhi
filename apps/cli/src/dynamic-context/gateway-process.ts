/**
 * CLI-only pieces of the dynamic launch. The gateway lifecycle itself lives in
 * `@yuhi/context-gateway`'s `startDynamicClaudeSession`, shared with the VS Code command,
 * so the two surfaces cannot drift.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { mcpConfig } from "./environment.js";

export { GATEWAY_STARTUP_TIMEOUT_MS } from "@yuhi/context-gateway";

/** Write the MCP registration Claude Code will load. Returns the config path. */
export async function writeMcpConfig(input: {
  workspace: string;
  contextRoot: string;
  sessionId: string;
  cliEntry: string;
}): Promise<string> {
  const path = join(input.contextRoot, "mcp", "yuhi-mcp.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    JSON.stringify(
      mcpConfig({ cliEntry: input.cliEntry, contextRoot: input.contextRoot, sessionId: input.sessionId }),
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return path;
}
