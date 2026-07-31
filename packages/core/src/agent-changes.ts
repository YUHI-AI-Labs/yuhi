import * as path from "node:path";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir, platform } from "node:os";
import { promisify } from "node:util";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { runDetectors } from "@yuhi/scanner";

export type AgentChangeKind = "modified" | "created" | "deleted" | "renamed";
export type AgentChangeEligibility = "safe-to-apply" | "review-required" | "cannot-apply";

interface FileIdentity {
  type: "file";
  digest: string;
  size: number;
  device: number;
  inode: number;
}

export interface AgentFileSnapshot extends FileIdentity {
  relpath: string;
  provenanceEligible: boolean;
  provenanceReason: string;
  original?: FileIdentity;
}

export interface AgentChangeBaseline {
  schemaVersion: 2;
  runId: string;
  files: AgentFileSnapshot[];
  internalMetadata: { relpath: string; digest: string }[];
  ineligibleManifestRelpaths: string[];
  gitDirtyRelpaths: string[];
}

export interface AgentChange {
  kind: AgentChangeKind;
  relpath: string;
  previousRelpath?: string;
  eligibility: AgentChangeEligibility;
  eligibilityReason: string;
}

export interface AgentSecurityResult {
  safe: boolean;
  findingCounts: Record<string, number>;
  highRiskFindingCount: number;
  uninspectableFileCount: number;
}

export type AgentChangeBlocker =
  | "sensitive-output"
  | "uninspectable-output"
  | "ineligible-provenance"
  | "original-conflict"
  | "original-git-dirty"
  | "unsafe-path"
  | "internal-metadata-change";

export interface AgentChangeReview {
  schemaVersion: 2;
  runId: string;
  changes: AgentChange[];
  security: AgentSecurityResult;
  applyAllowed: boolean;
  blockers: AgentChangeBlocker[];
}

export interface AgentApplyAudit {
  schemaVersion: 1;
  runId: string;
  timestamp: string;
  changedFileCount: number;
  securityResult: "passed" | "blocked";
  applyResult: "applied" | "blocked" | "cancelled" | "failed-restored" | "recovery-required";
}

export interface ApplyAgentChangesOptions {
  /** Test/embedding seam. Throwing simulates a failure immediately before a mutation. */
  beforeMutation?: (change: AgentChange, index: number) => void | Promise<void>;
  /** Test/embedding seam. Throwing simulates a failure immediately after a mutation. */
  afterMutation?: (change: AgentChange, index: number) => void | Promise<void>;
  /** Test/embedding seam. Throwing simulates final verification failure. */
  beforeFinalVerification?: () => void | Promise<void>;
  /** Yuhi-owned recovery storage outside both workspaces. */
  recoveryBase?: string;
}

const INTERNAL_PATHS = new Set(["manifest.json"]);
const INTERNAL_PREFIXES = [".yuhi/", ".claude/", ".vscode/"];
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".html",
  ".ini", ".java", ".js", ".json", ".jsx", ".md", ".mjs", ".py", ".rb", ".rs",
  ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
  ".env",
]);
const GENERATED_PERSONAL_DATA = [
  { category: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { category: "phone", pattern: /(?:\+\d{1,3}[- ]?)?(?:\(\d{2,4}\)[- ]?)?\d{2,4}[- ]\d{2,4}[- ]\d{3,4}/g },
] as const;
const SECRET_ASSIGNMENT =
  /^\s*(?:export\s+)?(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|credential)\s*[:=]\s*\S+/gim;
const execFileAsync = promisify(execFile);

function recoveryBaseDir(): string {
  if (process.env.YUHI_HOME) return path.join(process.env.YUHI_HOME, "apply-recovery");
  if (platform() === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Yuhi", "apply-recovery");
  }
  if (platform() === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
      "Yuhi",
      "apply-recovery",
    );
  }
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state"),
    "yuhi",
    "apply-recovery",
  );
}

