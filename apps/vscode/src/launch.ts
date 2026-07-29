/**
 * Yuhi Prepared-Workspace launch services (VS Code-agnostic).
 *
 * All logic here is pure or depends only on an injected {@link LaunchHost}, so it
 * is fully unit-testable without the real `vscode` module. `extension.ts` wires the
 * real VS Code API into a LaunchHost and calls the orchestrators below.
 *
 * The generic "open the prepared workspace in a new window" flow does NOT depend on
 * Claude. Claude-specific knowledge is isolated in {@link CLAUDE_INTEGRATION} and the
 * Claude orchestrator, so future agents (Codex, Gemini) can add their own adapter.
 */
import * as path from "node:path";
import { appendFile, chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  buildPreparedMetrics,
  buildPreparedRuntimeBoundary,
  managedWorkspaceBaseDir,
  opaqueWorkspaceId,
  SOURCE_INTEGRITY_ERROR,
  type PreparedMetrics,
  type PreparedRuntimeBoundary,
  type PrepareReport,
} from "@yuhi/core";

export type VisibleLaunchFailureKind =
  | "preparation-failure"
  | "source-integrity"
  | "post-prepare-validation"
  | "confirmation-failure"
  | "review-ui-failure"
  | "prepared-workspace-open-failure";

const VISIBLE_FAILURE_MESSAGES: Record<VisibleLaunchFailureKind, string> = {
  "preparation-failure":
    "Yuhi could not complete workspace preparation. View Yuhi Output or retry.",
  "source-integrity": SOURCE_INTEGRITY_ERROR,
  "post-prepare-validation":
    "Yuhi prepared the workspace, but could not validate the post-prepare launch state. View Yuhi Output or retry.",
  "confirmation-failure":
    "Yuhi prepared the workspace, but could not show the launch confirmation. View Yuhi Output or retry.",
  "review-ui-failure":
    "Yuhi prepared the workspace, but could not open Review Prepared Context. View Yuhi Output or retry.",
  "prepared-workspace-open-failure":
    "Yuhi prepared the workspace, but could not open the Prepared Workspace. View Yuhi Output or retry.",
};

export class VisibleLaunchError extends Error {
  constructor(readonly kind: Exclude<VisibleLaunchFailureKind, "source-integrity">) {
    super(VISIBLE_FAILURE_MESSAGES[kind]);
    this.name = "VisibleLaunchError";
  }
}

async function launchStage<T>(
  kind: Exclude<VisibleLaunchFailureKind, "source-integrity">,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof Error && error.message === SOURCE_INTEGRITY_ERROR) throw error;
    if (error instanceof VisibleLaunchError) throw error;
    throw new VisibleLaunchError(kind);
  }
}

/**
 * VS Code command callbacks must never leak a rejected promise after progress
 * completes. Convert every failure into a safe, actionable notification without
 * persisting exception text, source paths, or source content.
 */
export async function runVisibleLaunchCommand(
  task: () => Promise<unknown>,
  showFailure: (message: string, kind: VisibleLaunchFailureKind) => Promise<void>,
): Promise<"completed" | "failed"> {
  try {
    await task();
    return "completed";
  } catch (error) {
    const integrityFailure = error instanceof Error && error.message === SOURCE_INTEGRITY_ERROR;
    const kind: VisibleLaunchFailureKind = integrityFailure
      ? "source-integrity"
      : error instanceof VisibleLaunchError
        ? error.kind
        : "post-prepare-validation";
    try {
      await showFailure(VISIBLE_FAILURE_MESSAGES[kind], kind);
    } catch {
      // The command boundary must settle even if VS Code cannot render the
      // notification (for example, while its window is shutting down).
    }
    return "failed";
  }
}

/** Command IDs added by this feature. Single source of truth for registration + package.json parity. */
export const LAUNCH_COMMANDS = {
  prepareAndOpen: "yuhi.prepareAndOpen",
  prepareAndStartClaude: "yuhi.prepareAndStartClaude",
} as const;

/** Human titles for the two commands (must match package.json contributes.commands). */
export const LAUNCH_COMMAND_TITLES: Record<string, string> = {
  [LAUNCH_COMMANDS.prepareAndOpen]: "Yuhi: Prepare and Open in New Window",
  [LAUNCH_COMMANDS.prepareAndStartClaude]: "Yuhi: Prepare and Start Claude Code",
};

/**
 * Adapter-level configuration for the Claude Code integration. ALL Claude-specific
 * knowledge lives here.
 *
 * - `extensionIds`: candidate VS Code extension IDs, most-official first. Detection
 *   is done at runtime against the actually-installed set — we never assume exactly
 *   one ID exists. `anthropic.claude-code` is the official Anthropic extension.
 * - `marketplaceItemName`: the official listing opened by "Open Marketplace".
 * - `cliCommand`/`cliAgentId`: used by Yuhi's existing agent discovery for CLI mode.
 * - `startCommandCandidates`: public commands we *may* invoke to start Claude. Empty
 *   by default: the extension exposes no documented stable start command, and it
 *   would run in a different window anyway. We never call undocumented internals.
 */
