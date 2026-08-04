/**
 * Dynamic context for the VS Code surface (v0.4.0).
 *
 * This is NOT a second implementation. The gateway lifecycle, environment contract,
 * retrieval policy, metrics and evidence all come from
 * `@yuhi/context-gateway`'s `startDynamicClaudeSession` — the same call the CLI makes for
 * `yuhi launch claude --dynamic-context`. This module owns only what is editor-specific:
 * a dedicated terminal, the status bar, the panel section, polling, and lifecycle.
 *
 * Two deliberate constraints:
 *
 * 1. **The terminal path, not the Claude Code extension path.** `openClaudeInPreparedWorkspace`
 *    activates `anthropic.claude-code` and calls its open command; we cannot give that
 *    extension a different environment without mutating the shared extension-host process,
 *    which would leak the gateway into every extension in the window. A terminal we create
 *    is a process whose environment we own, so the scope claim stays true.
 * 2. **No `vscode` import here.** Everything the editor provides arrives through
 *    {@link DynamicContextHost}, so this is unit-testable without an editor.
 */

import { DEVELOPER_MODE_NOTICE } from "@yuhi/context-runtime";
import {
  startDynamicClaudeSession,
  type DynamicClaudeSession,
  type DynamicContextStats,
  type MetricsSnapshot,
  type RetrievalMode,
} from "@yuhi/context-gateway";

export const DYNAMIC_TERMINAL_NAME = "Yuhi · Claude Dynamic";
export const DYNAMIC_COMMAND_ID = "yuhi.launchClaudeDynamic";
/** Polling cadence while a session is active. Stops entirely when it is not. */
export const STATS_POLL_INTERVAL_MS = 3_000;

export interface DynamicTerminal {
  sendText(text: string, addNewLine?: boolean): void;
  show(): void;
  dispose(): void;
}

export interface DynamicContextHost {
  /** Create a terminal whose child processes inherit `env`. Nothing else sees it. */
  createTerminal(options: { name: string; cwd: string; env: Record<string, string> }): DynamicTerminal;
  log(line: string): void;
  setStatus(text: string, tooltip: string): void;
  clearStatus(): void;
  showMessage(message: string): void;
  showWarning(message: string): void;
  /** Ask the user how to proceed. Returns the chosen label, or undefined if dismissed. */
  choose(message: string, choices: readonly string[]): Promise<string | undefined>;
  /** Called whenever stats change so the panel can redraw. */
  onStatsChanged?: (view: DynamicPanelView) => void;
  startSession?: typeof startDynamicClaudeSession;
  setInterval?: (fn: () => void, ms: number) => { dispose(): void };
}

export type DynamicSessionState = "starting" | "active" | "complete" | "failed";

export interface DynamicSessionHandle {
  readonly sessionId: string;
  readonly gatewayUrl: string;
  readonly contextRoot: string;
  readonly retrievalMode: RetrievalMode;
  readonly terminal: DynamicTerminal;
  state(): DynamicSessionState;
  latestStats(): DynamicContextStats | undefined;
  refresh(): Promise<void>;
  /** Idempotent: flush stats, stop polling, stop the gateway. */
  close(): Promise<void>;
}

export interface StartDynamicSessionInput {
  readonly preparedWorkspace: string;
  readonly claudeCommand: string;
  readonly retrievalMode?: RetrievalMode;
  readonly upstreamBaseUrl?: string;
  readonly sessionId?: string;
}

/** Single-quote a token for POSIX shells (paths with spaces or metacharacters). */
function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Start a dynamic session and open its dedicated terminal.
 *
 * Throws on gateway failure — the caller must NOT silently fall back to a normal Claude
 * Code launch. A user who asked for dynamic context and got an ordinary session would
 * believe their tool output was being compressed when it was not.
 */
