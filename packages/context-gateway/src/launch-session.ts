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
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { startGateway, type GatewayHandle, type GatewayStats } from "./server.js";
import type { RetrievalMode } from "./anthropic/transform.js";
import { policyForMode, type DeliveryMode } from "@yuhi/context-runtime";
import {
  isPrivacyMode,
  privacyModeFromLegacyDeliveryMode,
  resolveDeliveryPolicy,
  resolvePrivacyPolicy,
  PrivacyModeResolutionError,
  type PrivacyMode,
  type StudentAliasContext,
} from "@yuhi/shared";

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
   * LEGACY. What a detected secret means for delivery. `developer` (default) lets the
   * agent read project configuration; `strict` masks detected secrets before they
   * leave. Superseded by `privacyMode` (v0.4.8) — when `privacyMode` is given, this
   * field is ignored; when it is not, `deliveryMode` maps onto `privacyMode` via
   * `privacyModeFromLegacyDeliveryMode` so existing callers keep their exact current
   * behavior (`developer` -> Balanced, `strict` -> Strict) until they migrate.
   */
  readonly deliveryMode?: DeliveryMode;
  /**
   * What happens to DIRECT PERSONAL IDENTIFIERS, and (composed with this surface) what
   * a detected SECRET means for delivery (v0.4.8 Phase 3B) — see `@yuhi/shared`'s
   * `resolveDeliveryPolicy`. Takes precedence over the legacy `deliveryMode`. Defaults
   * to Balanced.
   */
  readonly privacyMode?: PrivacyMode;
  /**
   * Required when `privacyMode` is `"trusted-local"` — the caller (CLI/VS Code) is
   * responsible for having already run `resolvePrivacyPolicy`'s acknowledgement gate;
   * this is not re-validated here, only carried through into the resolved policy.
   */
  readonly privacyModeAcknowledged?: boolean;
  /**
   * The session's de-identification registry. Fresh per session by default. A caller
   * that persists one across a restart (mirroring Static Prepare's
   * alias-registry-store) can restore it here so a name keeps its token.
   */
  readonly aliasContext?: StudentAliasContext;
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
  readonly privacyMode: PrivacyMode;
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
 * The Privacy Mode Static Prepare recorded for this run (v0.4.8 Phase 1's
 * `manifest.json` `privacyPolicy.mode` field), when the run was prepared under 0.4.8
 * or later. `undefined` for an older run or a manifest that never recorded it —
 * callers treat that as "unknown", not as a mismatch.
 *
 * Lives here, not per-surface, because Dynamic Terminal (CLI), VS Code's Dynamic
 * Terminal command, and Native GUI Mode all need the SAME answer to "what mode was
 * this run prepared under" — one implementation, three callers, exactly like
 * `startDynamicClaudeSession` itself.
 */
export async function readPreparedPrivacyMode(preparedWorkspace: string): Promise<PrivacyMode | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(preparedWorkspace, "manifest.json"), "utf8")) as {
      privacyPolicy?: { mode?: unknown };
    };
    const mode = raw.privacyPolicy?.mode;
    return isPrivacyMode(mode) ? mode : undefined;
  } catch {
    return undefined;
  }
}

export interface ResolveLaunchPrivacyModeInput {
  /** Raw `--privacy-mode` CLI/setting value, `""` when not explicitly given. */
  readonly rawPrivacyMode: string;
  /** Raw legacy delivery-mode value (`--delivery-mode`, or a VS Code setting). */
  readonly legacyDeliveryMode: "developer" | "strict";
  /** `readPreparedPrivacyMode(workspace)`'s result — `undefined` when unknown/older run. */
  readonly preparedPrivacyMode: PrivacyMode | undefined;
  readonly trustedLocalAcknowledged: boolean;
}

export type ResolveLaunchPrivacyModeResult =
  | { readonly ok: true; readonly privacyMode: PrivacyMode }
  | { readonly ok: false; readonly exitCode: 3; readonly message: string };

