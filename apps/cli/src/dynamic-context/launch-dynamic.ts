/**
 * `yuhi launch claude --dynamic-context` (spec §11).
 *
 * Deliberately implemented as a WRAPPER around the existing launch flow rather than a
 * second launch path: `performLaunch` still validates the prepared run, captures the
 * private pre-agent snapshot, and keeps Safe Patch Review / Safe Apply intact. The only
 * addition is a runner that points the agent at the loopback gateway.
 *
 * That is why `--dynamic-context` cannot regress Safe Apply: it does not touch it.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { privacyModeCopyFor, type PrivacyMode, type StudentAliasContext } from "@yuhi/shared";
import type { AgentCommand } from "@yuhi/shared";
import type { AgentRunOutcome } from "@yuhi/agents";
import { runCommand } from "@yuhi/agents";
import {
  startDynamicClaudeSession,
  type DynamicClaudeSession,
  type DynamicClaudeSessionOptions,
  type GatewayStats,
  type RetrievalMode,
} from "@yuhi/context-gateway";

import { performLaunch, resolveRunForLaunch, type PerformLaunchOptions } from "../launch.js";
import { detectUpstream, type UpstreamConfig } from "./environment.js";
import { writeMcpConfig } from "./gateway-process.js";
import { formatStatsReport } from "./stats.js";

// Privacy Mode resolution/mismatch logic lives in `@yuhi/context-gateway` (one
// implementation shared by the CLI, VS Code's Dynamic Terminal command, and Native GUI
// Mode) — re-exported here so existing CLI call sites/imports are unaffected.
export { readPreparedPrivacyMode, resolveLaunchPrivacyMode } from "@yuhi/context-gateway";

export interface DynamicLaunchOptions {
  readonly runRef?: string;
  readonly forwardedArgs?: readonly string[];
  readonly json?: boolean;
  readonly spawn?: boolean;
  /** Absolute path to the CLI entry the MCP server should be started from. */
  readonly cliEntry?: string;
  /**
   * Retrieval mode (default `disabled`), from measurement: on the test-failure task,
   * registering the tools took the run from 2 turns to 4 and from 20% cheaper than
   * baseline to 31% dearer, while compression itself was unchanged. `conditional` and
   * `required` are for work that genuinely needs omitted detail — the retrieval-required
   * benchmark scores 3/3 with them and records real retrievals in the ledger.
   */
  readonly retrieval?: RetrievalMode;
  /** LEGACY. `strict` masks detected secrets before delivery (0.3.x behaviour).
   *  Superseded by `privacyMode` (v0.4.8) — ignored when `privacyMode` is given. */
  readonly deliveryMode?: "developer" | "strict";
  /** What happens to DIRECT PERSONAL IDENTIFIERS (v0.4.8). Takes precedence over the
   *  legacy `deliveryMode`. The CLI resolves this via `resolvePrivacyPolicy` before
   *  calling in, so it arrives here already-valid. */
  readonly privacyMode?: PrivacyMode;
  /** Carried through to the gateway; not re-validated (the caller already ran the
   *  Trusted Local acknowledgement gate). */
  readonly privacyModeAcknowledged?: boolean;
  /** The session's de-identification registry, when the caller has one to restore. */
  readonly aliasContext?: StudentAliasContext;
  /** v0.5.0 Task-Aware Dynamic Context Generation. CLI default: `--generation-mode
   *  observe` (see index.ts's flag parsing) — this field is left `undefined` here
   *  only when the caller omits the flag AND `startDynamicClaudeSession`'s own
   *  default applies. */
  readonly generationMode?: "off" | "observe" | "active";
  readonly contextBudget?: number;
  readonly contextMaximum?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  // Injectables (tests) ----------------------------------------------------
  readonly performLaunchImpl?: typeof performLaunch;
  readonly startSessionImpl?: typeof startDynamicClaudeSession;
  readonly startGatewayImpl?: DynamicClaudeSessionOptions["startGatewayImpl"];
  readonly fetchProbe?: DynamicClaudeSessionOptions["readyProbe"];
  readonly runCommandImpl?: (command: AgentCommand) => Promise<AgentRunOutcome>;
  readonly resolveWorkspace?: (ref: string | undefined) => Promise<string | undefined>;
  readonly sessionId?: string;
  readonly upstream?: UpstreamConfig;
}

export interface DynamicLaunchResult {
  readonly exitCode: number;
  readonly gatewayUrl?: string;
  readonly sessionId: string;
  readonly stats?: GatewayStats;
}

/**
 * Wrap a child-process runner so the agent starts with the gateway as its Anthropic
 * endpoint. The agent's own credentials pass through untouched and unread.
 */
export function createDynamicRunner(
  extraEnv: Record<string, string>,
  base: (command: AgentCommand) => Promise<AgentRunOutcome>,
): (command: AgentCommand) => Promise<AgentRunOutcome> {
  return (command) =>
    base({
      ...command,
      env: { ...command.env, ...extraEnv },
    } as AgentCommand);
}

