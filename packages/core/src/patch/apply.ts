import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

import type { PatchChange } from "./types.js";
import { validatePatchChange } from "./validator.js";

export type AtomicPatchChange = PatchChange;

export interface PatchRoots {
  sourceRoot: string;
  preparedRoot: string;
  /** Yuhi-managed private state; must be outside both repositories. */
  privateRoot: string;
}

export interface AtomicApplyRequest extends PatchRoots {
  patchId: string;
  changes: AtomicPatchChange[];
  /** Deterministic fault/race injection for focused tests; production callers omit this. */
  testHooks?: {
    beforeMutation?: (change: Readonly<AtomicPatchChange>, index: number) => void | Promise<void>;
    afterDestinationWrite?: (
      change: Readonly<AtomicPatchChange>,
      index: number,
    ) => void | Promise<void>;
  };
}

export interface UndoPatchTestHooks {
  beforeMutation?: (change: Readonly<AtomicPatchChange>, index: number) => void | Promise<void>;
  afterMutation?: (change: Readonly<AtomicPatchChange>, index: number) => void | Promise<void>;
  beforeRollback?: (change: Readonly<AtomicPatchChange>, index: number) => void | Promise<void>;
}

export interface PatchOperationResult {
  status:
    | "applied"
    | "failed"
    | "undone"
    | "undo-rolled-back"
    | "undo-rollback-failed"
    | "conflict"
    | "discarded";
  patchId: string;
  applied: string[];
  pending: string[];
  rolledBack: string[];
  reasonCode?: "patch-applied" | "patch-apply-failed" | "patch-undone" | "patch-undo-conflict";
  recoveryRequired?: boolean;
}

interface StoredPatchRecord {
  schemaVersion: 1;
  patchId: string;
  sourceRoot: string;
  changes: AtomicPatchChange[];
  applied: string[];
  status: "applied" | "apply-failed" | "undone" | "undo-recovery-required";
  transactionStatus?:
    | "applied"
    | "rolled-back"
    | "rollback-failed"
    | "undone"
    | "undo-rolled-back"
    | "undo-rollback-failed";
  attempted?: string[];
  rolledBack?: string[];
  rollbackFailed?: string[];
  /** Repository-relative keys and hashes only; private state, never public output. */
  finalObservedHashes?: Record<string, string>;
}

const HASH_MISSING = "missing";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileHash(filename: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) return `unsupported:${stat.mode}`;
    return sha256(await handle.readFile());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return HASH_MISSING;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readRegularFile(filename: string): Promise<Buffer> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("unsupported-source-entry");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function safeRelpath(relpath: string): boolean {
  if (!relpath || path.isAbsolute(relpath) || /^(?:[a-z]:[\\/]|\\\\)/i.test(relpath)) return false;
  const slash = relpath.replaceAll("\\", "/");
  const segments = slash.split("/");
  if (segments.some((segment) =>
    !segment || segment === "." || segment === ".." || segment.includes("\0") ||
    [...segment].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    }) || segment.includes(":") || /[. ]$/.test(segment) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  )) return false;
  const first = segments[0]?.toLowerCase();
  return first !== ".git" && first !== ".yuhi";
}

function contained(root: string, relpath: string): string {
  if (!safeRelpath(relpath)) throw new Error("unsafe-path");
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...relpath.replaceAll("\\", "/").split("/"));
  const relative = path.relative(resolvedRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("unsafe-path");
  return target;
}