export const CLAUDE_INTEGRATION = {
  displayName: "Claude Code",
  extensionIds: ["anthropic.claude-code"],
  marketplaceItemName: "anthropic.claude-code",
  cliAgentId: "claude",
  cliCommand: "claude",
  cliDocsUrl: "https://docs.anthropic.com/en/docs/claude-code",
  startCommandCandidates: [] as string[],
} as const;

/** The label used for the CLI-mode terminal. */
export const TERMINAL_NAME = "Yuhi · Claude Code";

/** User-facing strings kept in one place so tests can assert on them. */
export const LAUNCH_MESSAGES = {
  noWorkspace: "Yuhi: open a folder to prepare and launch.",
  cancelled: "Yuhi: preparation cancelled — no workspace was opened.",
  confirmOpen: "Open the prepared workspace in a new VS Code window?",
  extensionOpened:
    "Prepared Workspace opened\n\nClaude Code is ready to use in this window. Open Claude Code from the Activity Bar or Command Palette.",
  claudeNotInstalled:
    "The Claude Code extension is not installed. You can install it, or open the prepared workspace anyway.",
  cliNotInstalled:
    'The "claude" CLI was not found on your PATH. Install Claude Code, then run this command again.',
} as const;

/** Quick Pick action ids for the "extension not installed" branch. */
export const CLAUDE_MISSING_ACTIONS = {
  marketplace: "Install Claude Code",
  openAnyway: "Open Prepared Workspace anyway",
  cancel: "Cancel",
} as const;

// ---------------------------------------------------------------------------
// Outcome classification (single source of truth, shared by every command).
// ---------------------------------------------------------------------------

export type LaunchOutcome = "Complete" | "Complete with warnings" | "Partial" | "Failed";

/** Classify a PrepareReport. Mirrors the existing commandPrepare semantics exactly. */
export function classifyOutcome(report: PrepareReport): LaunchOutcome {
  const errs = report.errors.length;
  const blocked = report.blocked.length;
  const preparedOk = report.files.filter((f) => f.status === "ok" && !f.omitted).length;
  if (preparedOk === 0 && (errs > 0 || blocked > 0)) return "Failed";
  if (errs > 0) return "Partial";
  if (blocked > 0) return "Complete with warnings";
  return "Complete";
}

/** A prepared workspace is safe to open only when preparation did not end Partial/Failed. */
export function canOpen(outcome: LaunchOutcome): boolean {
  return outcome === "Complete" || outcome === "Complete with warnings";
}

// ---------------------------------------------------------------------------
// Summary shown before opening.
// ---------------------------------------------------------------------------

export interface PreparedSummary {
  runId: string;
  outDir: string;
  agent: string;
  sourceWorkspace: string;
  inspected: number;
  sent: number;
  preparedLocally: number;
  summarizedLocally: number;
  pseudonymized: number;
  filesMasked: number;
  keptLocal: number;
  excluded: number;
  sensitiveFindings: number;
  maskedValues: number;
  unresolvedHighRiskFindings: number;
  beforeTokens: number;
  afterTokens: number;
  avoidedTokens: number;
  reductionPercent: number;
  sourceModified: number;
  osSandboxEnabled: false;
}

/** Derive the display summary from a report (best-effort, honest counts). */
export function buildSummary(
  report: PrepareReport,
  sourceWorkspace = "",
  agent = "Claude Code",
): PreparedSummary {
  const m = buildPreparedMetrics(report);
  return {
    runId: report.runId,
    outDir: report.outDir,
    agent,
    sourceWorkspace,
    inspected: m.filesInspected,
    sent: m.filesSentUnchanged,
    preparedLocally: m.filesPreparedLocally,
    summarizedLocally: m.filesSummarized,
    pseudonymized: m.filesPseudonymized,
    filesMasked: m.filesWithMaskedValues,
    keptLocal: m.filesKeptLocal,
    excluded: m.filesExcluded,
    sensitiveFindings: m.sensitiveFindings,
    maskedValues: m.sensitiveValuesMasked,
    unresolvedHighRiskFindings: m.unresolvedHighRiskFindings,
    beforeTokens: m.estimatedTokensBefore,
    afterTokens: m.estimatedTokensAfter,
    avoidedTokens: m.estimatedTokensAvoided,
    reductionPercent: m.estimatedReductionPercent,
    sourceModified: m.originalSourceFilesModified,
    osSandboxEnabled: false,
  };
}