export async function launchClaudeWithDynamicContext(
  opts: DynamicLaunchOptions = {},
): Promise<DynamicLaunchResult> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const err = opts.err ?? ((line: string) => console.error(line));
  const env = opts.env ?? process.env;
  const sessionId = opts.sessionId ?? `sess_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  const upstream = opts.upstream ?? detectUpstream(env);
  if (!upstream.supportsDynamicContext) {
    err(`Dynamic context is not available for this provider.\n${upstream.note ?? ""}`);
    err("Launch without --dynamic-context to use the static Prepared Repository.");
    return { exitCode: 3, sessionId };
  }
  if (upstream.note) out(`Yuhi: ${upstream.note}`);

  // The context store lives beside the prepared run so it inherits its lifecycle.
  const workspace = await (opts.resolveWorkspace ?? defaultResolveWorkspace)(opts.runRef);
  if (!workspace) {
    err("No launchable prepared run was found. Run `yuhi prepare` first.\n\nSafe error category: no-completed-run");
    return { exitCode: 3, sessionId };
  }
  const contextRoot = join(workspace, ".yuhi", "context");

  const retrieval: RetrievalMode = opts.retrieval ?? "disabled";
  // Shared with the VS Code command: one launch contract, so the two surfaces cannot drift.
  const startSession = opts.startSessionImpl ?? startDynamicClaudeSession;
  let session: DynamicClaudeSession;
  try {
    session = await startSession({
      preparedWorkspace: workspace,
      retrievalMode: retrieval,
      ...(opts.privacyMode
        ? { privacyMode: opts.privacyMode, privacyModeAcknowledged: opts.privacyModeAcknowledged ?? true }
        : { deliveryMode: opts.deliveryMode ?? "developer" }),
      ...(opts.aliasContext ? { aliasContext: opts.aliasContext } : {}),
      ...(opts.generationMode ? { generationMode: opts.generationMode } : {}),
      ...(opts.contextBudget === undefined ? {} : { contextBudget: opts.contextBudget }),
      ...(opts.contextMaximum === undefined ? {} : { contextMaximum: opts.contextMaximum }),
      upstreamBaseUrl: upstream.baseUrl,
      sessionId,
      ...(opts.startGatewayImpl ? { startGatewayImpl: opts.startGatewayImpl } : {}),
      ...(opts.fetchProbe ? { readyProbe: opts.fetchProbe } : {}),
    });
  } catch {
    err("Yuhi could not start the local context gateway.\n\nSafe error category: gateway-not-ready");
    return { exitCode: 3, sessionId };
  }

  const mcpConfigPath =
    retrieval !== "disabled" && opts.cliEntry
      ? await writeMcpConfig({
          workspace,
          contextRoot: session.contextRoot,
          sessionId,
          cliEntry: opts.cliEntry,
        }).catch(() => undefined)
      : undefined;

  const extraEnv: Record<string, string> = {
    ...session.command.env,
    ...(mcpConfigPath ? { YUHI_MCP_CONFIG: mcpConfigPath } : {}),
  };

  if (!opts.json) {
    out(`Yuhi dynamic context: ON — gateway ${session.gatewayUrl} → ${upstream.baseUrl} (${upstream.mode})`);
    out(`Session: ${sessionId}`);
    out("");
    // The banner reflects the RUNTIME's actual resolved policy (`session.privacyMode`),
    // not the raw CLI input — printed only after the gateway/pipeline started
    // successfully (spec §12: no mode banner on a failed pipeline init).
    const copy = privacyModeCopyFor(session.privacyMode, "dynamic-terminal");
    out(`Privacy: ${copy.title}`);
    for (const line of copy.en.split("\n")) if (line) out(line);
    out("");
    out(`Retrieval mode: ${retrieval}`);
    if (mcpConfigPath) out(`Retrieval tools registered (MCP): ${mcpConfigPath}`);
    else out("Retrieval tools: not registered — originals are still stored privately and stay retrievable via `yuhi dynamic stats`.");
  }

  const runner = createDynamicRunner(extraEnv, opts.runCommandImpl ?? ((command) => runCommand(command)));
  const launch = opts.performLaunchImpl ?? performLaunch;

  let exitCode = 0;
  try {
    const launchOptions: PerformLaunchOptions = {
      agentId: "claude",
      ...(opts.runRef ? { runRef: opts.runRef } : {}),
      ...(opts.forwardedArgs ? { forwardedArgs: [...opts.forwardedArgs] } : {}),
      ...(opts.json === undefined ? {} : { json: opts.json }),
      spawn: opts.spawn ?? true,
      runner,
      out,
      err,
    };
    exitCode = await launch(launchOptions);
  } finally {
    // Step 8-10: notify session close, flush evidence and stats, then stop listening.
    const stats = await session.close();
    if (opts.json) {
      out(JSON.stringify({ command: "launch", dynamicContext: true, sessionId, stats }, null, 2));
    } else {
      out("");
      out(formatStatsReport(stats));
    }
  }

  return { exitCode, gatewayUrl: session.gatewayUrl, sessionId, stats: await session.getStats() };
}

async function defaultResolveWorkspace(ref: string | undefined): Promise<string | undefined> {
  const resolution = await resolveRunForLaunch(ref);
  return resolution.ok ? resolution.run.workspace : undefined;
}
