import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { diffPreparedSnapshots } from "./diff.js";
import { buildMaskedPatchDiff, type MaskedPatchDiff } from "./review-diff.js";
import { createPatchManifest, computePreparedSnapshotId } from "./provenance.js";
import { privatePatchRunDir, privatePatchSessionDir } from "./private-state.js";
import { capturePreparedSnapshot } from "./snapshot.js";
import type {
  PatchChange,
  PatchManifest,
  PreparedRepresentation,
  PreparedSnapshot,
} from "./types.js";
import { validatePatchSet, type PatchValidationInput } from "./validator.js";
import { applyTextPatchHunks, buildTextPatchHunks } from "./hunks.js";

interface SourceBaselineFile {
  relpath: string;
  exists: boolean;
  sha256?: string;
  sizeBytes?: number;
  gitDirty?: boolean;
}

const execFileAsync = promisify(execFile);

async function gitDirtyPaths(root: string): Promise<{ paths: Set<string>; verified: boolean }> {
  try {
    const probe = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root, encoding: "utf8", timeout: 500, maxBuffer: 16 * 1024,
    });
    if (probe.stdout.trim() !== "true") return { paths: new Set(), verified: true };
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
      { cwd: root, encoding: "utf8", timeout: 1_500, maxBuffer: 4 * 1024 * 1024 },
    );
    const entries = stdout.split("\0").filter(Boolean);
    const paths = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const status = entry.slice(0, 2);
      const relpath = entry.slice(3).replaceAll("\\", "/");
      if (relpath) paths.add(relpath);
      if ((status.includes("R") || status.includes("C")) && entries[index + 1]) {
        paths.add(entries[++index]!.replaceAll("\\", "/"));
      }
    }
    return { paths, verified: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 128 || code === "128") return { paths: new Set(), verified: true };
    return { paths: new Set(), verified: false };
  }
}

export interface PrivatePatchSessionState {
  schemaVersion: 1;
  sessionId: string;
  runId: string;
  snapshotId: string;
  sourceBaselineId: string;
  preparedRoot: string;
  sourceRoot: string;
  /** Private managed state only; never projected to a public manifest. */
  privateSessionRoot: string;
  managedBase: string;
  agentId?: "claude" | "codex";
  sourceGitStatusVerified: boolean;
  snapshot: PreparedSnapshot;
  sourceFiles: SourceBaselineFile[];
}

export interface CapturePatchSessionInput {
  managedBase: string;
  runId: string;
  sessionId: string;
  contextId: string;
  revisionId: string;
  preparedRoot: string;
  sourceRoot: string;
  agentId?: "claude" | "codex";
  /** Preserve an earlier unreviewed baseline while creating a new session provenance. */
  inheritFromSessionId?: string;
}

export interface PatchReviewResult {
  schemaVersion: 1;
  /** Exact deterministic identity of the Prepared Working Tree reviewed. */
  preparedWorkingTreeId: string;
  snapshotId: string;
  patch: PatchManifest;
  changes: PatchChange[];
  counts: { low: number; review: number; high: number; blocked: number };
  applyAllowed: boolean;
  /** Runtime review metadata only. Never persisted in the Patch Manifest. */
  hunksByRelpath: Record<string, Array<{
    hunkId: string;
    beforeStart: number;
    beforeCount: number;
    afterStart: number;
    afterCount: number;
  }>>;
  /** The only file-content representation permitted in public review surfaces. */
  diffsByRelpath: Record<string, MaskedPatchDiff>;
}

export interface MaterializedPatchSelection {
  preparedRoot: string;
  changes: PatchChange[];
}