/** Multi-line, human-readable summary block (no source path, no machine info). */
export function formatSummaryDetail(s: PreparedSummary): string {
  const runtime = buildPreparedRuntimeBoundary("claude-code-sandbox");
  return [
    "Prepared by Yuhi",
    "",
    `Agent:                  ${s.agent}`,
    `Source workspace:       ${s.sourceWorkspace}`,
    `Prepared Workspace:     ${s.outDir}`,
    `Run ID:                 ${s.runId}`,
    "",
    "Context preparation",
    `Inspected files:        ${s.inspected}`,
    `Sent unchanged:         ${s.sent}`,
    `Prepared locally:       ${s.preparedLocally}`,
    `Summarized locally:     ${s.summarizedLocally}`,
    `Pseudonymized:          ${s.pseudonymized}`,
    `Files masked:           ${s.filesMasked}`,
    `Kept on your machine:   ${s.keptLocal}`,
    `Excluded:               ${s.excluded}`,
    `Sensitive findings detected: ${s.sensitiveFindings}`,
    `Sensitive values masked:${s.maskedValues}`,
    `Unresolved high-risk:   ${s.unresolvedHighRiskFindings}`,
    `Estimated tokens before: ${s.beforeTokens.toLocaleString()}`,
    `Estimated tokens after:  ${s.afterTokens.toLocaleString()}`,
    `Estimated tokens avoided:${s.avoidedTokens.toLocaleString()}`,
    `Estimated context reduction: ${s.reductionPercent.toFixed(1)}%`,
    `Original source files modified: ${s.sourceModified}`,
    "",
    "Runtime boundary",
    "Initial context prepared by Yuhi",
    "Claude Code starts in a Yuhi Prepared Workspace.",
    `Workspace boundary: ${runtime.workspaceBoundary}`,
    `Workspace-only instruction: ${runtime.workspaceInstructionPresent ? "enabled" : "not present"}`,
    `Filesystem enforcement: ${runtime.filesystemEnforcement === "none" ? "not enabled" : runtime.filesystemEnforcement}`,
    `OS sandbox: ${runtime.osSandboxEnabled ? "enabled" : "not enabled"}`,
    "External filesystem reads are restricted to the Prepared Workspace by Claude Code sandbox policy.",
  ].join("\n");
}

/** Success message shown after opening. Includes run id + prepared path + "modified: 0". */
export function formatOpenedMessage(s: PreparedSummary): string {
  return `Yuhi: opened prepared workspace (run ${s.runId}) at ${s.outDir}. Source files modified: 0.`;
}

/** Pure status text calculation, shared by activation wiring and unit tests. */
export function formatPreparedStatusText(metrics: PreparedMetrics): string {
  return metrics.sensitiveValuesMasked > 0 || metrics.filesExcluded > 0
    ? `$(shield) Prepared by Yuhi · ${metrics.sensitiveValuesMasked} masked · ${metrics.filesExcluded} excluded`
    : `$(shield) Prepared by Yuhi · −${metrics.estimatedReductionPercent.toFixed(1)}% context`;
}

export function preparedStatusTooltipLines(runId: string, metrics: PreparedMetrics): string[] {
  const runtime = buildPreparedRuntimeBoundary("claude-code-sandbox");
  return [
    "**Prepared by Yuhi**",
    `Run ID: \`${runId}\``,
    "Agent: Claude Code",
    `Estimated context reduction: ${metrics.estimatedReductionPercent.toFixed(1)}%`,
    `Sensitive findings detected: ${metrics.sensitiveFindings}`,
    `Sensitive values masked: ${metrics.sensitiveValuesMasked}`,
    `Files kept local: ${metrics.filesKeptLocal}`,
    `Files excluded: ${metrics.filesExcluded}`,
    "Original source files modified: 0",
    "Initial context prepared by Yuhi",
    "Claude Code starts in a Yuhi Prepared Workspace.",
    `Workspace boundary: ${runtime.workspaceBoundary}`,
    `Workspace-only instruction: ${runtime.workspaceInstructionPresent ? "enabled" : "not present"}`,
    `Filesystem enforcement: ${runtime.filesystemEnforcement === "none" ? "not enabled" : runtime.filesystemEnforcement}`,
    `OS sandbox: ${runtime.osSandboxEnabled ? "enabled" : "not enabled"}`,
    "External filesystem reads are restricted to the Prepared Workspace by Claude Code sandbox policy.",
  ];
}

// ---------------------------------------------------------------------------
// Prepared-workspace notice (generated inside the prepared workspace).
// ---------------------------------------------------------------------------

/**
 * Static notice content. Contains NO absolute paths, user names, or machine-specific
 * information — only fixed guidance for whatever agent opens the prepared workspace.
 */
export const PREPARED_WORKSPACE_NOTICE = `# Prepared by Yuhi

This is a generated **Yuhi Prepared Workspace**.

- The original workspace was not modified.
- Some files were excluded, kept local, summarized, pseudonymized, or masked.
- Claude Code should work only with files available in this workspace.
- Missing information should be reported instead of retrieving files from parent
  directories or absolute paths.
- Yuhi controls the initial prepared context.
- Yuhi configures Claude Code's OS-level sandbox for this workspace.
- Workspace boundary: enforced for Claude Code file and Bash access.
- Reading outside this Prepared Workspace is denied.

## Guidance for any AI agent working here

Work only within the currently opened workspace.

Do not access the original project directory or any absolute path outside this
workspace.

Do not search parent directories.

Base all analysis and edits only on files available in this prepared workspace.

If required information is missing, stop and report what is missing rather than
opening external paths.

Yuhi controls the prepared input context and installs a fail-closed Claude Code
sandbox policy. If the sandbox is unavailable or the policy cannot be verified,
Claude Code must not start from this workspace.
`;