function normalizeRelpath(value: string): string {
  if (value.includes("\0") || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error("unsafe-path");
  }
  const slash = value.replaceAll("\\", "/");
  if (slash.split("/").some((part) => part === "..")) throw new Error("unsafe-path");
  const relpath = path.posix.normalize(slash).replace(/^\.\/+/, "");
  if (!relpath || relpath === "." || relpath.startsWith("../") || path.posix.isAbsolute(relpath)) {
    throw new Error("unsafe-path");
  }
  return relpath;
}

function isInternal(relpath: string): boolean {
  return INTERNAL_PATHS.has(relpath) ||
    INTERNAL_PREFIXES.some((prefix) => relpath === prefix.slice(0, -1) || relpath.startsWith(prefix));
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalRoot(root: string): Promise<string> {
  const resolved = await import("node:fs/promises").then(({ realpath }) => realpath(root));
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe-path");
  return resolved;
}

/**
 * Resolve a relative path without following any symlink/reparse-point component.
 * A missing leaf is allowed only for create/rename destinations.
 */
async function resolveContained(
  rootReal: string,
  relpathInput: string,
  allowMissingLeaf: boolean,
): Promise<{ absolute: string; exists: boolean }> {
  const relpath = normalizeRelpath(relpathInput);
  if (isInternal(relpath)) throw new Error("internal-metadata-change");
  const parts = relpath.split("/");
  let current = rootReal;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    if (!contained(rootReal, current)) throw new Error("unsafe-path");
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("unsafe-path");
      if (index < parts.length - 1 && !info.isDirectory()) throw new Error("unsafe-path");
      if (index === parts.length - 1 && !info.isFile()) throw new Error("unsafe-path");
    } catch (error) {
      if (error instanceof Error && (
        error.message === "unsafe-path" || error.message === "internal-metadata-change"
      )) throw error;
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        index !== parts.length - 1 ||
        !allowMissingLeaf
      ) throw new Error("unsafe-path");
      return { absolute: current, exists: false };
    }
  }
  return { absolute: current, exists: true };
}

async function ensureContainedParent(rootReal: string, relpathInput: string): Promise<string> {
  const relpath = normalizeRelpath(relpathInput);
  if (isInternal(relpath)) throw new Error("internal-metadata-change");
  const parts = relpath.split("/");
  let current = rootReal;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (!contained(rootReal, current)) throw new Error("unsafe-path");
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe-path");
    } catch (error) {
      if (error instanceof Error && error.message === "unsafe-path") throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("unsafe-path");
      await mkdir(current, { mode: 0o700 });
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("unsafe-path");
    }
  }
  return path.join(rootReal, ...parts);
}

async function identity(filename: string): Promise<FileIdentity> {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("unsafe-path");
    const bytes = await handle.readFile();
    return {
      type: "file",
      digest: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      device: info.dev,
      inode: info.ino,
    };
  } finally {
    await handle.close();
  }
}

async function exactBytes(filename: string): Promise<{ bytes: Buffer; identity: FileIdentity }> {
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("unsafe-path");
    const bytes = await handle.readFile();
    return {
      bytes,
      identity: {
        type: "file",
        digest: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        device: info.dev,
        inode: info.ino,
      },
    };
  } finally {
    await handle.close();
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.type === right.type &&
    left.digest === right.digest &&
    left.size === right.size &&
    left.device === right.device &&
    left.inode === right.inode;
}

interface WalkResult {
  files: string[];
  unsafePaths: string[];
  internalChanges: string[];
}

async function walkFiles(rootReal: string, current = rootReal): Promise<WalkResult> {
  const output: WalkResult = { files: [], unsafePaths: [], internalChanges: [] };
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    const relpath = normalizeRelpath(path.relative(rootReal, absolute).split(path.sep).join("/"));
    const info = await lstat(absolute);
    if (isInternal(relpath)) {
      if (info.isSymbolicLink()) output.internalChanges.push(relpath);
      continue;
    }
    if (info.isSymbolicLink()) {
      output.unsafePaths.push(relpath);
    } else if (info.isDirectory()) {
      const nested = await walkFiles(rootReal, absolute);
      output.files.push(...nested.files);
      output.unsafePaths.push(...nested.unsafePaths);
      output.internalChanges.push(...nested.internalChanges);
    } else if (info.isFile()) {
      output.files.push(relpath);
    } else {
      output.unsafePaths.push(relpath);
    }
  }
  return output;
}

