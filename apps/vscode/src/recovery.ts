import * as path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";

export type RecoveryReason =
  | "prepared-workspace-missing"
  | "prepared-workspace-not-directory"
  | "run-quarantined"
  | "manifest-missing"
  | "manifest-invalid"
  | "session-missing"
  | "session-invalid"
  | "preparation-incomplete"
  | "unresolved-high-risk"
  | "unexpected-workspace"
  | "nested-prepared-workspace";

export type ReconciledPreparedState =
  | { kind: "valid"; runId: string; workspace: string }
  | { kind: "recovery-required"; reason: RecoveryReason; message: string };

const MESSAGES: Record<RecoveryReason, string> = {
  "prepared-workspace-missing": "Previous Prepared Workspace is no longer available",
  "prepared-workspace-not-directory": "Prepared Workspace metadata is invalid",
  "run-quarantined": "This run cannot be opened because it was removed or quarantined.",
  "manifest-missing": "Preparation did not complete",
  "manifest-invalid": "Prepared Workspace metadata is invalid",
  "session-missing": "Preparation did not complete",
  "session-invalid": "Prepared Workspace metadata is invalid",
  "preparation-incomplete": "Preparation did not complete",
  "unresolved-high-risk": "Preparation is blocked by unresolved high-risk findings",
  "unexpected-workspace": "This window is not the expected Prepared Workspace",
  "nested-prepared-workspace": "A Prepared Workspace cannot be nested inside another Prepared Workspace",
};

function recovery(reason: RecoveryReason): ReconciledPreparedState {
  return { kind: "recovery-required", reason, message: MESSAGES[reason] };
}

async function json(pathname: string): Promise<Record<string, unknown> | undefined | null> {
  try {
    const value: unknown = JSON.parse(await readFile(pathname, "utf8"));
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

/**
 * Reconcile untrusted UI/in-memory state with the exact workspace on disk.
 * This function is read-only and never returns paths in its diagnostic message.
 */
export async function validatePreparedWorkspace(input: {
  workspace: string;
  expectedWorkspace?: string;
  managedBase: string;
  quarantineBase: string;
}): Promise<ReconciledPreparedState> {
  const requested = path.resolve(input.workspace);
  const quarantine = path.resolve(input.quarantineBase);
  if (requested === quarantine || requested.startsWith(`${quarantine}${path.sep}`)) {
    return recovery("run-quarantined");
  }

  let workspace: string;
  try {
    const stat = await lstat(requested);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return recovery("prepared-workspace-not-directory");
    workspace = await realpath(requested);
  } catch {
    return recovery("prepared-workspace-missing");
  }

  let managed: string;
  try {
    managed = await realpath(path.resolve(input.managedBase));
  } catch {
    return recovery("unexpected-workspace");
  }
  if (path.dirname(workspace) !== managed) return recovery("unexpected-workspace");

  if (input.expectedWorkspace) {
    try {
      if (await realpath(input.expectedWorkspace) !== workspace) return recovery("unexpected-workspace");
    } catch {
      return recovery("prepared-workspace-missing");
    }
  }

  // A run directory must be a direct managed child. Parent markers indicate a
  // nested/stale Prepared Workspace even if a copied child looks otherwise valid.
  const parentManifest = await json(path.join(path.dirname(workspace), "manifest.json"));
  const parentSession = await json(path.join(path.dirname(workspace), ".yuhi", "session.json"));
  if (parentManifest || parentSession) return recovery("nested-prepared-workspace");

  const manifest = await json(path.join(workspace, "manifest.json"));
  if (manifest === undefined) return recovery("manifest-missing");
  if (
    manifest === null ||
    typeof manifest.runId !== "string" ||
    !Array.isArray(manifest.files)
  ) return recovery("manifest-invalid");
  const acceptance = manifest.tabularAcceptance as Record<string, unknown> | undefined;
  if (!acceptance || acceptance.launchAllowed !== true || acceptance.rawFallbackUsed !== false) {
    return recovery("preparation-incomplete");
  }

  const session = await json(path.join(workspace, ".yuhi", "session.json"));
  if (session === undefined) return recovery("session-missing");
  if (
    session === null ||
    (session.schemaVersion !== 1 && session.schemaVersion !== 2) ||
    session.preparedBy !== "Yuhi" ||
    typeof session.runId !== "string" ||
    session.runId !== manifest.runId
  ) return recovery("session-invalid");
  // `preparationResult` is written by the EXTENSION's prepare flow. A workspace prepared by
  // the CLI (`yuhi prepare`) has never carried it, so requiring it declared every
  // CLI-prepared workspace "incomplete" and blocked the launch. Core records the same fact
  // in its own vocabulary, so accept either. (Found by opening a CLI-prepared workspace in
  // the extension: manifest launchAllowed=true, no error files, and still blocked.)
  const extensionComplete =
    session.preparationResult === "complete" || session.preparationResult === "complete-with-warnings";
  const coreComplete =
    session.preparationResult === undefined &&
    session.launchAllowed === true &&
    (session.status === "Success" || session.status === "Partial");
  if (!extensionComplete && !coreComplete) return recovery("preparation-incomplete");

  const files = manifest.files as Record<string, unknown>[];
  if (files.some((file) => file.status === "error" && file.omitted !== true)) {
    return recovery("preparation-incomplete");
  }
  // NOTE: high-risk findings are NOT a recovery trigger. Recovery only repairs an
  // UNUSABLE Prepared Workspace (missing/invalid manifest or session, copy failure,
  // launchAllowed=false). A high-risk finding is a file-level warning — the intended,
  // successful outcome — and is surfaced in the UI, never "repaired".

  return { kind: "valid", runId: session.runId, workspace };
}

export type CommandOutcome =
  | { kind: "success" }
  | { kind: "cancelled" }
  | { kind: "recovery-required"; reason: RecoveryReason }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; category: string }
  | { kind: "timeout" };

/** A bounded command boundary whose in-flight guard always clears. */
export class RecoverableCommandRunner {
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  async run(
    task: () => Promise<CommandOutcome>,
    timeoutMs = 10 * 60_000,
  ): Promise<CommandOutcome | { kind: "already-running" }> {
    if (this.running) return { kind: "already-running" };
    this.running = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task(),
        new Promise<CommandOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
        }),
      ]);
    } catch {
      return { kind: "failed", category: "unexpected-error" };
    } finally {
      if (timer) clearTimeout(timer);
      this.running = false;
    }
  }
}
