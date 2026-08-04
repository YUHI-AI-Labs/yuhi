/**
 * VSIX-bundled Yuhi MCP server for Native GUI Mode.
 *
 * Claude Code launches this over stdio when a session runs with retrieval enabled. It is a
 * separate bundle for the same reason the broker is: by the time it runs it is a plain Node
 * process owned by the agent, not by an extension host.
 */

import { configFromEnv, runStdioServer } from "@yuhi/context-mcp";

const config = configFromEnv(process.env);
if (!config) {
  process.stderr.write("yuhi mcp: YUHI_CONTEXT_ROOT / YUHI_SESSION_ID are required\n");
  process.exit(1);
}
runStdioServer(config).catch((err: unknown) => {
  process.stderr.write(`yuhi mcp failed: ${err instanceof Error ? err.message : "unknown"}\n`);
  process.exit(1);
});