export function formatPreparedWorkspaceNotice(metrics: PreparedMetrics): string {
  const runtime = buildPreparedRuntimeBoundary("claude-code-sandbox");
  return PREPARED_WORKSPACE_NOTICE.replace(
    "This is a generated **Yuhi Prepared Workspace**.",
    [
      "This is a generated **Yuhi Prepared Workspace**.",
      "",
      "## Context preparation",
      "",
      "- Initial context prepared by Yuhi.",
      `- Files excluded: ${metrics.filesExcluded}.`,
      `- Files kept local: ${metrics.filesKeptLocal}.`,
      `- Sensitive values masked: ${metrics.sensitiveValuesMasked}.`,
      `- Estimated context reduction: ${metrics.estimatedReductionPercent.toFixed(1)}%.`,
      "- Original files modified: 0.",
      "",
      "## Runtime boundary",
      "",
      "- Claude Code starts in a Yuhi Prepared Workspace.",
      `- Workspace-only instruction present: ${runtime.workspaceInstructionPresent ? "yes" : "no"}.`,
      `- Workspace boundary: ${runtime.workspaceBoundary}.`,
      `- Filesystem enforcement: ${runtime.filesystemEnforcement === "none" ? "not enabled" : runtime.filesystemEnforcement}.`,
      `- OS sandbox: ${runtime.osSandboxEnabled ? "enabled" : "not enabled"}.`,
      `- External-path access may still be possible: ${runtime.externalPathAccessPossible ? "yes" : "no"}.`,
    ].join("\n"),
  );
}

/** Relative location of the notice inside a prepared workspace. */
export const PREPARED_NOTICE_RELPATH = path.join(".yuhi", "PREPARED_WORKSPACE.md");

/** Write the notice into the prepared workspace. `writer`/`mkDir` are injectable for tests. */
export async function writePreparedNotice(
  outDir: string,
  metrics?: PreparedMetrics,
  writer: (p: string, data: string) => Promise<void> = (p, data) => writeFile(p, data, "utf8"),
  mkDir: (p: string) => Promise<void> = async (p) => {
    await mkdir(p, { recursive: true });
  },
): Promise<string> {
  const target = path.join(outDir, PREPARED_NOTICE_RELPATH);
  await mkDir(path.dirname(target));
  await writer(target, metrics ? formatPreparedWorkspaceNotice(metrics) : PREPARED_WORKSPACE_NOTICE);
  return target;
}

// ---------------------------------------------------------------------------
// Path validation.
// ---------------------------------------------------------------------------

/**
 * A new prepared path is valid only when it is one direct child of Yuhi's
 * OS-managed workspace root. The source root is accepted only as an unused
 * compatibility parameter; it is never the prepared base.
 */
export function validatePreparedPath(_root: string, outDir: string): boolean {
  const base = path.resolve(managedWorkspaceBaseDir());
  const resolved = path.resolve(outDir);
  const rel = path.relative(base, resolved);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

/** Validate lexical containment and reject a symlinked run directory before any write/open. */
export async function assertPreparedPath(root: string, outDir: string): Promise<void> {
  if (!validatePreparedPath(root, outDir)) {
    throw new Error(`Refusing to use: "${outDir}" is not a valid prepared workspace path.`);
  }
  const stat = await lstat(outDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Refusing to use a prepared workspace that is not a real directory.");
  }
  const base = await realpath(path.resolve(managedWorkspaceBaseDir()));
  const target = await realpath(outDir);
  if (path.dirname(target) !== base) {
    throw new Error("Refusing to use a prepared workspace outside Yuhi's managed workspace directory.");
  }
}

export interface PreparedSession {
  schemaVersion: 2;
  preparedBy: "Yuhi";
  runId: string;
  agent: "claude-code";
  createdAt: string;
  sourceWorkspaceId: string;
  preparationResult: "complete" | "complete-with-warnings";
  metrics: PreparedMetrics;
  runtime: PreparedRuntimeBoundary;
}

export const PREPARED_SESSION_RELPATH = path.join(".yuhi", "session.json");
export const PREPARED_AUDIT_RELPATH = path.join(".yuhi", "launch-audit.jsonl");
export const CLAUDE_SANDBOX_RELPATH = path.join(".claude", "settings.json");

export const CLAUDE_SANDBOX_POLICY = {
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    autoAllowBashIfSandboxed: false,
    filesystem: {
      denyRead: ["~/"],
      allowRead: ["."],
    },
  },
  permissions: {
    defaultMode: "default",
    disableBypassPermissionsMode: "disable",
    disableAutoMode: "disable",
  },
} as const;