async function walkInternalMetadata(rootReal: string): Promise<{ relpath: string; digest: string }[]> {
  const output: { relpath: string; digest: string }[] = [];
  const visit = async (absolute: string): Promise<void> => {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error("internal-metadata-change");
    if (info.isDirectory()) {
      for (const entry of await readdir(absolute)) await visit(path.join(absolute, entry));
    } else if (info.isFile()) {
      const relpath = normalizeRelpath(path.relative(rootReal, absolute).split(path.sep).join("/"));
      output.push({ relpath, digest: (await identity(absolute)).digest });
    }
  };
  for (const relpath of ["manifest.json", ".yuhi", ".claude", ".vscode"]) {
    const absolute = path.join(rootReal, relpath);
    try {
      await visit(absolute);
    } catch (error) {
      if (error instanceof Error && error.message === "internal-metadata-change") throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return output.sort((a, b) => a.relpath.localeCompare(b.relpath));
}

interface ManifestFile {
  relpath?: unknown;
  action?: unknown;
  status?: unknown;
  outcome?: unknown;
  omitted?: unknown;
  transformed?: unknown;
  transformations?: unknown;
}

interface ProvenanceDecision {
  eligible: boolean;
  reason: string;
}

function provenanceDecision(file: ManifestFile | undefined): ProvenanceDecision {
  if (!file) return { eligible: true, reason: "agent-created-file" };
  const transformations = Array.isArray(file.transformations) ? file.transformations : [];
  const eligible =
    file.status === "ok" &&
    file.omitted !== true &&
    file.action === "allow" &&
    file.outcome === "included-unchanged" &&
    file.transformed !== true &&
    transformations.length === 0;
  return eligible
    ? { eligible: true, reason: "manifest-included-unchanged" }
    : {
        eligible: false,
        reason: transformations.includes("pseudonymized")
          ? "pseudonymized-by-yuhi-no-reversible-mapping"
          : transformations.includes("masked")
            ? "masked-by-yuhi"
            : transformations.includes("summarized")
              ? "summarized-by-yuhi"
              : transformations.includes("aggregated")
                ? "aggregated-by-yuhi"
                : file.omitted === true
                  ? "withheld-by-yuhi"
                  : "generated-or-transformed-by-safety-processor",
      };
}

async function readManifestProvenance(preparedRoot: string): Promise<Map<string, ManifestFile>> {
  const raw = JSON.parse(await readFile(path.join(preparedRoot, "manifest.json"), "utf8")) as {
    schemaVersion?: unknown;
    files?: unknown;
  };
  if ((raw.schemaVersion !== 1 && raw.schemaVersion !== 2) || !Array.isArray(raw.files)) {
    throw new Error("invalid-manifest");
  }
  const result = new Map<string, ManifestFile>();
  for (const value of raw.files as ManifestFile[]) {
    if (typeof value.relpath !== "string") throw new Error("invalid-manifest");
    const relpath = normalizeRelpath(value.relpath);
    if (isInternal(relpath) || result.has(relpath)) throw new Error("invalid-manifest");
    result.set(relpath, value);
  }
  return result;
}

async function gitDirtyRelpaths(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { timeout: 5_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
    );
    const fields = stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index]!;
      if (field.length < 4) continue;
      paths.push(normalizeRelpath(field.slice(3)));
      if (field[0] === "R" || field[1] === "R" || field[0] === "C" || field[1] === "C") {
        const destination = fields[++index];
        if (destination) paths.push(normalizeRelpath(destination));
      }
    }
    return [...new Set(paths)].sort();
  } catch {
    return [];
  }
}