async function assertNoSymlink(
  root: string,
  relpath: string,
  allowMissingLeaf = true,
): Promise<void> {
  const target = contained(root, relpath);
  let cursor = path.dirname(target);
  const resolvedRoot = path.resolve(root);
  while (cursor !== resolvedRoot) {
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error("symlink-path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    cursor = path.dirname(cursor);
  }
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("symlink-path");
  } catch (error) {
    if (!allowMissingLeaf || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function patchDir(privateRoot: string, patchId: string): string {
  const deterministic = /^sha256:([a-f0-9]{64})$/.exec(patchId);
  const directoryName = deterministic
    ? `sha256-${deterministic[1]}`
    : /^[A-Za-z0-9._-]+$/.test(patchId)
      ? patchId
      : undefined;
  if (!directoryName) throw new Error("unsafe-patch-id");
  return path.join(privateRoot, "patches", directoryName);
}

async function assertPrivateBoundary(roots: PatchRoots): Promise<void> {
  const canonical = async (candidate: string): Promise<string> => {
    const absolute = path.resolve(candidate);
    try {
      return await fs.realpath(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(absolute);
      if (parent === absolute) throw error;
      return path.join(await canonical(parent), path.basename(absolute));
    }
  };
  const privateRoot = await canonical(roots.privateRoot);
  for (const visible of [roots.sourceRoot, roots.preparedRoot]) {
    const visibleRoot = await canonical(visible);
    const privateFromVisible = path.relative(visibleRoot, privateRoot);
    const visibleFromPrivate = path.relative(privateRoot, visibleRoot);
    const nested = (relative: string) =>
      relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (nested(privateFromVisible) || nested(visibleFromPrivate))
      throw new Error("private-root-visible");
  }
}

function originRelpath(change: AtomicPatchChange): string {
  return change.kind === "renamed" ? (change.previousRelpath ?? "") : change.relpath;
}

async function observeFinalHashes(
  sourceRoot: string,
  changes: readonly AtomicPatchChange[],
): Promise<Record<string, string>> {
  const observed: Record<string, string> = {};
  for (const change of changes) {
    for (const relpath of new Set([change.relpath, originRelpath(change)])) {
      try {
        observed[relpath] = await fileHash(contained(sourceRoot, relpath));
      } catch {
        observed[relpath] = "unavailable";
      }
    }
  }
  return observed;
}

async function validateChange(change: AtomicPatchChange, roots: PatchRoots): Promise<void> {
  if (change.kind === "binary" || change.kind === "mode-changed")
    throw new Error("unsupported-change");
  if (change.representation !== "full") throw new Error("ineligible-representation");
  if (change.applyEligibility === "blocked") throw new Error("blocked-change");
  const origin = originRelpath(change);
  if (!safeRelpath(change.relpath) || !safeRelpath(origin)) throw new Error("unsafe-path");
  await assertNoSymlink(roots.sourceRoot, origin);
  await assertNoSymlink(roots.sourceRoot, change.relpath);

  const current = await fileHash(contained(roots.sourceRoot, origin));
  if (change.kind === "added") {
    if (current !== HASH_MISSING) throw new Error("source-changed");
  } else if (!change.beforeHash || current !== change.beforeHash) {
    throw new Error("source-changed");
  }
  if (
    change.kind === "renamed" &&
    (await fileHash(contained(roots.sourceRoot, change.relpath))) !== HASH_MISSING
  ) {
    throw new Error("source-changed");
  }
  if (change.kind !== "deleted") {
    await assertNoSymlink(roots.preparedRoot, change.relpath, false);
    if (
      !change.afterHash ||
      (await fileHash(contained(roots.preparedRoot, change.relpath))) !== change.afterHash
    ) {
      throw new Error("prepared-changed");
    }
  }

  // Re-run the shared policy over the exact bytes proposed for Source. Review
  // metadata is not an authorization to bypass a later secret/PII/config scan.
  const beforeContent = change.kind === "added"
    ? undefined
    : await readRegularFile(contained(roots.sourceRoot, origin));
  const afterContent = change.kind === "deleted"
    ? undefined
    : await readRegularFile(contained(roots.preparedRoot, change.relpath));
  if (beforeContent && sha256(beforeContent) !== change.beforeHash) throw new Error("source-changed");
  if (afterContent && sha256(afterContent) !== change.afterHash) throw new Error("prepared-changed");
  const validation = validatePatchChange({
    relpath: change.relpath,
    previousRelpath: change.previousRelpath,
    kind: change.kind,
    representation: change.representation,
    beforeContent,
    afterContent,
  });
  if (validation.applyEligibility === "blocked") throw new Error("blocked-change");
  if (
    validation.applyEligibility === "requires-review" &&
    change.applyEligibility !== "requires-review"
  ) throw new Error("review-not-confirmed");
}

async function atomicWriteFrom(
  source: string,
  destination: string,
  expectedHash: string,
  immediateContainmentCheck?: () => Promise<void>,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temp = path.join(path.dirname(destination), `.yuhi-patch-${randomUUID()}.tmp`);
  try {
    const sourceHandle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    let sourceMode: number;
    try {
      const sourceInfo = await sourceHandle.stat();
      if (!sourceInfo.isFile()) throw new Error("unsupported-source-entry");
      bytes = await sourceHandle.readFile();
      sourceMode = sourceInfo.mode & 0o777;
    } finally {
      await sourceHandle.close();
    }
    const handle = await fs.open(temp, "wx", sourceMode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Recheck after all potentially slow I/O, directly adjacent to rename.
    await immediateContainmentCheck?.();
    await fs.rename(temp, destination);
    const directory = await fs.open(path.dirname(destination), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    if ((await fileHash(destination)) !== expectedHash) throw new Error("hash-verification-failed");
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function backupChange(
  change: AtomicPatchChange,
  roots: PatchRoots,
  backupRoot: string,
): Promise<void> {
  if (change.kind === "added") return;
  const relpath = originRelpath(change);
  const source = contained(roots.sourceRoot, relpath);
  const backup = contained(backupRoot, relpath);
  await atomicWriteFrom(source, backup, change.beforeHash!, () =>
    assertNoSymlink(roots.sourceRoot, relpath, false),
  );
  if ((await fileHash(backup)) !== change.beforeHash) throw new Error("backup-verification-failed");
}

async function mutate(
  change: AtomicPatchChange,
  roots: AtomicApplyRequest,
  index: number,
): Promise<void> {
  // Repeat lexical containment and component checks at the mutation boundary.
  // This narrows the validation/write race and ensures a test- or user-created
  // symlink appearing after preflight is rejected before any source write.
  await assertNoSymlink(roots.sourceRoot, originRelpath(change));
  await assertNoSymlink(roots.sourceRoot, change.relpath);
  const origin = contained(roots.sourceRoot, originRelpath(change));
  if (change.kind === "deleted") {
    await fs.unlink(origin);
    return;
  }
  const destination = contained(roots.sourceRoot, change.relpath);
  await atomicWriteFrom(
    contained(roots.preparedRoot, change.relpath),
    destination,
    change.afterHash!,
    async () => {
      await assertNoSymlink(roots.sourceRoot, change.relpath);
      await assertNoSymlink(roots.preparedRoot, change.relpath, false);
    },
  );
  await roots.testHooks?.afterDestinationWrite?.(change, index);
  if (change.kind === "renamed") await fs.unlink(origin);
}

async function restore(
  change: AtomicPatchChange,
  roots: Pick<PatchRoots, "sourceRoot" | "privateRoot">,
  backupRoot: string,
): Promise<void> {
  await assertNoSymlink(roots.sourceRoot, change.relpath);
  await assertNoSymlink(roots.sourceRoot, originRelpath(change));
  const destination = contained(roots.sourceRoot, change.relpath);
  if (change.kind === "added") {
    await fs.rm(destination, { force: true });
    return;
  }
  if (change.kind === "renamed") await fs.rm(destination, { force: true });
  const origin = originRelpath(change);
  const backup = contained(backupRoot, origin);
  await atomicWriteFrom(backup, contained(roots.sourceRoot, origin), change.beforeHash!, () =>
    assertNoSymlink(roots.sourceRoot, origin),
  );
}

/** Full preflight precedes backup; every path/hash is rechecked immediately before mutation. */
export async function applyPatchAtomically(
  request: AtomicApplyRequest,
): Promise<PatchOperationResult> {
  const all = request.changes.map((change) => change.relpath);
  try {
    await assertPrivateBoundary(request);
    const aliases = new Set<string>();
    for (const change of request.changes) {
      const alias = change.relpath.replaceAll("\\", "/").normalize("NFC").toLocaleLowerCase("en-US");
      if (aliases.has(alias)) throw new Error("path-collision");
      aliases.add(alias);
    }
    for (const change of request.changes) await validateChange(change, request);
  } catch {
    return {
      status: "failed",
      patchId: request.patchId,
      applied: [],
      pending: all,
      rolledBack: [],
      reasonCode: "patch-apply-failed",
    };
  }

  const directory = patchDir(request.privateRoot, request.patchId);
  const backupRoot = path.join(directory, "backup");
  const applied: AtomicPatchChange[] = [];
  let inProgress: AtomicPatchChange | undefined;
  let ownsPatchDirectory = false;
  try {
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    // A patch identity is immutable. Never reuse or overwrite its backup/history.
    await fs.mkdir(directory, { mode: 0o700 });
    ownsPatchDirectory = true;
    await fs.mkdir(backupRoot, { mode: 0o700 });
    for (const change of request.changes) await backupChange(change, request, backupRoot);
    for (const [index, change] of request.changes.entries()) {
      await request.testHooks?.beforeMutation?.(change, index);
      await validateChange(change, request); // closes the preflight-to-write race window
      // From this point a failed mutation may have changed Source and must be
      // included in rollback/accounting even if mutate() never returns.
      inProgress = change;
      await mutate(change, request, index);
      applied.push(change);
      inProgress = undefined;
    }
    // Final all-file verification precedes the success record. A later mutation or
    // filesystem anomaly cannot leave Yuhi claiming success for a mismatched tree.
    for (const change of request.changes) {
      const destination = contained(request.sourceRoot, change.relpath);
      const resultingHash = await fileHash(destination);
      if (change.kind === "deleted") {
        if (resultingHash !== HASH_MISSING) throw new Error("final-verification-failed");
      } else if (resultingHash !== change.afterHash) {
        throw new Error("final-verification-failed");
      }
      if (
        change.kind === "renamed" &&
        (await fileHash(contained(request.sourceRoot, change.previousRelpath!))) !== HASH_MISSING
      ) throw new Error("final-verification-failed");
    }
    const record: StoredPatchRecord = {
      schemaVersion: 1,
      patchId: request.patchId,
      sourceRoot: path.resolve(request.sourceRoot),
      changes: request.changes,
      applied: applied.map((c) => c.relpath),
      status: "applied",
      transactionStatus: "applied",
      attempted: all,
      rolledBack: [],
      rollbackFailed: [],
      finalObservedHashes: await observeFinalHashes(request.sourceRoot, request.changes),
    };
    await fs.writeFile(path.join(directory, "record.json"), JSON.stringify(record), {
      mode: 0o600,
    });
    return {
      status: "applied",
      patchId: request.patchId,
      applied: all,
      pending: [],
      rolledBack: [],
      reasonCode: "patch-applied",
    };
  } catch {
    const rolledBack: string[] = [];
    // Include the current operation: atomic rename may have completed before a
    // later fsync/hash/rename-cleanup step failed.
    const recovery = inProgress ? [...applied, inProgress] : applied;
    for (const change of [...recovery].reverse()) {
      try {
        await restore(change, request, backupRoot);
        rolledBack.push(change.relpath);
      } catch {
        /* recovery is explicitly reported below */
      }
    }
    const record: StoredPatchRecord = {
      schemaVersion: 1,
      patchId: request.patchId,
      sourceRoot: path.resolve(request.sourceRoot),
      changes: request.changes,
      applied: recovery.map((c) => c.relpath),
      status: "apply-failed",
      transactionStatus: rolledBack.length === recovery.length ? "rolled-back" : "rollback-failed",
      attempted: recovery.map((c) => c.relpath),
      rolledBack,
      rollbackFailed: recovery
        .map((change) => change.relpath)
        .filter((relpath) => !rolledBack.includes(relpath)),
      finalObservedHashes: await observeFinalHashes(request.sourceRoot, request.changes),
    };
    if (ownsPatchDirectory) {
      await fs
        .writeFile(path.join(directory, "record.json"), JSON.stringify(record), { mode: 0o600 })
        .catch(() => {});
    }
    return {
      status: "failed",
      patchId: request.patchId,
      applied: recovery.map((c) => c.relpath),
      pending: all.slice(recovery.length),
      rolledBack,
      reasonCode: "patch-apply-failed",
      recoveryRequired: rolledBack.length !== recovery.length,
    };
  }
}

export async function undoPatch(
  privateRoot: string,
  patchId: string,
  testHooks?: UndoPatchTestHooks,
): Promise<PatchOperationResult> {
  const directory = patchDir(privateRoot, patchId);
  const record = JSON.parse(
    await fs.readFile(path.join(directory, "record.json"), "utf8"),
  ) as StoredPatchRecord;
  if (record.status !== "applied") {
    return {
      status: "conflict",
      patchId,
      applied: [],
      pending: record.applied,
      rolledBack: [],
      reasonCode: "patch-undo-conflict",
      recoveryRequired: record.status === "undo-recovery-required",
    };
  }
  const changes = record.changes.filter((change) => record.applied.includes(change.relpath));
  for (const change of changes) {
    const destinationHash = await fileHash(contained(record.sourceRoot, change.relpath));
    if (
      change.kind === "deleted"
        ? destinationHash !== HASH_MISSING
        : destinationHash !== change.afterHash
    ) {
      return {
        status: "conflict",
        patchId,
        applied: [],
        pending: changes.map((c) => c.relpath),
        rolledBack: [],
        reasonCode: "patch-undo-conflict",
      };
    }
    if (
      change.kind === "renamed" &&
      (await fileHash(contained(record.sourceRoot, change.previousRelpath!))) !== HASH_MISSING
    ) {
      return {
        status: "conflict",
        patchId,
        applied: [],
        pending: changes.map((c) => c.relpath),
        rolledBack: [],
        reasonCode: "patch-undo-conflict",
      };
    }
  }
  const ordered = [...changes].reverse();
  const recoveryRoot = path.join(directory, `undo-recovery-${randomUUID()}`);
  await fs.mkdir(recoveryRoot, { mode: 0o700 });
  try {
    // Capture the complete post-apply state before the first undo mutation.
    for (const change of changes) {
      if (change.kind === "deleted") continue;
      await atomicWriteFrom(
        contained(record.sourceRoot, change.relpath),
        contained(recoveryRoot, change.relpath),
        change.afterHash!,
        () => assertNoSymlink(record.sourceRoot, change.relpath, false),
      );
    }

    const undone: AtomicPatchChange[] = [];
    let inProgress: AtomicPatchChange | undefined;
    try {
      for (const [index, change] of ordered.entries()) {
        await testHooks?.beforeMutation?.(change, index);
        inProgress = change;
        await restore(
          change,
          { sourceRoot: record.sourceRoot, privateRoot },
          path.join(directory, "backup"),
        );
        await testHooks?.afterMutation?.(change, index);
        undone.push(change);
        inProgress = undefined;
      }
      record.status = "undone";
      record.transactionStatus = "undone";
      await fs.writeFile(path.join(directory, "record.json"), JSON.stringify(record), { mode: 0o600 });
      await fs.rm(recoveryRoot, { recursive: true, force: true });
      return {
        status: "undone",
        patchId,
        applied: undone.map((change) => change.relpath),
        pending: [],
        rolledBack: [],
        reasonCode: "patch-undone",
      };
    } catch {
      const attempted = inProgress ? [...undone, inProgress] : undone;
      const rolledBack: string[] = [];
      for (const [index, change] of [...attempted].reverse().entries()) {
        try {
          await testHooks?.beforeRollback?.(change, index);
          await assertNoSymlink(record.sourceRoot, change.relpath);
          await assertNoSymlink(record.sourceRoot, originRelpath(change));
          if (change.kind === "deleted") {
            await fs.rm(contained(record.sourceRoot, change.relpath), { force: true });
          } else {
            if (change.kind === "renamed") {
              await fs.rm(contained(record.sourceRoot, change.previousRelpath!), { force: true });
            }
            await atomicWriteFrom(
              contained(recoveryRoot, change.relpath),
              contained(record.sourceRoot, change.relpath),
              change.afterHash!,
              () => assertNoSymlink(record.sourceRoot, change.relpath),
            );
          }
          rolledBack.push(change.relpath);
        } catch {
          // Keep recovery material and report the exact incomplete recovery.
        }
      }
      const recoveryRequired = rolledBack.length !== attempted.length;
      if (recoveryRequired) {
        record.status = "undo-recovery-required";
        record.transactionStatus = "undo-rollback-failed";
        await fs
          .writeFile(path.join(directory, "record.json"), JSON.stringify(record), { mode: 0o600 })
          .catch(() => {});
      } else {
        record.transactionStatus = "undo-rolled-back";
        await fs
          .writeFile(path.join(directory, "record.json"), JSON.stringify(record), { mode: 0o600 })
          .catch(() => {});
        await fs.rm(recoveryRoot, { recursive: true, force: true });
      }
      return {
        status: recoveryRequired ? "undo-rollback-failed" : "undo-rolled-back",
        patchId,
        applied: attempted.map((change) => change.relpath),
        pending: ordered.slice(attempted.length).map((change) => change.relpath),
        rolledBack,
        reasonCode: "patch-undo-conflict",
        recoveryRequired,
      };
    }
  } catch {
    // No Source mutation has happened when recovery capture itself fails.
    return {
      status: "failed",
      patchId,
      applied: [],
      pending: ordered.map((change) => change.relpath),
      rolledBack: [],
      reasonCode: "patch-undo-conflict",
    };
  }
}

export interface PatchHistoryEntry {
  patchId: string;
  status: StoredPatchRecord["status"];
  files: string[];
}

export async function patchHistory(privateRoot: string): Promise<PatchHistoryEntry[]> {
  const root = path.join(privateRoot, "patches");
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const entries: PatchHistoryEntry[] = [];
  for (const name of names.sort()) {
    try {
      const record = JSON.parse(
        await fs.readFile(path.join(root, name, "record.json"), "utf8"),
      ) as StoredPatchRecord;
      entries.push({ patchId: record.patchId, status: record.status, files: [...record.applied] });
    } catch {
      /* malformed private records are not exposed */
    }
  }
  return entries;
}

/** Restore agent-authored context files from a private baseline; derived background artifacts are untouched. */
export async function discardPreparedChanges(
  preparedRoot: string,
  baselineRoot: string,
  changes: AtomicPatchChange[],
): Promise<string[]> {
  const discarded: string[] = [];
  for (const change of changes) {
    if (change.representation === "background-artifact") continue;
    await assertNoSymlink(preparedRoot, change.relpath);
    await assertNoSymlink(preparedRoot, originRelpath(change));
    const target = contained(preparedRoot, change.relpath);
    if (change.kind === "added") await fs.rm(target, { force: true });
    else {
      if (change.kind === "renamed") await fs.rm(target, { force: true });
      const origin = originRelpath(change);
      await assertNoSymlink(baselineRoot, origin, false);
      await atomicWriteFrom(
        contained(baselineRoot, origin),
        contained(preparedRoot, origin),
        change.beforeHash!,
        () => assertNoSymlink(preparedRoot, origin),
      );
    }
    discarded.push(change.relpath);
  }
  return discarded;
}