export async function writeAndVerifyClaudeSandboxPolicy(
  root: string,
  outDir: string,
): Promise<string> {
  await assertPreparedPath(root, outDir);
  const target = path.join(outDir, CLAUDE_SANDBOX_RELPATH);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify(CLAUDE_SANDBOX_POLICY, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(target, 0o600);
  const saved = JSON.parse(await readFile(target, "utf8")) as typeof CLAUDE_SANDBOX_POLICY;
  if (
    saved.sandbox?.enabled !== true ||
    saved.sandbox?.failIfUnavailable !== true ||
    saved.sandbox?.allowUnsandboxedCommands !== false ||
    !Array.isArray(saved.sandbox?.excludedCommands) ||
    saved.sandbox.excludedCommands.length !== 0 ||
    saved.sandbox?.filesystem?.denyRead?.[0] !== "~/" ||
    saved.sandbox?.filesystem?.allowRead?.[0] !== "." ||
    saved.permissions?.disableBypassPermissionsMode !== "disable" ||
    saved.permissions?.disableAutoMode !== "disable"
  ) {
    throw new Error("Yuhi could not verify the Claude Code sandbox policy. Launch blocked.");
  }
  return target;
}

/** Read schema v2 and upgrade schema v1 metadata in memory without rewriting it. */
export function normalizePreparedSession(value: unknown): PreparedSession {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Prepared Workspace session.");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) {
    throw new Error("Unsupported Prepared Workspace session schema.");
  }
  const old = (raw.metrics ?? {}) as Record<string, unknown>;
  const number = (key: string, legacy?: string): number => {
    const candidate = old[key] ?? (legacy ? old[legacy] : undefined);
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
  };
  const metrics: PreparedMetrics = {
    filesInspected: number("filesInspected"),
    filesWithSensitiveFindings: number("filesWithSensitiveFindings", "filesContainingSensitiveFindings"),
    filesSentUnchanged: number("filesSentUnchanged"),
    filesPreparedLocally: number("filesPreparedLocally"),
    preparedFilesModified: number("preparedFilesModified", "filesModifiedInPreparedWorkspace"),
    filesSummarized: number("filesSummarized"),
    filesPseudonymized: number("filesPseudonymized"),
    filesWithMaskedValues: number("filesWithMaskedValues", "filesMasked"),
    filesKeptLocal: number("filesKeptLocal"),
    filesExcluded: number("filesExcluded"),
    sensitiveFilesExcluded: number("sensitiveFilesExcluded"),
    sensitiveFindings: number("sensitiveFindings"),
    sensitiveValuesMasked: number("sensitiveValuesMasked"),
    unresolvedHighRiskFindings: number("unresolvedHighRiskFindings"),
    findingsByCategory:
      typeof old.findingsByCategory === "object" && old.findingsByCategory !== null
        ? (old.findingsByCategory as Record<string, number>)
        : {},
    estimatedTokensBefore: number("estimatedTokensBefore"),
    estimatedTokensAfter: number("estimatedTokensAfter"),
    estimatedTokensAvoided: number("estimatedTokensAvoided"),
    estimatedReductionPercent: number("estimatedReductionPercent"),
    originalSourceFilesModified: 0,
  };
  const storedRuntime = raw.runtime as Record<string, unknown> | undefined;
  const runtime =
    raw.schemaVersion === 2 &&
    storedRuntime?.filesystemEnforcement === "claude-code-sandbox" &&
    storedRuntime.osSandboxEnabled === true &&
    storedRuntime.externalPathAccessPossible === false
      ? buildPreparedRuntimeBoundary("claude-code-sandbox")
      : buildPreparedRuntimeBoundary();
  return {
    schemaVersion: 2,
    preparedBy: "Yuhi",
    runId: typeof raw.runId === "string" ? raw.runId : "",
    agent: "claude-code",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    sourceWorkspaceId: typeof raw.sourceWorkspaceId === "string" ? raw.sourceWorkspaceId : "",
    preparationResult: raw.preparationResult === "complete-with-warnings" ? "complete-with-warnings" : "complete",
    metrics,
    runtime,
  };
}

export async function writeSessionMetadata(
  root: string,
  report: PrepareReport,
  outcome: LaunchOutcome,
  createdAt = new Date().toISOString(),
): Promise<PreparedSession> {
  await assertPreparedPath(root, report.outDir);
  const session: PreparedSession = {
    schemaVersion: 2,
    preparedBy: "Yuhi",
    runId: report.runId,
    agent: "claude-code",
    createdAt,
    sourceWorkspaceId: opaqueWorkspaceId(root),
    preparationResult: outcome === "Complete" ? "complete" : "complete-with-warnings",
    metrics: buildPreparedMetrics(report),
    runtime: buildPreparedRuntimeBoundary("claude-code-sandbox"),
  };
  const target = path.join(report.outDir, PREPARED_SESSION_RELPATH);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(session, null, 2) + "\n", "utf8");
  return session;
}

export type LaunchAuditEvent =
  | "preparation-started"
  | "preparation-completed"
  | "review-opened"
  | "launch-approved"
  | "launch-cancelled"
  | "claude-extension-detected"
  | "prepared-workspace-opened"
  | "unresolved-finding-override";