/** Capture metadata-only state immediately before an agent starts. */
export async function captureAgentChangeBaseline(
  runId: string,
  preparedRoot: string,
  originalRoot: string,
): Promise<AgentChangeBaseline> {
  const preparedReal = await canonicalRoot(preparedRoot);
  const originalReal = await canonicalRoot(originalRoot);
  const provenance = await readManifestProvenance(preparedReal);
  const walked = await walkFiles(preparedReal);
  if (walked.unsafePaths.length > 0) throw new Error("unsafe-path");
  const files: AgentFileSnapshot[] = [];
  for (const relpath of walked.files) {
    const preparedPath = await resolveContained(preparedReal, relpath, false);
    const prepared = await identity(preparedPath.absolute);
    const decision = provenanceDecision(provenance.get(relpath));
    let original: FileIdentity | undefined;
    try {
      const originalPath = await resolveContained(originalReal, relpath, false);
      original = await identity(originalPath.absolute);
    } catch {
      // Prepared-only files have no original identity.
    }
    files.push({
      relpath,
      ...prepared,
      provenanceEligible: decision.eligible,
      provenanceReason: decision.reason,
      ...(original ? { original } : {}),
    });
  }
  const ineligibleManifestRelpaths = [...provenance]
    .filter(([, file]) => !provenanceDecision(file).eligible)
    .map(([relpath]) => relpath)
    .sort();
  return {
    schemaVersion: 2,
    runId,
    files,
    internalMetadata: await walkInternalMetadata(preparedReal),
    ineligibleManifestRelpaths,
    gitDirtyRelpaths: await gitDirtyRelpaths(originalReal),
  };
}

function blockedReview(
  baseline: AgentChangeBaseline,
  blocker: AgentChangeBlocker,
): AgentChangeReview {
  return {
    schemaVersion: 2,
    runId: baseline.runId,
    changes: [],
    security: {
      safe: false,
      findingCounts: {},
      highRiskFindingCount: 0,
      uninspectableFileCount: blocker === "unsafe-path" ? 1 : 0,
    },
    applyAllowed: false,
    blockers: [blocker],
  };
}

function validateBaseline(baseline: AgentChangeBaseline): void {
  if (
    baseline.schemaVersion !== 2 ||
    typeof baseline.runId !== "string" ||
    !Array.isArray(baseline.files) ||
    !Array.isArray(baseline.internalMetadata) ||
    !Array.isArray(baseline.ineligibleManifestRelpaths) ||
    !Array.isArray(baseline.gitDirtyRelpaths)
  ) throw new Error("invalid-baseline");
  const seen = new Set<string>();
  for (const file of baseline.files) {
    const relpath = normalizeRelpath(file.relpath);
    if (isInternal(relpath) || seen.has(relpath)) throw new Error("invalid-baseline");
    seen.add(relpath);
  }
  for (const relpath of baseline.ineligibleManifestRelpaths) normalizeRelpath(relpath);
  for (const file of baseline.internalMetadata) {
    const relpath = normalizeRelpath(file.relpath);
    if (!isInternal(relpath) || typeof file.digest !== "string") throw new Error("invalid-baseline");
  }
}