function computePreparedWorkingTreeId(changes: readonly PatchChange[]): string {
  const canonical = JSON.stringify(
    [...changes]
      .sort((left, right) => left.relpath.localeCompare(right.relpath, "en"))
      .map((change) => ({
        relpath: change.relpath,
        kind: change.kind,
        afterHash: change.afterHash ?? null,
      })),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

async function readRegularFile(filename: string): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new Error("patch-symlink");
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("patch-unsupported-mode");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Read a regular file through the descriptor that was opened with O_NOFOLLOW.
 * Only a genuinely absent path is optional; unsafe types and replacement races
 * fail closed instead of being normalized to "missing".
 */
async function readOptionalRegularFile(filename: string): Promise<Buffer | undefined> {
  try {
    return await readRegularFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

interface PreparedManifestFile {
  relpath?: unknown;
  originalRelpath?: unknown;
  transformed?: unknown;
  transformations?: unknown;
  contextRepresentation?: unknown;
}

function safeRelpath(value: string): string {
  const slash = value.replaceAll("\\", "/");
  if (
    !slash ||
    slash.includes("\0") ||
    path.posix.isAbsolute(slash) ||
    slash.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("patch-path-escape");
  return slash;
}

function isInternal(relpath: string): boolean {
  return relpath === "manifest.json" ||
    relpath === "CLAUDE.md" || relpath === "AGENTS.md" ||
    relpath === ".git" || relpath.startsWith(".git/") ||
    relpath === ".yuhi" || relpath.startsWith(".yuhi/") ||
    relpath === ".claude" || relpath.startsWith(".claude/") ||
    relpath === ".vscode" || relpath.startsWith(".vscode/");
}

function contained(root: string, relpath: string): string {
  const normalized = safeRelpath(relpath);
  const target = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("patch-path-escape");
  }
  return target;
}

async function hashFile(filename: string): Promise<{ sha256: string; sizeBytes: number } | undefined> {
  const bytes = await readOptionalRegularFile(filename);
  return bytes === undefined
    ? undefined
    : { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.byteLength };
}

async function representationMap(
  preparedRoot: string,
  managedBase?: string,
  runId?: string,
  includePreparedManifest = true,
): Promise<Map<string, PreparedRepresentation>> {
  const result = new Map<string, PreparedRepresentation>();
  if (includePreparedManifest) try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(preparedRoot, "manifest.json"), "utf8"),
    ) as { files?: unknown };
    if (Array.isArray(manifest.files)) {
      for (const raw of manifest.files as PreparedManifestFile[]) {
        if (typeof raw.relpath !== "string") continue;
        const relpath = safeRelpath(raw.relpath);
        const transformations = Array.isArray(raw.transformations) ? raw.transformations : [];
        const representation: PreparedRepresentation =
          raw.contextRepresentation === "compressed"
            ? "compressed"
            : raw.transformed === true || transformations.length > 0
              ? "background-artifact"
              : "full";
        result.set(relpath, representation);
      }
    }
  } catch {
    // Missing/corrupt provenance never upgrades a file. Internal paths remain blocked;
    // unknown project files are treated as agent-created FULL files at review time.
  }
  if (managedBase && runId) {
    try {
      const itemsDir = path.join(managedBase, ".internal", "background", runId, "items");
      for (const entry of await fs.readdir(itemsDir)) {
        if (!entry.endsWith(".json")) continue;
        const record = JSON.parse(await fs.readFile(path.join(itemsDir, entry), "utf8")) as {
          status?: unknown;
          preparedRelpath?: unknown;
        };
        if (record.status === "completed" && typeof record.preparedRelpath === "string") {
          result.set(safeRelpath(record.preparedRelpath), "background-artifact");
        }
      }
    } catch {
      /* no authoritative published background artifacts */
    }
  }
  return result;
}

function sourceBaselineId(files: readonly SourceBaselineFile[]): string {
  const canonical = [...files]
    .sort((a, b) => a.relpath.localeCompare(b.relpath))
    .map((file) => [file.relpath, file.exists, file.sha256 ?? null, file.sizeBytes ?? null, file.gitDirty === true]);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

async function atomicJson(filename: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/** Capture private, pre-agent prepared/source state and baseline bytes for discard. */
export async function capturePatchSession(
  input: CapturePatchSessionInput,
): Promise<PrivatePatchSessionState> {
  const preparedRoot = await fs.realpath(input.preparedRoot);
  const sourceRoot = await fs.realpath(input.sourceRoot);
  const privateDir = privatePatchSessionDir(input.managedBase, input.runId, input.sessionId);
  for (const visible of [preparedRoot, sourceRoot]) {
    const relative = path.relative(visible, privateDir);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error("private-patch-state-visible");
    }
  }
  if (input.inheritFromSessionId) {
    const inherited = await loadPatchSession(input.managedBase, input.runId, input.inheritFromSessionId);
    if (
      inherited.snapshot.contextId !== input.contextId ||
      inherited.snapshot.revisionId !== input.revisionId ||
      inherited.sourceRoot !== sourceRoot ||
      inherited.preparedRoot !== preparedRoot
    ) throw new Error("invalid-inherited-patch-session");
    await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
    await fs.cp(
      path.join(inherited.privateSessionRoot, "prepared-baseline"),
      path.join(privateDir, "prepared-baseline"),
      { recursive: true, errorOnExist: true },
    );
    const state: PrivatePatchSessionState = {
      ...inherited,
      sessionId: input.sessionId,
      privateSessionRoot: privateDir,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    };
    await atomicJson(path.join(privateDir, "snapshot.json"), state);
    await atomicJson(path.join(privatePatchRunDir(input.managedBase, input.runId), "latest-session.json"), {
      schemaVersion: 1,
      sessionId: input.sessionId,
    });
    return state;
  }
  const representations = await representationMap(preparedRoot, input.managedBase, input.runId);
  const representationFor = (relpath: string): PreparedRepresentation =>
    isInternal(relpath) ? "background-artifact" : (representations.get(relpath) ?? "full");
  const snapshot = await capturePreparedSnapshot(preparedRoot, {
    contextId: input.contextId,
    revisionId: input.revisionId,
    createdFromRunId: input.runId,
    representationFor,
  });
  const sourceFiles: SourceBaselineFile[] = [];
  const gitStatus = await gitDirtyPaths(sourceRoot);
  const baselineRoot = path.join(privateDir, "prepared-baseline");
  for (const file of snapshot.files) {
    if (file.representation === "full") {
      const source = await hashFile(contained(sourceRoot, file.relpath));
      sourceFiles.push({
        relpath: file.relpath,
        exists: source !== undefined,
        ...(source ?? {}),
        ...(gitStatus.paths.has(file.relpath) ? { gitDirty: true } : {}),
      });
    }
    if (file.representation !== "background-artifact") {
      const inputFile = contained(preparedRoot, file.relpath);
      const outputFile = contained(baselineRoot, file.relpath);
      // Never copy by pathname after an lstat. Bind the baseline bytes to an
      // O_NOFOLLOW descriptor so a replacement cannot redirect the read.
      const baselineBytes = await readRegularFile(inputFile);
      await fs.mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(outputFile, baselineBytes, { mode: 0o600, flag: "wx" });
    }
  }
  const state: PrivatePatchSessionState = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    runId: input.runId,
    snapshotId: computePreparedSnapshotId(snapshot),
    sourceBaselineId: sourceBaselineId(sourceFiles),
    preparedRoot,
    sourceRoot,
    privateSessionRoot: privateDir,
    managedBase: path.resolve(input.managedBase),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    sourceGitStatusVerified: gitStatus.verified,
    snapshot,
    sourceFiles,
  };
  await atomicJson(path.join(privateDir, "snapshot.json"), state);
  await atomicJson(path.join(privatePatchRunDir(input.managedBase, input.runId), "latest-session.json"), {
    schemaVersion: 1,
    sessionId: input.sessionId,
  });
  return state;
}

export async function loadPatchSession(
  managedBase: string,
  runId: string,
  sessionId?: string,
): Promise<PrivatePatchSessionState> {
  let selected = sessionId;
  if (!selected) {
    const latest = JSON.parse(
      await fs.readFile(path.join(privatePatchRunDir(managedBase, runId), "latest-session.json"), "utf8"),
    ) as { sessionId?: unknown };
    if (typeof latest.sessionId !== "string") throw new Error("patch-session-not-found");
    selected = latest.sessionId;
  }
  const filename = path.join(privatePatchSessionDir(managedBase, runId, selected), "snapshot.json");
  const state = JSON.parse(await fs.readFile(filename, "utf8")) as PrivatePatchSessionState;
  if (state.schemaVersion !== 1 || state.runId !== runId || state.sessionId !== selected) {
    throw new Error("invalid-patch-session");
  }
  state.privateSessionRoot = path.dirname(filename);
  state.managedBase = path.resolve(managedBase);
  if (typeof state.sourceGitStatusVerified !== "boolean") state.sourceGitStatusVerified = false;
  return state;
}

async function validationInput(
  change: PatchChange,
  state: PrivatePatchSessionState,
): Promise<PatchValidationInput> {
  const sourceRelpath = change.previousRelpath ?? change.relpath;
  const baseline = state.sourceFiles.find((file) => file.relpath === sourceRelpath);
  const currentSource = await hashFile(contained(state.sourceRoot, sourceRelpath));
  const destination = await hashFile(contained(state.sourceRoot, change.relpath));
  // Compare proposed bytes with the immutable pre-agent Prepared baseline, not
  // the mutable current Source. Source integrity is checked separately by hashes.
  // This avoids hiding added sensitive content when the Source changes mid-session.
  const beforeContent = change.kind === "added"
    ? undefined
    : await readOptionalRegularFile(contained(
        path.join(state.privateSessionRoot, "prepared-baseline"),
        sourceRelpath,
      ));
  const afterContent = change.kind === "deleted"
    ? undefined
    : change.unsafeType
      ? undefined
      : await readOptionalRegularFile(contained(state.preparedRoot, change.relpath));
  return {
    relpath: change.relpath,
    ...(change.previousRelpath ? { previousRelpath: change.previousRelpath } : {}),
    kind: change.kind,
    representation: change.representation,
    ...(beforeContent ? { beforeContent } : {}),
    ...(afterContent ? { afterContent } : {}),
    ...(baseline?.sha256 ? { baselineSourceHash: baseline.sha256 } : {}),
    ...(currentSource?.sha256 ? { currentSourceHash: currentSource.sha256 } : {}),
    sourceGitDirty: baseline?.gitDirty === true || !state.sourceGitStatusVerified,
    destinationExists: destination !== undefined,
    destinationTrackedByBaseline: state.sourceFiles.some((file) => file.relpath === change.relpath && file.exists),
    isSymlink: change.unsafeType === "symlink",
    symlinkEscapesSourceRoot: change.unsafeType === "symlink",
    isDeviceFile: change.unsafeType === "special",
    executable: ((change.afterMode ?? change.beforeMode ?? 0) & 0o111) !== 0,
  };
}

/** Re-scan current Prepared bytes and produce one public-safe deterministic patch review. */
export async function reviewPatchSession(
  state: PrivatePatchSessionState,
  agent?: { sessionId?: string; id?: "claude" | "codex" },
): Promise<PatchReviewResult> {
  // The agent-visible manifest is not authoritative after launch. Existing files
  // use the immutable private snapshot; only private background records may add a
  // derived representation during the session.
  const representations = await representationMap(
    state.preparedRoot,
    state.managedBase,
    state.runId,
    false,
  );
  const baselineRepresentations = new Map(
    state.snapshot.files.map((file) => [file.relpath, file.representation]),
  );
  const current = await capturePreparedSnapshot(state.preparedRoot, {
    contextId: state.snapshot.contextId,
    revisionId: state.snapshot.revisionId,
    createdFromRunId: state.runId,
    allowPathCollisions: true,
    representationFor: (relpath) =>
      isInternal(relpath)
        ? "background-artifact"
        : baselineRepresentations.get(relpath) ?? representations.get(relpath) ?? "full",
  });
  const detected = diffPreparedSnapshots(state.snapshot, current).filter((change) =>
    !(
      change.representation === "background-artifact" &&
      !baselineRepresentations.has(change.relpath) &&
      representations.get(change.relpath) === "background-artifact"
    ),
  );
  const validationInputs = await Promise.all(detected.map((change) => validationInput(change, state)));
  const validation = validatePatchSet(validationInputs);
  const changes = detected.map((change, index) => {
    const result = validation.changes[index]!;
    return {
      ...change,
      risk: result.risk,
      applyEligibility: result.applyEligibility,
      sourceChanged: result.reasonCodes.includes("patch-source-changed"),
      reasonCodes: [...new Set([...change.reasonCodes, ...result.reasonCodes])],
    } satisfies PatchChange;
  });
  const patch = createPatchManifest({
    contextId: state.snapshot.contextId,
    revisionId: state.snapshot.revisionId,
    sourceBaselineId: state.sourceBaselineId,
    changes,
    agentSessionId: agent?.sessionId ?? state.sessionId,
    ...(agent?.id ?? state.agentId ? { agentId: agent?.id ?? state.agentId } : {}),
  });
  const counts = { low: 0, review: 0, high: 0, blocked: 0 };
  for (const change of changes) counts[change.risk ?? "blocked"] += 1;
  const hunksByRelpath: PatchReviewResult["hunksByRelpath"] = {};
  const diffsByRelpath: PatchReviewResult["diffsByRelpath"] = {};
  for (const change of changes) {
    if (change.kind === "deleted" || change.kind === "binary") continue;
    const input = await validationInput(change, state);
    diffsByRelpath[change.relpath] = buildMaskedPatchDiff(
      change.relpath,
      input.beforeContent,
      input.afterContent,
    );
    // Blocked or sensitive changes may expose only their already-masked diff.
    // They never receive selectable hunks and cannot cross the Apply boundary.
    if (
      change.applyEligibility === "blocked" ||
      change.reasonCodes.includes("patch-pii-added")
    ) continue;
    if (!input.afterContent) continue;
    hunksByRelpath[change.relpath] = buildTextPatchHunks(
      input.beforeContent ?? "",
      input.afterContent,
    ).map(({ replacementLines: _replacementLines, ...metadata }) => metadata);
  }
  return {
    schemaVersion: 1,
    // Identity of exactly the agent-authored working set reviewed. Unrelated
    // background context publication must not invalidate an Apply review.
    preparedWorkingTreeId: computePreparedWorkingTreeId(changes),
    snapshotId: state.snapshotId,
    patch,
    changes,
    counts,
    applyAllowed: changes.length > 0 && validation.valid,
    hunksByRelpath,
    diffsByRelpath,
  };
}

/** Build a private, revalidated Prepared root for a file/hunk selection. */
export async function materializePatchSelection(
  state: PrivatePatchSessionState,
  review: PatchReviewResult,
  selectedRelpaths: readonly string[],
  hunkSelections: Readonly<Record<string, readonly string[]>> = {},
): Promise<MaterializedPatchSelection> {
  // Review identities are a concurrency boundary, not display metadata. A
  // selection is valid only for the exact private baseline and Prepared tree
  // that produced it; re-review after any agent/background mutation.
  if (
    review.snapshotId !== state.snapshotId ||
    review.patch.sourceBaselineId !== state.sourceBaselineId ||
    review.patch.contextId !== state.snapshot.contextId ||
    review.patch.revisionId !== state.snapshot.revisionId
  ) throw new Error("patch-review-stale");
  const currentReview = await reviewPatchSession(state);
  if (
    currentReview.preparedWorkingTreeId !== review.preparedWorkingTreeId ||
    currentReview.patch.patchId !== review.patch.patchId
  ) throw new Error("patch-review-stale");
  const selected = new Set(selectedRelpaths);
  // Keep ephemeral candidate bytes outside both the agent-visible Prepared root
  // and the atomic Apply history root. The low-level writer deliberately rejects
  // any private history root that contains its input tree.
  const overlay = path.join(
    state.managedBase,
    ".internal-apply-candidates",
    state.runId,
    state.sessionId,
    randomUUID(),
  );
  await fs.mkdir(overlay, { recursive: true, mode: 0o700 });
  const materialized: PatchChange[] = [];
  try {
    for (const change of review.changes) {
      if (!selected.has(change.relpath) || change.applyEligibility === "blocked") continue;
      if (change.kind === "deleted") {
        materialized.push(change);
        continue;
      }
      const currentBytes = await readRegularFile(contained(state.preparedRoot, change.relpath));
      let candidate = currentBytes;
      const selectedHunks = hunkSelections[change.relpath];
      if (selectedHunks) {
        const sourceRelpath = change.previousRelpath ?? change.relpath;
        const before = change.kind === "added"
          ? Buffer.alloc(0)
          : await readRegularFile(contained(path.join(state.privateSessionRoot, "prepared-baseline"), sourceRelpath));
        const hunks = buildTextPatchHunks(before, currentBytes);
        const known = new Set(hunks.map((hunk) => hunk.hunkId));
        if (selectedHunks.some((id) => !known.has(id))) throw new Error("patch-hunk-stale");
        candidate = applyTextPatchHunks(before, hunks, selectedHunks);
      }
      const afterHash = createHash("sha256").update(candidate).digest("hex");
      if (afterHash === change.beforeHash) continue;
      const next: PatchChange = {
        ...change,
        afterHash,
        afterSizeBytes: candidate.byteLength,
      };
      const input = await validationInput(next, state);
      const validation = validatePatchSet([{ ...input, afterContent: candidate }]).changes[0]!;
      if (validation.applyEligibility === "blocked") throw new Error("patch-selection-blocked");
      next.risk = validation.risk;
      next.applyEligibility = validation.applyEligibility;
      next.reasonCodes = [...new Set([...next.reasonCodes, ...validation.reasonCodes])];
      const output = contained(overlay, next.relpath);
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await fs.writeFile(output, candidate, { mode: next.afterMode ?? 0o600 });
      materialized.push(next);
    }
    if (materialized.length === 0) throw new Error("patch-selection-empty");
    return { preparedRoot: overlay, changes: materialized };
  } catch (error) {
    await fs.rm(overlay, { recursive: true, force: true });
    throw error;
  }
}
