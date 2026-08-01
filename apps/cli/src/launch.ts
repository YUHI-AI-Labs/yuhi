/**
 * `yuhi launch <agent>` — personal-first launch of a prepared run (v0.3.4).
 *
 * Resolves a prepared run (the latest completed run, or an explicit `--run`),
 * gets the allowlisted adapter from the registry, detects the agent CLI (SHORT
 * timeout — never hangs), generates the agent-specific instruction file into the
 * prepared repo, prints a short, jargon-free summary, then launches the agent in
 * the prepared workspace.
 *
 * All heavy dependencies are injectable so this is unit-testable with a fake
 * runner / fake adapters — the real `claude` / `codex` CLIs are NEVER spawned in tests.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import type { AgentCommand } from "@yuhi/shared";
import {
  validatePreparedRun,
  managedWorkspaceBaseDir,
  capturePatchSession,
  computeRevisionId,
  readPrivateRunSourceBinding,
  readPublicStatus,
  loadPatchSession,
  reviewPatchSession,
  type CorePreparedSession,
} from "@yuhi/core";
import {
  createDefaultRegistry,
  toPublicAgentSessionManifest,
  DEFAULT_DETECT_TIMEOUT_MS,
  type AgentRegistry,
  type AgentRunOutcome,
  type PreparedAgentContext,
} from "@yuhi/agents";

export interface ResolvedRun {
  workspace: string;
  session: CorePreparedSession;
}

export type RunResolution =
  | { ok: true; run: ResolvedRun }
  | { ok: false; category: string };

/**
 * Find the newest LAUNCHABLE prepared run in managed storage. A run qualifies only
 * when {@link validatePreparedRun} accepts it (Success + launchAllowed + no
 * unresolved high-risk findings). Newest is by directory mtime.
 */
export async function findLatestPreparedRun(): Promise<ResolvedRun | null> {
  const base = managedWorkspaceBaseDir();
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return null;
  }
  const candidates: { run: ResolvedRun; mtimeMs: number }[] = [];
  for (const name of entries) {
    const dir = path.join(base, name);
    let mtimeMs = 0;
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    const validation = await validatePreparedRun(name);
    if (validation.kind === "valid") {
      candidates.push({ run: { workspace: validation.workspace, session: validation.session }, mtimeMs });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]!.run;
}

/**
 * Resolve the prepared run to launch. An explicit reference is validated and a
 * stale/nonexistent/blocked run is REJECTED with a safe category. With no
 * reference, the latest completed run is used.
 */
export async function resolveRunForLaunch(
  ref: string | undefined,
  deps?: {
    validate?: typeof validatePreparedRun;
    latest?: () => Promise<ResolvedRun | null>;
  },
): Promise<RunResolution> {
  const validate = deps?.validate ?? validatePreparedRun;
  const latest = deps?.latest ?? findLatestPreparedRun;
  if (ref !== undefined && ref !== "") {
    let validation;
    try {
      validation = await validate(ref);
    } catch {
      return { ok: false, category: "invalid-or-missing-run" };
    }
    if (validation.kind === "valid") {
      return { ok: true, run: { workspace: validation.workspace, session: validation.session } };
    }
    return { ok: false, category: validation.category };
  }
  const run = await latest();
  if (!run) return { ok: false, category: "no-completed-run" };
  return { ok: true, run };
}

export interface LaunchSummary {
  agentDisplayName: string;
  contextId: string;
  filesVisible: number;
  contextReductionPercent: number;
  secretsExposed: number;
  workspacePath: string;
}

/** Pull the personal-first summary numbers from a prepared run's session. */
export function buildLaunchSummary(
  run: ResolvedRun,
  agentDisplayName: string,
): LaunchSummary {
  const summary = run.session.summary;
  return {
    agentDisplayName,
    contextId: run.session.contextId ?? summary.contextId ?? "(unavailable)",
    filesVisible: summary.filesIncluded,
    contextReductionPercent: summary.preparationReport.estimatedReductionPercent,
    // Yuhi never delivers raw secrets; unresolved high-risk findings are 0 for a
    // launchable run. Surface it explicitly so the user sees "Secrets exposed: 0".
    secretsExposed: summary.unresolvedHighRiskFindings,
    workspacePath: run.workspace,
  };
}

/** The short, jargon-free block printed right before launch (personal summary). */
export function formatLaunchSummary(s: LaunchSummary): string {
  return [
    `Ready for ${s.agentDisplayName}`,
    `Context ID: ${s.contextId}`,
    `Files visible: ${s.filesVisible}`,
    `Context reduction: ${s.contextReductionPercent}%`,
    `Secrets exposed: ${s.secretsExposed}`,
    `Launching ${s.agentDisplayName} in: ${s.workspacePath}`,
  ].join("\n");
}

export interface PerformLaunchOptions {
  agentId: string;
  runRef?: string;
  forwardedArgs?: readonly string[];
  /** false = dry-run (prepare + summary, no spawn). Defaults to true. */
  spawn?: boolean;
  json?: boolean;
  verbose?: boolean;
  // Injectables (tests) ----------------------------------------------------
  registry?: AgentRegistry;
  resolveRun?: (ref: string | undefined) => Promise<RunResolution>;
  runner?: (command: AgentCommand) => Promise<AgentRunOutcome>;
  detectTimeoutMs?: number;
  sessionId?: string;
  startedAt?: string;
  managedBase?: string;
  /** Test seam; production always uses the private core snapshot implementation. */
  captureBaseline?: (input: {
    managedBase: string;
    runId: string;
    sessionId: string;
    contextId: string;
    revisionId: string;
    preparedRoot: string;
    agentId: "claude" | "codex";
    inheritFromSessionId?: string;
  }) => Promise<string>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * The full launch flow. Returns a process exit code (never throws for expected
 * failures — unavailable agent, stale run, launch failure — each returns a clear,
 * finite result).
 */
export async function performLaunch(opts: PerformLaunchOptions): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const err = opts.err ?? ((l: string) => console.error(l));
  const registry = opts.registry ?? createDefaultRegistry();
  const resolveRun = opts.resolveRun ?? ((ref) => resolveRunForLaunch(ref));