export async function reviewAgentChanges(
  baseline: AgentChangeBaseline,
  preparedRoot: string,
  originalRoot: string,
): Promise<AgentChangeReview> {
  try {
    validateBaseline(baseline);
  } catch {
    return blockedReview(baseline, "unsafe-path");
  }
  const preparedReal = await canonicalRoot(preparedRoot);
  const originalReal = await canonicalRoot(originalRoot);
  const before = new Map(baseline.files.map((file) => [file.relpath, file]));
  const after = new Map<string, FileIdentity>();
  const walked = await walkFiles(preparedReal);
  if (walked.unsafePaths.length > 0) return blockedReview(baseline, "unsafe-path");
  if (walked.internalChanges.length > 0) return blockedReview(baseline, "internal-metadata-change");
  try {
    const currentMetadata = await walkInternalMetadata(preparedReal);
    if (JSON.stringify(currentMetadata) !== JSON.stringify(baseline.internalMetadata)) {
      return blockedReview(baseline, "internal-metadata-change");
    }
  } catch {
    return blockedReview(baseline, "internal-metadata-change");
  }
  for (const relpath of walked.files) {
    const resolved = await resolveContained(preparedReal, relpath, false);
    after.set(relpath, await identity(resolved.absolute));
  }

  const deleted = [...before.values()].filter((file) => !after.has(file.relpath));
  const created = [...after].filter(([relpath]) => !before.has(relpath));
  const deletedByDigest = new Map<string, AgentFileSnapshot[]>();
  const createdByDigest = new Map<string, [string, FileIdentity][]>();
  for (const file of deleted) {
    const list = deletedByDigest.get(file.digest) ?? [];
    list.push(file);
    deletedByDigest.set(file.digest, list);
  }
  for (const item of created) {
    const list = createdByDigest.get(item[1].digest) ?? [];
    list.push(item);
    createdByDigest.set(item[1].digest, list);
  }
  const renamedCreated = new Set<string>();
  const renamedDeleted = new Set<string>();
  const changes: AgentChange[] = [];
  for (const [digest, oldFiles] of deletedByDigest) {
    const newFiles = createdByDigest.get(digest) ?? [];
    // Rename inference is valid only for an unambiguous one-to-one digest match.
    if (oldFiles.length !== 1 || newFiles.length !== 1) continue;
    const oldFile = oldFiles[0]!;
    const [relpath] = newFiles[0]!;
    renamedCreated.add(relpath);
    renamedDeleted.add(oldFile.relpath);
    changes.push({
      kind: "renamed",
      relpath,
      previousRelpath: oldFile.relpath,
      eligibility: oldFile.provenanceEligible ? "safe-to-apply" : "cannot-apply",
      eligibilityReason: oldFile.provenanceReason,
    });
  }
  const ineligibleManifest = new Set(baseline.ineligibleManifestRelpaths);
  for (const [relpath, file] of after) {
    const oldFile = before.get(relpath);
    if (oldFile && oldFile.digest !== file.digest) {
      changes.push({
        kind: "modified",
        relpath,
        eligibility: oldFile.provenanceEligible ? "safe-to-apply" : "cannot-apply",
        eligibilityReason: oldFile.provenanceReason,
      });
    } else if (!oldFile && !renamedCreated.has(relpath)) {
      const forbidden = ineligibleManifest.has(relpath);
      changes.push({
        kind: "created",
        relpath,
        eligibility: forbidden ? "cannot-apply" : "safe-to-apply",
        eligibilityReason: forbidden ? "manifest-transformed-or-withheld" : "agent-created-file",
      });
    }
  }
  for (const oldFile of deleted) {
    if (!renamedDeleted.has(oldFile.relpath)) {
      changes.push({
        kind: "deleted",
        relpath: oldFile.relpath,
        eligibility: oldFile.provenanceEligible ? "safe-to-apply" : "cannot-apply",
        eligibilityReason: oldFile.provenanceReason,
      });
    }
  }
  changes.sort((a, b) => a.relpath.localeCompare(b.relpath));

  const findingCounts: Record<string, number> = {};
  let highRiskFindingCount = 0;
  let uninspectableFileCount = 0;
  for (const change of changes) {
    if (change.kind === "deleted") continue;
    const extension = path.extname(change.relpath).toLowerCase();
    const basename = path.posix.basename(change.relpath).toLowerCase();
    const inspectableText =
      TEXT_EXTENSIONS.has(extension) ||
      basename === ".env" ||
      basename.startsWith(".env.");
    if (!inspectableText) {
      uninspectableFileCount += 1;
      change.eligibility = "cannot-apply";
      change.eligibilityReason = "unsupported-or-unverified-output";
      continue;
    }
    const source = await resolveContained(preparedReal, change.relpath, false);
    const { bytes } = await exactBytes(source.absolute);
    const content = bytes.toString("utf8");
    const findings = runDetectors(content, {
      entropyThreshold: 4.3,
      keywords: [],
      relpath: change.relpath,
    });
    for (const finding of findings) {
      findingCounts[finding.detector] = (findingCounts[finding.detector] ?? 0) + 1;
      if (finding.severity === "high" || finding.severity === "critical") {
        highRiskFindingCount += 1;
      }
    }
    for (const detector of GENERATED_PERSONAL_DATA) {
      const matches = content.match(detector.pattern)?.length ?? 0;
      if (matches > 0) {
        findingCounts[detector.category] = (findingCounts[detector.category] ?? 0) + matches;
        highRiskFindingCount += matches;
      }
    }
    const secretAssignments = content.match(SECRET_ASSIGNMENT)?.length ?? 0;
    if (secretAssignments > 0) {
      findingCounts["credential-assignment"] =
        (findingCounts["credential-assignment"] ?? 0) + secretAssignments;
      highRiskFindingCount += secretAssignments;
    }
  }

  let originalConflict = false;
  for (const change of changes) {
    const sourceRelpath = change.previousRelpath ?? change.relpath;
    const oldFile = before.get(sourceRelpath);
    if (oldFile?.original) {
      try {
        const currentPath = await resolveContained(originalReal, sourceRelpath, false);
        const current = await identity(currentPath.absolute);
        if (!sameIdentity(current, oldFile.original)) originalConflict = true;
      } catch {
        originalConflict = true;
      }
    } else if (change.kind === "created") {
      try {
        const target = await resolveContained(originalReal, change.relpath, true);
        if (target.exists) originalConflict = true;
      } catch {
        originalConflict = true;
      }
    }
    if (change.kind === "renamed" && change.relpath !== sourceRelpath) {
      try {
        const target = await resolveContained(originalReal, change.relpath, true);
        if (target.exists) originalConflict = true;
      } catch {
        originalConflict = true;
      }
    }
  }

  const blockers: AgentChangeBlocker[] = [];
  if (highRiskFindingCount > 0) blockers.push("sensitive-output");
  if (uninspectableFileCount > 0) blockers.push("uninspectable-output");
  if (changes.some((change) => change.eligibility === "cannot-apply")) {
    blockers.push("ineligible-provenance");
  }
  if (originalConflict) blockers.push("original-conflict");
  const dirty = new Set(baseline.gitDirtyRelpaths);
  if (changes.some((change) => dirty.has(change.relpath) || (
    change.previousRelpath !== undefined && dirty.has(change.previousRelpath)
  ))) blockers.push("original-git-dirty");
  return {
    schemaVersion: 2,
    runId: baseline.runId,
    changes,
    security: {
      safe: highRiskFindingCount === 0 && uninspectableFileCount === 0,
      findingCounts,
      highRiskFindingCount,
      uninspectableFileCount,
    },
    applyAllowed: blockers.length === 0,
    blockers,
  };
}