export async function appendLaunchAudit(
  root: string,
  outDir: string,
  runId: string,
  event: LaunchAuditEvent,
  createdAt = new Date().toISOString(),
): Promise<void> {
  await assertPreparedPath(root, outDir);
  const target = path.join(outDir, PREPARED_AUDIT_RELPATH);
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, JSON.stringify({ schemaVersion: 1, createdAt, runId, event }) + "\n", "utf8");
}

async function writePreparedArtifacts(
  root: string,
  report: PrepareReport,
  outcome: LaunchOutcome,
): Promise<void> {
  await assertPreparedPath(root, report.outDir);
  await writeAndVerifyClaudeSandboxPolicy(root, report.outDir);
  await writePreparedNotice(report.outDir, buildPreparedMetrics(report));
  await writeSessionMetadata(root, report, outcome);
}

// ---------------------------------------------------------------------------
// Host abstraction (the only VS Code surface used by the services below).
// ---------------------------------------------------------------------------

export interface LaunchTerminal {
  sendText(text: string, addNewLine?: boolean): void;
  show(): void;
}

export interface LaunchHost {
  /** Wraps `vscode.commands.executeCommand("vscode.openFolder", Uri.file(path), newWindow)`. */
  openFolder(folderPath: string, newWindow: boolean): Promise<void>;
  /** Whether an extension id is installed (wraps `vscode.extensions.getExtension`). */
  isExtensionInstalled(id: string): boolean;
  createTerminal(name: string, cwd: string): LaunchTerminal;
  openExternal(url: string): Promise<boolean>;
  showInfo(message: string, ...actions: string[]): Promise<string | undefined>;
  showWarning(message: string, ...actions: string[]): Promise<string | undefined>;
  showError(message: string, ...actions: string[]): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Claude integration resolution.
// ---------------------------------------------------------------------------

export interface ClaudeIntegration {
  installed: boolean;
  extensionId?: string;
}

/** Detect the installed Claude Code extension by inspecting candidate IDs in order. */
export function resolveClaudeIntegration(host: Pick<LaunchHost, "isExtensionInstalled">): ClaudeIntegration {
  for (const id of CLAUDE_INTEGRATION.extensionIds) {
    if (host.isExtensionInstalled(id)) return { installed: true, extensionId: id };
  }
  return { installed: false };
}

/** The official Marketplace listing URL for the Claude Code extension. */
export function claudeMarketplaceUrl(): string {
  return `https://marketplace.visualstudio.com/items?itemName=${CLAUDE_INTEGRATION.marketplaceItemName}`;
}

// ---------------------------------------------------------------------------
// Open + CLI primitives.
// ---------------------------------------------------------------------------

/** Validate then open the prepared workspace in a NEW window. Never opens the source root. */
export async function openPreparedWorkspace(
  host: Pick<LaunchHost, "openFolder">,
  root: string,
  preparedPath: string,
): Promise<void> {
  await assertPreparedPath(root, preparedPath);
  await host.openFolder(preparedPath, true);
}

/** Single-quote a token for POSIX shells (safe for paths with spaces/metachars). */
function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Start the Claude Code CLI in a labelled terminal whose cwd IS the prepared
 * workspace. The command is assembled from quoted tokens (never an unescaped path).
 */
export function startClaudeCliInTerminal(
  host: Pick<LaunchHost, "createTerminal">,
  preparedPath: string,
  cliFile: string,
  forwardedArgs: string[] = [],
): LaunchTerminal {
  const term = host.createTerminal(TERMINAL_NAME, preparedPath);
  const command = [cliFile, ...forwardedArgs].map(shQuote).join(" ");
  term.sendText(command, true);
  term.show();
  return term;
}

// ---------------------------------------------------------------------------
// Orchestrators (injected deps → fully testable).
// ---------------------------------------------------------------------------

export interface PrepareDeps {
  host: LaunchHost;
  getWorkspaceRoot(): string | undefined;
  /**
   * Runs the SAME safe preparation pipeline as `Yuhi: Prepare Workspace` (progress +
   * gating live in the caller). Returns the report, `undefined` if the user cancelled.
   * This is the single preparation entry point — no command duplicates it.
   */
  prepare(root: string): Promise<PrepareReport | undefined>;
  /** Open metadata-safe blocked review when preparation cannot launch. */
  reviewBlocked?(): Promise<unknown>;
}

export interface PrepareAndOpenDeps extends PrepareDeps {
  /** Shows the summary and asks for explicit confirmation. */
  confirmOpen(summary: PreparedSummary): Promise<boolean>;
  /** Separate, explicit acknowledgement when high-risk findings would remain unchanged. */
  confirmHighRiskOverride?(count: number): Promise<boolean>;
}

export type PrepareAndOpenResult =
  | { status: "no-workspace" }
  | { status: "cancelled" }
  | { status: "blocked"; outcome: LaunchOutcome }
  | { status: "declined" }
  | { status: "opened"; outDir: string; outcome: LaunchOutcome };

/** Command 1 — Prepare and Open in New Window (Claude-independent). */
export async function runPrepareAndOpen(deps: PrepareAndOpenDeps): Promise<PrepareAndOpenResult> {
  const root = deps.getWorkspaceRoot();
  if (!root) {
    await deps.host.showInfo(LAUNCH_MESSAGES.noWorkspace);
    return { status: "no-workspace" };
  }
  const report = await launchStage("preparation-failure", () => deps.prepare(root));
  if (!report) {
    await deps.host.showInfo(LAUNCH_MESSAGES.cancelled);
    return { status: "cancelled" };
  }
  const outcome = classifyOutcome(report);
  await launchStage("post-prepare-validation", async () => {
    await appendLaunchAudit(root, report.outDir, report.runId, "preparation-started");
    await appendLaunchAudit(root, report.outDir, report.runId, "preparation-completed");
  });
  if (!canOpen(outcome)) {
    if (deps.reviewBlocked) {
      await launchStage("review-ui-failure", () => deps.reviewBlocked!());
    } else {
      await deps.host.showError(
        `Yuhi: preparation ended "${outcome}" — not opening a partial workspace. Review the blocked files and prepare again.`,
      );
    }
    return { status: "blocked", outcome };
  }
  const summary = buildSummary(report, root);
  if (summary.unresolvedHighRiskFindings > 0) {
    const overridden =
      deps.confirmHighRiskOverride !== undefined &&
      (await launchStage("confirmation-failure", () =>
        deps.confirmHighRiskOverride!(summary.unresolvedHighRiskFindings),
      ));
    if (!overridden) {
      await deps.host.showError(
        `Yuhi: ${summary.unresolvedHighRiskFindings} unresolved high-risk finding(s) remain — launch blocked.`,
      );
      return { status: "blocked", outcome: "Partial" };
    }
    await appendLaunchAudit(root, report.outDir, report.runId, "unresolved-finding-override");
  }
  const confirmed = await launchStage("confirmation-failure", () => deps.confirmOpen(summary));
  if (!confirmed) {
    await appendLaunchAudit(root, report.outDir, report.runId, "launch-cancelled");
    return { status: "declined" };
  }
  await launchStage("post-prepare-validation", async () => {
    await writePreparedArtifacts(root, report, outcome);
    await appendLaunchAudit(root, report.outDir, report.runId, "launch-approved");
  });
  await launchStage("prepared-workspace-open-failure", () =>
    openPreparedWorkspace(deps.host, root, report.outDir),
  );
  await appendLaunchAudit(root, report.outDir, report.runId, "prepared-workspace-opened");
  await deps.host.showInfo(formatOpenedMessage(summary));
  return { status: "opened", outDir: report.outDir, outcome };
}

export type ClaudeMode = "extension" | "cli";

export interface PrepareAndStartClaudeDeps extends PrepareDeps {
  /** Presents the mode Quick Pick; `undefined` means the user cancelled. */
  pickMode(): Promise<ClaudeMode | undefined>;
  /** Resolve the Claude CLI absolute path (Yuhi agent discovery); null if not installed. */
  resolveCliFile(): string | null;
  /** Optional CLI args to forward (preserves existing adapter behavior). */
  forwardedArgs?: string[];
  /** Required human review/confirmation before any Claude launch. */
  confirmLaunch(summary: PreparedSummary): Promise<"open" | "review" | "cancel">;
  reviewDetails(): Promise<"open" | "cancel" | void>;
  /** Separate, explicit acknowledgement when high-risk findings would remain unchanged. */
  confirmHighRiskOverride?(count: number): Promise<boolean>;
}

export type PrepareAndStartClaudeResult =
  | { status: "no-workspace" }
  | { status: "cancelled" }
  | { status: "blocked"; outcome: LaunchOutcome }
  | { status: "extension-opened"; outDir: string }
  | { status: "extension-missing-handled"; action: string }
  | { status: "cli-started"; outDir: string }
  | { status: "cli-missing" };

/** Command 2 — Prepare and Start Claude Code (mode A: extension, mode B: CLI). */
export async function runPrepareAndStartClaude(
  deps: PrepareAndStartClaudeDeps,
): Promise<PrepareAndStartClaudeResult> {
  const root = deps.getWorkspaceRoot();
  if (!root) {
    await deps.host.showInfo(LAUNCH_MESSAGES.noWorkspace);
    return { status: "no-workspace" };
  }
  const report = await launchStage("preparation-failure", () => deps.prepare(root));
  if (!report) {
    await deps.host.showInfo(LAUNCH_MESSAGES.cancelled);
    return { status: "cancelled" };
  }
  const outcome = classifyOutcome(report);
  await launchStage("post-prepare-validation", async () => {
    await appendLaunchAudit(root, report.outDir, report.runId, "preparation-started");
    await appendLaunchAudit(root, report.outDir, report.runId, "preparation-completed");
  });
  if (!canOpen(outcome)) {
    if (deps.reviewBlocked) {
      await launchStage("review-ui-failure", () => deps.reviewBlocked!());
    } else {
      await deps.host.showError(
        `Yuhi: preparation ended "${outcome}" — not opening a partial workspace. Review the blocked files and prepare again.`,
      );
    }
    return { status: "blocked", outcome };
  }
  await launchStage("post-prepare-validation", () =>
    writeAndVerifyClaudeSandboxPolicy(root, report.outDir),
  );
  const mode = await launchStage("confirmation-failure", () => deps.pickMode());
  if (!mode) {
    await appendLaunchAudit(root, report.outDir, report.runId, "launch-cancelled");
    return { status: "cancelled" };
  }
  const summary = buildSummary(report, root);
  if (summary.unresolvedHighRiskFindings > 0) {
    const overridden =
      deps.confirmHighRiskOverride !== undefined &&
      (await launchStage("confirmation-failure", () =>
        deps.confirmHighRiskOverride!(summary.unresolvedHighRiskFindings),
      ));
    if (!overridden) {
      await deps.host.showError(
        `Yuhi: ${summary.unresolvedHighRiskFindings} unresolved high-risk finding(s) remain — launch blocked.`,
      );
      return { status: "blocked", outcome: "Partial" };
    }
    await appendLaunchAudit(root, report.outDir, report.runId, "unresolved-finding-override");
  }
  while (true) {
    const confirmation = await launchStage("confirmation-failure", () =>
      deps.confirmLaunch(summary),
    );
    if (confirmation === "review") {
      const reviewDecision = await launchStage("review-ui-failure", () => deps.reviewDetails());
      if (reviewDecision === "open") break;
      if (reviewDecision === "cancel") {
        await appendLaunchAudit(root, report.outDir, report.runId, "launch-cancelled");
        return { status: "cancelled" };
      }
      continue;
    }
    if (confirmation === "cancel") {
      await appendLaunchAudit(root, report.outDir, report.runId, "launch-cancelled");
      return { status: "cancelled" };
    }
    break;
  }
  await launchStage("post-prepare-validation", async () => {
    await writePreparedArtifacts(root, report, outcome);
    await appendLaunchAudit(root, report.outDir, report.runId, "launch-approved");
  });

  if (mode === "extension") return startClaudeExtensionMode(deps, root, report);
  return startClaudeCliMode(deps, root, report);
}

async function startClaudeExtensionMode(
  deps: PrepareAndStartClaudeDeps,
  root: string,
  report: PrepareReport,
): Promise<PrepareAndStartClaudeResult> {
  await writeAndVerifyClaudeSandboxPolicy(root, report.outDir);
  const claude = resolveClaudeIntegration(deps.host);
  if (!claude.installed) {
    const choice = await deps.host.showWarning(
      LAUNCH_MESSAGES.claudeNotInstalled,
      CLAUDE_MISSING_ACTIONS.marketplace,
      CLAUDE_MISSING_ACTIONS.openAnyway,
      CLAUDE_MISSING_ACTIONS.cancel,
    );
    if (choice === CLAUDE_MISSING_ACTIONS.marketplace) {
      await deps.host.openExternal(claudeMarketplaceUrl());
      return { status: "extension-missing-handled", action: CLAUDE_MISSING_ACTIONS.marketplace };
    }
    if (choice === CLAUDE_MISSING_ACTIONS.openAnyway) {
      await openPreparedWorkspace(deps.host, root, report.outDir);
      await appendLaunchAudit(root, report.outDir, report.runId, "prepared-workspace-opened");
      return { status: "extension-opened", outDir: report.outDir };
    }
    await appendLaunchAudit(root, report.outDir, report.runId, "launch-cancelled");
    return { status: "extension-missing-handled", action: CLAUDE_MISSING_ACTIONS.cancel };
  }
  // Installed: open the prepared workspace in a new window; do not activate Claude in
  // the source window, do not send a prompt, do not claim OS sandboxing.
  await appendLaunchAudit(root, report.outDir, report.runId, "claude-extension-detected");
  await openPreparedWorkspace(deps.host, root, report.outDir);
  await appendLaunchAudit(root, report.outDir, report.runId, "prepared-workspace-opened");
  await deps.host.showInfo(LAUNCH_MESSAGES.extensionOpened);
  return { status: "extension-opened", outDir: report.outDir };
}

async function startClaudeCliMode(
  deps: PrepareAndStartClaudeDeps,
  root: string,
  report: PrepareReport,
): Promise<PrepareAndStartClaudeResult> {
  await writeAndVerifyClaudeSandboxPolicy(root, report.outDir);
  const cliFile = deps.resolveCliFile();
  if (!cliFile) {
    const choice = await deps.host.showWarning(LAUNCH_MESSAGES.cliNotInstalled, "Open installation docs");
    if (choice === "Open installation docs") await deps.host.openExternal(CLAUDE_INTEGRATION.cliDocsUrl);
    // Do NOT silently fall back to the extension.
    return { status: "cli-missing" };
  }
  await assertPreparedPath(root, report.outDir);
  startClaudeCliInTerminal(deps.host, report.outDir, cliFile, deps.forwardedArgs ?? []);
  return { status: "cli-started", outDir: report.outDir };
}