  // Unknown / non-allowlisted id → rejected, never executed.
  if (!registry.has(opts.agentId)) {
    err(`Unknown agent "${opts.agentId}".\n\nSafe error category: unknown-agent`);
    return 3;
  }

  // Resolve the prepared run; reject stale/nonexistent/blocked.
  const resolution = await resolveRun(opts.runRef);
  if (!resolution.ok) {
    if (opts.json) out(JSON.stringify({ command: "launch", error: "invalid-or-missing-run", category: resolution.category }, null, 2));
    else err(`Recovery required\n\nSafe error category: invalid-or-missing-run (${resolution.category})`);
    return 3;
  }
  const run = resolution.run;
  const managedBase = opts.managedBase ?? managedWorkspaceBaseDir();

  const adapter = await registry.get(opts.agentId);

  // Detect with a SHORT timeout — a launch surface must never hang on detection.
  const availability = await adapter.detect({
    timeoutMs: opts.detectTimeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS,
  });
  if (!availability.available) {
    if (opts.json) out(JSON.stringify({ command: "launch", agent: opts.agentId, available: false, installHint: availability.installHint }, null, 2));
    else {
      err(`${adapter.displayName} is not installed.`);
      if (availability.installHint) err(availability.installHint);
    }
    return 4;
  }

  const context: PreparedAgentContext = {
    workingDirectory: run.workspace,
    contextId: run.session.contextId ?? run.session.summary.contextId ?? "",
    runId: run.session.runId,
  };

  const plan = await adapter.prepare(context, {
    ...(opts.forwardedArgs ? { forwardedArgs: [...opts.forwardedArgs] } : {}),
  });

  const sessionId = opts.sessionId ?? randomUUID();
  let snapshotId: string | undefined;
  let launchedRevisionId: string | undefined;
  let inheritPatchSessionId: string | undefined;
  try {
    const previous = await loadPatchSession(managedBase, run.session.runId).catch(() => undefined);
    if (previous) {
      const unreviewed = await reviewPatchSession(previous).catch(() => undefined);
      if (unreviewed && unreviewed.changes.length > 0) {
        err("warning: Unreviewed changes from a previous agent session exist. They remain in the Prepared Repository and will not be applied automatically.");
        inheritPatchSessionId = previous.sessionId;
      }
    }
    const publicStatus = await readPublicStatus(run.workspace);
    const baseContextId = context.contextId;
    const revisionId = publicStatus?.revisionId ?? computeRevisionId({ baseContextId, files: [] });
    launchedRevisionId = revisionId;
    if (opts.captureBaseline) {
      snapshotId = await opts.captureBaseline({
        managedBase,
        runId: run.session.runId,
        sessionId,
        contextId: baseContextId,
        revisionId,
        preparedRoot: run.workspace,
        agentId: opts.agentId as "claude" | "codex",
        ...(inheritPatchSessionId ? { inheritFromSessionId: inheritPatchSessionId } : {}),
      });
    } else {
      const binding = await readPrivateRunSourceBinding(managedBase, run.session.runId);
      const patchSession = await capturePatchSession({
        managedBase,
        runId: run.session.runId,
        sessionId,
        contextId: baseContextId,
        revisionId,
        preparedRoot: run.workspace,
        sourceRoot: binding.sourceRoot,
        agentId: opts.agentId as "claude" | "codex",
        ...(inheritPatchSessionId ? { inheritFromSessionId: inheritPatchSessionId } : {}),
      });
      snapshotId = patchSession.snapshotId;
    }
    const statusAfterSnapshot = await readPublicStatus(run.workspace);
    if (statusAfterSnapshot?.revisionId && statusAfterSnapshot.revisionId !== revisionId) {
      throw new Error("context-revision-changed-during-snapshot");
    }
  } catch {
    err("Yuhi could not create the private pre-agent patch snapshot. Agent launch was not attempted.\n\nSafe error category: patch-snapshot-unavailable");
    return 3;
  }

  const summary = buildLaunchSummary(run, adapter.displayName);
  if (!opts.json) {
    out(formatLaunchSummary(summary));
    for (const w of plan.warnings) err(`warning: ${w}`);
  }

  const session = await adapter.launch(plan, {
    spawn: opts.spawn ?? true,
    ...(opts.runner ? { runner: opts.runner } : {}),
    sessionId,
    ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
  });

  const publicManifest = toPublicAgentSessionManifest({
    ...session,
    ...(launchedRevisionId ? { revisionId: launchedRevisionId } : {}),
    ...(snapshotId ? { snapshotId } : {}),
  });
  if (opts.json) {
    out(JSON.stringify({ command: "launch", summary, session: publicManifest }, null, 2));
  } else if (opts.verbose) {
    out("");
    out(`Session: ${publicManifest.sessionId}`);
    out(`Context ID: ${publicManifest.contextId}`);
    out(`Status: ${publicManifest.status}`);
  }

  if (session.status === "failed") return 4;
  if (session.status === "exited") return session.exitCode ?? 0;
  return 0; // prepared (dry-run)
}