interface JournalEntry {
  change: AgentChange;
  sourceExisted: boolean;
  destinationExisted: boolean;
}

async function backupIfExists(
  originalReal: string,
  relpath: string,
  journalRoot: string,
  label: string,
): Promise<boolean> {
  const resolved = await resolveContained(originalReal, relpath, true);
  if (!resolved.exists) return false;
  const target = path.join(journalRoot, label);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(resolved.absolute, target);
  return true;
}

async function verifyOriginalPrecondition(
  baseline: AgentChangeBaseline,
  change: AgentChange,
  originalReal: string,
): Promise<void> {
  const before = new Map(baseline.files.map((file) => [file.relpath, file]));
  const sourceRelpath = change.previousRelpath ?? change.relpath;
  const oldFile = before.get(sourceRelpath);
  if (oldFile?.original) {
    const resolved = await resolveContained(originalReal, sourceRelpath, false);
    const current = await identity(resolved.absolute);
    if (!sameIdentity(current, oldFile.original)) {
      throw new Error("original-conflict");
    }
  } else if (change.kind === "created") {
    if ((await resolveContained(originalReal, change.relpath, true)).exists) {
      throw new Error("original-conflict");
    }
  }
  if (change.kind === "renamed") {
    if ((await resolveContained(originalReal, change.relpath, true)).exists) {
      throw new Error("original-conflict");
    }
  }
}

