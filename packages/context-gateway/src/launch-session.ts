/**
 * The shared dynamic-context launch contract.
 *
 * ONE implementation, two surfaces: `yuhi launch claude --dynamic-context` and the VS Code
 * command both call `startDynamicClaudeSession`. Behaviour, policy, metrics, evidence and
 * retrieval mode are therefore identical by construction rather than by discipline — a
 * second copy of this logic in the extension would drift the first time either side
 * changed.
 *
 * The session owns the gateway lifecycle and hands the caller a ready-to-run command
 * (file + argv + cwd + env). It never spawns anything itself: the CLI runs it through the
 * agent adapter so Safe Apply stays in the loop, and VS Code runs it in a terminal.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { startGateway, type GatewayHandle, type GatewayStats } from "./server.js";
import type { RetrievalMode } from "./anthropic/transform.js";
import { policyForMode, type DeliveryMode } from "@yuhi/context-runtime";

export const GATEWAY_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIEVAL_MODE: RetrievalMode = "disabled";

export interface DynamicClaudeSessionOptions {
  /** Prepared Workspace root. The context store lives inside it, sharing its lifecycle. */
  readonly preparedWorkspace: string;
  /**
   * How much retrieval capability the agent is shown. Defaults to `disabled`: measurement
   * showed registering the MCP tools adds a fixed ~507 tokens to every cached prefix AND
   * costs agent turns, which turned a 20% cost win into a 31% loss on a task that never
   * needed retrieval.
   */
  readonly retrievalMode?: RetrievalMode;
  /**
   * What a detected secret means for delivery. `developer` (default) lets the agent read
   * project configuration; `strict` masks detected secrets before they leave, which is the
   * 0.3.x behaviour and the right choice when the folder holds documents rather than code.
   */
  readonly deliveryMode?: DeliveryMode;
  /** Upstream base URL. Defaults to the public API; an enterprise gateway chains here. */
  readonly upstreamBaseUrl?: string;
  readonly sessionId?: string;
  /** Executable the caller will run. Defaults to `claude` on PATH. */
  readonly claudeCommand?: string;
  readonly forwardedArgs?: readonly string[];
  readonly startupTimeoutMs?: number;
  // Injectables (tests) ------------------------------------------------------
  readonly startGatewayImpl?: typeof startGateway;
  readonly readyProbe?: (url: string) => Promise<{ ok: boolean }>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface DynamicSessionCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Applied to THIS process only. Never merged into a shared or global environment. */
  readonly env: Record<string, string>;
}

export type DynamicContextStats = GatewayStats;

export interface DynamicClaudeSession {
  readonly gatewayUrl: string;
  readonly sessionId: string;
  readonly contextRoot: string;
  readonly retrievalMode: RetrievalMode;
  readonly deliveryMode: DeliveryMode;
  readonly readyMs: number;
  readonly command: DynamicSessionCommand;
  getStats(): Promise<DynamicContextStats>;
  /** Flush stats, stop listening. Idempotent. */
  close(): Promise<DynamicContextStats>;
}

export class DynamicSessionStartError extends Error {
  constructor(readonly reason: "gateway-not-ready" | "gateway-start-failed") {
    super(reason);
    this.name = "DynamicSessionStartError";
  }
}

export function contextStoreRoot(preparedWorkspace: string): string {
  return join(preparedWorkspace, ".yuhi", "context");
}

/**
 * Environment variables the agent process needs. Deliberately four: point the agent at the
 * loopback gateway and tell the retrieval server where the store is. No credential is ever
 * added, read, or logged here — the agent's own auth passes through untouched.
 */
export function dynamicSessionEnv(input: {
  gatewayUrl: string;
  sessionId: string;
  contextRoot: string;
}): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: input.gatewayUrl,
    YUHI_DYNAMIC_CONTEXT: "1",
    YUHI_SESSION_ID: input.sessionId,
    YUHI_CONTEXT_ROOT: input.contextRoot,
  };
}

export async function startDynamicClaudeSession(
  options: DynamicClaudeSessionOptions,
): Promise<DynamicClaudeSession> {
  const retrievalMode = options.retrievalMode ?? DEFAULT_RETRIEVAL_MODE;
  const contextRoot = contextStoreRoot(options.preparedWorkspace);
  const sessionId = options.sessionId ?? `sess_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((): void => {});
  const start = options.startGatewayImpl ?? startGateway;

  const began = now();
  let gateway: GatewayHandle;
  try {
    gateway = await start({
      storeRoot: contextRoot,
      retrievalMode,
      deliveryPolicy: policyForMode(options.deliveryMode ?? "developer"),
      sessionOverride: sessionId,
      ...(options.upstreamBaseUrl ? { upstreamBaseUrl: options.upstreamBaseUrl } : {}),
      log,
    });
  } catch {
    throw new DynamicSessionStartError("gateway-start-failed");
  }

  // readyz before handing the endpoint to an agent: a race here would surface to the user
  // as an unexplained API failure inside Claude Code.
  const probe = options.readyProbe ?? (async (url: string) => ({ ok: (await fetch(url)).ok }));
  const timeout = options.startupTimeoutMs ?? GATEWAY_STARTUP_TIMEOUT_MS;
  let ready = false;
  for (;;) {
    try {
      if ((await probe(`${gateway.url}/readyz`)).ok) {
        ready = true;
        break;
      }
    } catch {
      // not listening yet
    }
    if (now() - began > timeout) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!ready) {
    await gateway.close().catch(() => {});
    throw new DynamicSessionStartError("gateway-not-ready");
  }
  const readyMs = now() - began;
  log(`[dynamic] gateway ready at ${gateway.url} in ${readyMs}ms (retrieval: ${retrievalMode})`);

  let closed: DynamicContextStats | undefined;

  return {
    gatewayUrl: gateway.url,
    sessionId,
    contextRoot,
    retrievalMode,
    deliveryMode: options.deliveryMode ?? "developer",
    readyMs,
    command: {
      file: options.claudeCommand ?? "claude",
      args: [...(options.forwardedArgs ?? [])],
      cwd: options.preparedWorkspace,
      env: dynamicSessionEnv({ gatewayUrl: gateway.url, sessionId, contextRoot }),
    },
    getStats: async () => gateway.stats(),
    close: async () => {
      if (closed) return closed;
      closed = gateway.stats();
      await gateway.close();
      log("[dynamic] gateway stopped; evidence and stats flushed.");
      return closed;
    },
  };
}