/**
 * Privacy Mode precedence for launching a dynamic session (Section 5/8), on ANY
 * surface (CLI, VS Code Dynamic Terminal, Native GUI). Pure, so the mode-mismatch
 * refusal — a safety-critical branch — has direct unit tests rather than only being
 * reachable through a spawned subprocess or a running editor.
 *
 * Precedence: explicit mode > the PREPARED RUN's own recorded mode (so a plain launch
 * inherits what `yuhi prepare` already used, rather than silently defaulting away from
 * it) > legacy delivery-mode mapping > balanced.
 *
 * Mode-mismatch guard: a prepared run's files on disk were protected under ITS OWN
 * recorded mode. Trusted Local preparation leaves direct personal identifiers
 * unmasked AT REST — launching under an EXPLICIT balanced/strict mode would claim
 * protection the files on disk do not have. Every other combination is safe:
 * Balanced/Strict-prepared files are already masked at rest regardless of the Dynamic
 * session's own mode, and Dynamic Context applies its own live transform to whatever
 * it reads either way (v0.4.8 Phase 3A) — so a mismatch there is not a real confusion,
 * only Trusted Local's "unmasked at rest" case is.
 */
export function resolveLaunchPrivacyMode(input: ResolveLaunchPrivacyModeInput): ResolveLaunchPrivacyModeResult {
  const { rawPrivacyMode, legacyDeliveryMode, preparedPrivacyMode, trustedLocalAcknowledged } = input;
  let privacyMode: PrivacyMode;
  try {
    privacyMode = resolvePrivacyPolicy({
      candidates: [
        { mode: rawPrivacyMode, source: "cli" },
        { mode: preparedPrivacyMode ?? "", source: "workspace-config" },
        { mode: rawPrivacyMode ? "" : privacyModeFromLegacyDeliveryMode(legacyDeliveryMode), source: "legacy-mapping" },
      ],
      trustedLocalAcknowledged,
    }).mode;
  } catch (err) {
    if (err instanceof PrivacyModeResolutionError) {
      const hint =
        err.code === "trusted-local-not-acknowledged"
          ? "Re-run with --acknowledge-unmasked-data (CLI) or confirm the Trusted Local prompt (VS Code) to proceed."
          : "Use: balanced, strict, trusted-local.";
      return { ok: false, exitCode: 3, message: `${err.message}\n${hint}` };
    }
    throw err;
  }

  if (rawPrivacyMode && preparedPrivacyMode === "trusted-local" && privacyMode !== "trusted-local") {
    return {
      ok: false,
      exitCode: 3,
      message:
        `Privacy Mode mismatch: this run was prepared under Trusted Local — direct personal ` +
        `identifiers are unmasked in the prepared files on disk. Launching Dynamic Context under ` +
        `"${privacyMode}" does not retransform files already on disk; it only affects what THIS session ` +
        `delivers live.\n\n` +
        `Re-run \`yuhi prepare --privacy-mode ${privacyMode}\` to prepare a run whose files on disk match, ` +
        `or launch with Trusted Local to acknowledge the existing files.\n\n` +
        `Safe error category: privacy-mode-mismatch`,
    };
  }

  return { ok: true, privacyMode };
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

  // Privacy Mode wins when given; otherwise the legacy deliveryMode maps onto it, so
  // an unmigrated caller's SECRET behavior is byte-identical to today (see the
  // `deliveryMode` doc comment). Composed for THIS surface (dynamic-terminal and
  // native-gui share this one function, both via `startDynamicClaudeSession`).
  const privacyMode: PrivacyMode =
    options.privacyMode ?? privacyModeFromLegacyDeliveryMode(options.deliveryMode ?? "developer");
  const resolved = resolveDeliveryPolicy({
    privacyMode,
    surface: "dynamic-terminal",
    warningAcknowledged: options.privacyModeAcknowledged ?? true,
  });
  const deliveryPolicy = policyForMode(resolved.secretDeliveryMode === "redact" ? "strict" : "developer");

  const began = now();
  let gateway: GatewayHandle;
  try {
    gateway = await start({
      storeRoot: contextRoot,
      retrievalMode,
      deliveryPolicy,
      privacyMode,
      ...(options.aliasContext ? { aliasContext: options.aliasContext } : {}),
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
    deliveryMode: resolved.secretDeliveryMode === "redact" ? "strict" : "developer",
    privacyMode,
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
