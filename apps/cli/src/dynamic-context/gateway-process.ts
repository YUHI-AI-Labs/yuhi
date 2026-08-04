/**
 * Gateway lifecycle for the CLI (spec §11 steps 3-4, §12, §14).
 *
 * The gateway runs IN the `yuhi launch` process: one less process to supervise, and the
 * agent's exit is the natural signal to flush evidence and stop listening.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { startGateway, type GatewayHandle, type GatewayOptions } from "@yuhi/context-gateway";

import { mcpConfig } from "./environment.js";

export const GATEWAY_STARTUP_TIMEOUT_MS = 15_000;

export interface DynamicGatewayOptions extends GatewayOptions {
  /** Retrieval mode is part of GatewayOptions; re-exported here for call-site clarity. */
  readonly startupTimeoutMs?: number;
  readonly startImpl?: typeof startGateway;
  readonly fetchProbe?: (url: string) => Promise<{ ok: boolean }>;
}

export interface ReadyGateway {
  readonly handle: GatewayHandle;
  readonly readyMs: number;
}

export async function startAndWaitForReady(opts: DynamicGatewayOptions): Promise<ReadyGateway> {
  const start = opts.startImpl ?? startGateway;
  const began = Date.now();
  const handle = await start(opts);
  const timeout = opts.startupTimeoutMs ?? GATEWAY_STARTUP_TIMEOUT_MS;
  const probe = opts.fetchProbe ?? (async (url) => ({ ok: (await fetch(url)).ok }));

  for (;;) {
    try {
      const result = await probe(`${handle.url}/readyz`);
      if (result.ok) return { handle, readyMs: Date.now() - began };
    } catch {
      // Not listening yet.
    }
    if (Date.now() - began > timeout) {
      await handle.close();
      throw new Error("gateway-not-ready");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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
