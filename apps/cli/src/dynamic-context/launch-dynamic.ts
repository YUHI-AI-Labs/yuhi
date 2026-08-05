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

import { readFile } from "node:fs/promises";

import {
  isPrivacyMode,
  privacyModeCopyFor,
  privacyModeFromLegacyDeliveryMode,
  resolvePrivacyPolicy,
  PrivacyModeResolutionError,
  type PrivacyMode,
  type StudentAliasContext,
} from "@yuhi/shared";
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

/**
 * The Privacy Mode Static Prepare recorded for this run (v0.4.8 Phase 1's
 * `manifest.json` `privacyPolicy.mode` field), when the run was prepared under 0.4.8
 * or later. `undefined` for an older run or a manifest that never recorded it —
 * callers treat that as "unknown", not as a mismatch.
 */
export async function readPreparedPrivacyMode(workspace: string): Promise<PrivacyMode | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(workspace, "manifest.json"), "utf8")) as {
      privacyPolicy?: { mode?: unknown };
    };
    const mode = raw.privacyPolicy?.mode;
    return isPrivacyMode(mode) ? mode : undefined;
  } catch {
    return undefined;
  }
}

export interface ResolveLaunchPrivacyModeInput {
  /** Raw `--privacy-mode` CLI value, `""` when the flag was not given. */
  readonly rawPrivacyMode: string;
  /** Raw `--delivery-mode` CLI value (has a static commander default of `"developer"`). */
  readonly legacyDeliveryMode: "developer" | "strict";
  /** `readPreparedPrivacyMode(workspace)`'s result — `undefined` when unknown/older run. */
  readonly preparedPrivacyMode: PrivacyMode | undefined;
  readonly trustedLocalAcknowledged: boolean;
}

export type ResolveLaunchPrivacyModeResult =
  | { readonly ok: true; readonly privacyMode: PrivacyMode }
  | { readonly ok: false; readonly exitCode: 3; readonly message: string };

/**
 * Privacy Mode precedence for `launch --dynamic-context` (Section 5/8), pulled out of
 * the CLI action as a pure function so the mode-mismatch refusal — a safety-critical
 * branch — has direct unit tests rather than only being reachable through a spawned
 * subprocess.
 *
 * Precedence: `--privacy-mode` > the PREPARED RUN's own recorded mode (so a plain
 * `yuhi launch claude --dynamic-context` inherits what `yuhi prepare` already used,
 * rather than silently defaulting away from it) > legacy `--delivery-mode` mapping >
 * balanced.
 *
 * Mode-mismatch guard: a prepared run's files on disk were protected under ITS OWN
 * recorded mode. Trusted Local preparation leaves direct personal identifiers
 * unmasked AT REST — launching under an EXPLICIT `--privacy-mode balanced|strict`
 * would claim protection the files on disk do not have. Every other combination is
 * safe: Balanced/Strict-prepared files are already masked at rest regardless of the
 * Dynamic session's own mode, and Dynamic Context applies its own live transform to
 * whatever it reads either way (v0.4.8 Phase 3A) — so a mismatch there is not a real
 * confusion, only Trusted Local's "unmasked at rest" case is.
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
          ? "Re-run with --acknowledge-unmasked-data to proceed non-interactively."
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
        `or launch with \`--privacy-mode trusted-local\` to acknowledge the existing files.\n\n` +
        `Safe error category: privacy-mode-mismatch`,
    };
  }

  return { ok: true, privacyMode };
}

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