export async function startDynamicSession(
  host: DynamicContextHost,
  input: StartDynamicSessionInput,
): Promise<DynamicSessionHandle> {
  const start = host.startSession ?? startDynamicClaudeSession;
  const session: DynamicClaudeSession = await start({
    preparedWorkspace: input.preparedWorkspace,
    retrievalMode: input.retrievalMode ?? "disabled",
    claudeCommand: input.claudeCommand,
    ...(input.upstreamBaseUrl ? { upstreamBaseUrl: input.upstreamBaseUrl } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    log: (line) => host.log(line),
  });

  const terminal = host.createTerminal({
    name: DYNAMIC_TERMINAL_NAME,
    cwd: session.command.cwd,
    // Terminal-scoped: only processes started in THIS terminal see the gateway.
    env: session.command.env,
  });
  terminal.sendText([session.command.file, ...session.command.args].map(shQuote).join(" "), true);
  terminal.show();

  let state: DynamicSessionState = "active";
  let stats: DynamicContextStats | undefined;

  const publish = (): void => {
    host.setStatus(statusBarText(state, stats), statusBarTooltip(state, stats, session.retrievalMode));
    host.onStatsChanged?.(panelView(state, stats, session));
  };

  const refresh = async (): Promise<void> => {
    try {
      stats = await session.getStats();
      publish();
    } catch {
      // A stats failure must never take down the agent's session; it is telemetry.
      host.log("[dynamic] stats unavailable for this tick; the session continues.");
      host.showWarning("Yuhi: dynamic context statistics are temporarily unavailable. Claude Code is unaffected.");
    }
  };

  host.log(`[dynamic] ${DEVELOPER_MODE_NOTICE.replace(/\n+/g, " ")}`);
  host.showMessage(DEVELOPER_MODE_NOTICE);

  publish();
  const ticker = (host.setInterval ?? defaultInterval)(() => void refresh(), STATS_POLL_INTERVAL_MS);

  let closed = false;
  return {
    sessionId: session.sessionId,
    gatewayUrl: session.gatewayUrl,
    contextRoot: session.contextRoot,
    retrievalMode: session.retrievalMode,
    terminal,
    state: () => state,
    latestStats: () => stats,
    refresh,
    close: async () => {
      if (closed) return;
      closed = true;
      ticker.dispose();
      try {
        stats = await session.close();
        state = "complete";
      } catch {
        state = "failed";
        host.log("[dynamic] gateway shutdown reported an error; the session is closed.");
      }
      publish();
    },
  };
}

function defaultInterval(fn: () => void, ms: number): { dispose(): void } {
  const handle = setInterval(fn, ms);
  return { dispose: () => clearInterval(handle) };
}

/** The notice that makes the terminal's scope explicit (spec §5). */
/**
 * Shown when a session starts. Deliberately does NOT say secrets are withheld — Developer
 * Mode delivers them on purpose, and a user who believed otherwise would make a worse
 * decision than one who knows.
 */
export const DEVELOPER_MODE_NOTICE_TEXT = DEVELOPER_MODE_NOTICE;

export const DYNAMIC_SCOPE_NOTICE =
  "Dynamic Context is active in this terminal only. Commands run here may use the Yuhi local gateway; other terminals and windows are unaffected.";

// ---------------------------------------------------------------------------
// Presentation. Static repository reduction and dynamic tool-output reduction are
// never merged, and an unknown prints as "Not measured" rather than as a zero.
// ---------------------------------------------------------------------------

export function statusBarText(state: DynamicSessionState, stats: DynamicContextStats | undefined): string {
  if (state === "failed") return "$(warning) Yuhi Dynamic · Failed";
  if (state === "complete") return "$(shield) Yuhi Dynamic · Session complete";
  const snapshot = stats?.sessions[0];
  if (!snapshot || snapshot.rawEstimatedTokens === 0) return "$(shield) Yuhi Dynamic · Measuring…";
  return `$(shield) Yuhi Dynamic · ${(snapshot.dynamicReduction * 100).toFixed(0)}% reduced`;
}

export function statusBarTooltip(
  state: DynamicSessionState,
  stats: DynamicContextStats | undefined,
  retrievalMode: RetrievalMode,
): string {
  const snapshot = stats?.sessions[0];
  const head = `Yuhi dynamic context · ${state} · retrieval: ${retrievalMode}`;
  if (!snapshot) return `${head}\nNo tool results have passed through the gateway yet.`;
  return [
    head,
    `Tool results: ${snapshot.toolResultBlocksObserved} observed · ${snapshot.toolResultBlocksCompressed} compressed · ${snapshot.toolResultBlocksReused} reused unchanged`,
    `Dynamic tool-output reduction: ${(snapshot.dynamicReduction * 100).toFixed(1)}%`,
    "This is an estimate of withheld tool output — not a provider token or billing measurement,",
    "and not the static repository reduction shown in Review Prepared Context.",
  ].join("\n");
}

export interface DynamicPanelRow {
  readonly label: string;
  readonly value: string;
}

export interface DynamicPanelView {
  readonly title: "Dynamic Context";
  readonly status: DynamicSessionState;
  readonly rows: readonly DynamicPanelRow[];
  /** Shown under the rows; keeps the measurements from being read as product claims. */
  readonly footnote: string;
}

export function panelView(
  state: DynamicSessionState,
  stats: DynamicContextStats | undefined,
  session?: Pick<DynamicClaudeSession, "retrievalMode">,
): DynamicPanelView {
  const snapshot: MetricsSnapshot | undefined = stats?.sessions[0];
  const notMeasured = "Not measured";
  const usage = snapshot?.usage;
  const usageKnown = usage !== undefined && (usage.inputTokens > 0 || usage.outputTokens > 0);

  return {
    title: "Dynamic Context",
    status: state,
    rows: [
      { label: "Status", value: state === "active" ? "Active" : state === "complete" ? "Complete" : state === "failed" ? "Failed" : "Starting" },
      { label: "Tool results observed", value: snapshot ? String(snapshot.toolResultBlocksObserved) : notMeasured },
      { label: "Blocks compressed", value: snapshot ? String(snapshot.toolResultBlocksCompressed) : notMeasured },
      { label: "Raw estimated tokens", value: snapshot ? snapshot.rawEstimatedTokens.toLocaleString("en-US") : notMeasured },
      { label: "Delivered estimated tokens", value: snapshot ? snapshot.deliveredEstimatedTokens.toLocaleString("en-US") : notMeasured },
      {
        label: "Dynamic tool-output reduction",
        value: snapshot && snapshot.rawEstimatedTokens > 0 ? `${(snapshot.dynamicReduction * 100).toFixed(1)}%` : notMeasured,
      },
      { label: "Provider input tokens", value: usageKnown ? String(usage.inputTokens) : notMeasured },
      { label: "Cache creation tokens", value: usageKnown ? String(usage.cacheCreationInputTokens) : notMeasured },
      { label: "Cache read tokens", value: usageKnown ? String(usage.cacheReadInputTokens) : notMeasured },
      {
        label: "Provider-reported cost change",
        value: usage?.costUsd === undefined ? notMeasured : `${usage.costUsd} USD`,
      },
      { label: "Retrieval mode", value: snapshot?.retrievalMode ?? session?.retrievalMode ?? "disabled" },
      { label: "Retrieval count", value: snapshot ? String(snapshot.retrievals) : notMeasured },
      { label: "Fallbacks", value: snapshot ? String(snapshot.fallbacks) : notMeasured },
      { label: "Security blocks", value: snapshot ? String(snapshot.withheld) : notMeasured },
    ],
    footnote:
      "These numbers describe this session only. Dynamic tool-output reduction is an estimate of withheld tool output; it is separate from the static repository reduction and is not a provider token, billing, or cost measurement.",
  };
}

// ---------------------------------------------------------------------------
// Preflight and failure handling
// ---------------------------------------------------------------------------

export type DynamicPreflight =
  | { readonly ok: true; readonly preparedRoot: string }
  | { readonly ok: false; readonly reason: string; readonly message: string };

export function preflight(input: {
  preparedRoot: string | undefined;
  insidePreparedWorkspace: boolean;
  sandboxVerified: boolean;
  claudeAvailable: boolean;
}): DynamicPreflight {
  if (!input.insidePreparedWorkspace || !input.preparedRoot) {
    return {
      ok: false,
      reason: "not-in-prepared-workspace",
      message:
        "Open the folder you want to work on first. Dynamic context prepares it (or reuses an existing Prepared Workspace) and then starts Claude Code there.",
    };
  }
  if (!input.sandboxVerified) {
    return {
      ok: false,
      reason: "sandbox-unverified",
      message:
        "Yuhi could not verify the Claude Code sandbox policy for this workspace, so the dynamic session was not started.",
    };
  }
  if (!input.claudeAvailable) {
    return {
      ok: false,
      reason: "claude-cli-missing",
      message: 'The "claude" CLI was not found on your PATH. Install Claude Code, then run this command again.',
    };
  }
  return { ok: true, preparedRoot: input.preparedRoot };
}

export const STARTUP_FAILURE_CHOICES = [
  "Retry",
  "Open Doctor Output",
  "Start normal Claude Code",
  "Cancel",
] as const;

export type StartupFailureChoice = (typeof STARTUP_FAILURE_CHOICES)[number];

/**
 * A gateway that will not start is a decision for the user, never an automatic downgrade.
 * Silently starting an ordinary session would leave them believing their tool output was
 * compressed when it was not.
 */
export async function handleStartupFailure(
  host: Pick<DynamicContextHost, "choose" | "log">,
  reason: string,
): Promise<StartupFailureChoice | undefined> {
  host.log(`[dynamic] gateway startup failed: ${reason}`);
  const choice = await host.choose(
    `Yuhi could not start the dynamic context gateway (${reason}). Claude Code was NOT started.`,
    STARTUP_FAILURE_CHOICES,
  );
  return choice as StartupFailureChoice | undefined;
}

/** Retrieval picker entries. Default first, with the measured reason attached. */
export const RETRIEVAL_CHOICES: readonly { label: string; mode: RetrievalMode; detail: string }[] = [
  {
    label: "Disabled — Recommended",
    mode: "disabled",
    detail:
      "Originals stay retrievable in the private store, but no retrieval tools are registered. Measured: registering them adds ~507 tokens to every request and cost extra agent turns.",
  },
  {
    label: "Conditional",
    mode: "conditional",
    detail: "Retrieval tools available; the agent is prompted only when a view may be missing evidence it needs.",
  },
  {
    label: "Required",
    mode: "required",
    detail: "For tasks whose answer is known to live in omitted content. Expect extra turns.",
  },
];