async function atomicWrite(
  originalReal: string,
  relpath: string,
  bytes: Buffer,
): Promise<void> {
  const target = await ensureContainedParent(originalReal, relpath);
  const parentReal = await canonicalRoot(path.dirname(target));
  if (!contained(originalReal, parentReal)) throw new Error("unsafe-path");
  const temp = path.join(parentReal, `.yuhi-apply-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
    const tempInfo = await lstat(temp);
    if (!tempInfo.isFile() || tempInfo.isSymbolicLink()) throw new Error("unsafe-path");
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

async function restoreJournal(
  originalReal: string,
  journalRoot: string,
  entries: JournalEntry[],
): Promise<boolean> {
  try {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      const sourceRelpath = entry.change.previousRelpath ?? entry.change.relpath;
      const destinationRelpath = entry.change.relpath;
      if (entry.change.kind !== "deleted") {
        const destination = await resolveContained(originalReal, destinationRelpath, true);
        if (destination.exists) await rm(destination.absolute);
        if (!entry.destinationExisted) {
          let parent = path.dirname(destination.absolute);
          while (parent !== originalReal && contained(originalReal, parent)) {
            if ((await readdir(parent)).length > 0) break;
            await rm(parent);
            parent = path.dirname(parent);
          }
        }
      }
      if (entry.sourceExisted) {
        const backup = path.join(journalRoot, `${index}-source`);
        await atomicWrite(originalReal, sourceRelpath, (await exactBytes(backup)).bytes);
      }
      if (entry.destinationExisted && destinationRelpath !== sourceRelpath) {
        const backup = path.join(journalRoot, `${index}-destination`);
        await atomicWrite(originalReal, destinationRelpath, (await exactBytes(backup)).bytes);
      }
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const sourceRelpath = entry.change.previousRelpath ?? entry.change.relpath;
      const destinationRelpath = entry.change.relpath;
      const source = await resolveContained(originalReal, sourceRelpath, true);
      if (entry.sourceExisted) {
        if (!source.exists) return false;
        const backup = await identity(path.join(journalRoot, `${index}-source`));
        if ((await identity(source.absolute)).digest !== backup.digest) return false;
      } else if (source.exists) {
        return false;
      }
      if (destinationRelpath !== sourceRelpath) {
        const destination = await resolveContained(originalReal, destinationRelpath, true);
        if (entry.destinationExisted) {
          if (!destination.exists) return false;
          const backup = await identity(path.join(journalRoot, `${index}-destination`));
          if ((await identity(destination.absolute)).digest !== backup.digest) return false;
        } else if (destination.exists) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function verifyApplied(
  review: AgentChangeReview,
  preparedReal: string,
  originalReal: string,
): Promise<void> {
  for (const change of review.changes) {
    const sourceRelpath = change.previousRelpath ?? change.relpath;
    if (change.kind === "deleted") {
      if ((await resolveContained(originalReal, sourceRelpath, true)).exists) {
        throw new Error("final-verification-failed");
      }
      continue;
    }
    const prepared = await resolveContained(preparedReal, change.relpath, false);
    const applied = await resolveContained(originalReal, change.relpath, false);
    if ((await identity(prepared.absolute)).digest !== (await identity(applied.absolute)).digest) {
      throw new Error("final-verification-failed");
    }
    if (change.kind === "renamed" &&
      (await resolveContained(originalReal, sourceRelpath, true)).exists) {
      throw new Error("final-verification-failed");
    }
  }
}

/**
 * Apply an all-safe reviewed set transactionally. Every path is canonicalized
 * immediately before mutation, and the complete result is verified before a
 * success audit can be returned.
 */
export async function applyAgentChanges(
  baseline: AgentChangeBaseline,
  preparedRoot: string,
  originalRoot: string,
  options: ApplyAgentChangesOptions = {},
): Promise<{ review: AgentChangeReview; audit: AgentApplyAudit; recoveryPath?: string }> {
  const review = await reviewAgentChanges(baseline, preparedRoot, originalRoot);
  const timestamp = new Date().toISOString();
  const audit = (applyResult: AgentApplyAudit["applyResult"]): AgentApplyAudit => ({
    schemaVersion: 1,
    runId: baseline.runId,
    timestamp,
    changedFileCount: review.changes.length,
    securityResult: review.security.safe ? "passed" : "blocked",
    applyResult,
  });
  if (!review.applyAllowed) return { review, audit: audit("blocked") };

  const preparedReal = await canonicalRoot(preparedRoot);
  const originalReal = await canonicalRoot(originalRoot);
  const journalRoot = path.join(options.recoveryBase ?? recoveryBaseDir(), baseline.runId, randomUUID());
  await mkdir(journalRoot, { recursive: true, mode: 0o700 });
  const journal: JournalEntry[] = [];
  const reviewedIdentities = new Map<string, FileIdentity>();
  try {
    for (const change of review.changes) {
      if (change.kind === "deleted") continue;
      const prepared = await resolveContained(preparedReal, change.relpath, false);
      reviewedIdentities.set(change.relpath, await identity(prepared.absolute));
    }
    // Back up every affected original before the first mutation.
    for (let index = 0; index < review.changes.length; index += 1) {
      const change = review.changes[index]!;
      await verifyOriginalPrecondition(baseline, change, originalReal);
      const sourceRelpath = change.previousRelpath ?? change.relpath;
      const sourceExisted = await backupIfExists(
        originalReal, sourceRelpath, journalRoot, `${index}-source`,
      );
      const destinationExisted = change.relpath !== sourceRelpath
        ? await backupIfExists(originalReal, change.relpath, journalRoot, `${index}-destination`)
        : sourceExisted;
      journal.push({ change, sourceExisted, destinationExisted });
    }

    for (let index = 0; index < review.changes.length; index += 1) {
      const change = review.changes[index]!;
      await options.beforeMutation?.(change, index);
      // TOCTOU check repeated immediately before this mutation.
      await verifyOriginalPrecondition(baseline, change, originalReal);
      const sourceRelpath = change.previousRelpath ?? change.relpath;
      if (change.kind === "deleted") {
        const source = await resolveContained(originalReal, sourceRelpath, false);
        await rm(source.absolute);
        await options.afterMutation?.(change, index);
        continue;
      }
      const prepared = await resolveContained(preparedReal, change.relpath, false);
      const candidate = await exactBytes(prepared.absolute);
      // Ensure the bytes being applied are exactly the bytes reviewed.
      const reviewedIdentity = reviewedIdentities.get(change.relpath);
      if (!reviewedIdentity || !sameIdentity(candidate.identity, reviewedIdentity)) {
        throw new Error("review-stale");
      }
      await atomicWrite(originalReal, change.relpath, candidate.bytes);
      if (change.kind === "renamed") {
        const old = await resolveContained(originalReal, sourceRelpath, false);
        await rm(old.absolute);
      }
      await options.afterMutation?.(change, index);
    }
    await options.beforeFinalVerification?.();
    await verifyApplied(review, preparedReal, originalReal);
    await rm(journalRoot, { recursive: true, force: true });
    return { review, audit: audit("applied") };
  } catch {
    const restored = await restoreJournal(originalReal, journalRoot, journal);
    if (restored) {
      await rm(journalRoot, { recursive: true, force: true });
      return { review, audit: audit("failed-restored") };
    }
    return { review, audit: audit("recovery-required"), recoveryPath: journalRoot };
  }
}

/** Persist only the metadata fields allowed by the 0.2.3 audit contract. */
export async function writeAgentApplyAudit(target: string, audit: AgentApplyAudit): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(audit)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
}
