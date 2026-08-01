import type {
  PatchApplyEligibility,
  PatchChange,
  PatchReasonCode,
  PreparedSnapshot,
  PreparedSnapshotFile,
} from "./types.js";

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function policy(file: PreparedSnapshotFile): { eligibility: PatchApplyEligibility; reasons: PatchReasonCode[] } {
  const reasons: PatchReasonCode[] = [];
  const foldedPath = file.relpath.toLocaleLowerCase("en-US");
  if (foldedPath === ".git" || foldedPath.startsWith(".git/")) reasons.push("patch-sensitive-config");
  if (foldedPath === ".yuhi" || foldedPath.startsWith(".yuhi/")) reasons.push("patch-sensitive-config");
  if (file.representation === "compressed") reasons.push("patch-compressed-source");
  if (file.representation === "background-artifact") reasons.push("patch-background-artifact");
  if (file.binary) reasons.push("patch-binary");
  if ((file.mode & 0o111) !== 0) reasons.push("patch-unsupported-mode");
  const blocked = reasons.some((reason) =>
    reason === "patch-sensitive-config" ||
    reason === "patch-compressed-source" ||
    reason === "patch-background-artifact" ||
    reason === "patch-binary" ||
    reason === "patch-unsupported-mode"
  );
  return { eligibility: blocked ? "blocked" : reasons.length ? "requires-review" : "eligible", reasons };
}

function change(kind: PatchChange["kind"], after: PreparedSnapshotFile | undefined, before: PreparedSnapshotFile | undefined): PatchChange {
  const governing = after ?? before!;
  const result = policy(governing);
  return {
    relpath: after?.relpath ?? before!.relpath,
    kind,
    beforeHash: before?.sha256,
    afterHash: after?.sha256,
    beforeSizeBytes: before?.sizeBytes,
    afterSizeBytes: after?.sizeBytes,
    beforeMode: before?.mode,
    afterMode: after?.mode,
    representation: governing.representation,
    ...(governing.unsafeType ? { unsafeType: governing.unsafeType } : {}),
    applyEligibility: result.eligibility,
    reasonCodes: [
      kind === "added"
        ? "patch-added"
        : kind === "modified"
          ? "patch-modified"
          : kind === "deleted"
            ? "patch-deleted"
            : kind === "renamed"
              ? "patch-renamed"
              : kind === "binary"
                ? "patch-binary"
                : "patch-unsupported-mode",
      ...result.reasons,
    ],
  };
}

function uniqueByHash(files: readonly PreparedSnapshotFile[]): Map<string, PreparedSnapshotFile> {
  const grouped = new Map<string, PreparedSnapshotFile[]>();
  for (const file of files) grouped.set(file.sha256, [...(grouped.get(file.sha256) ?? []), file]);
  return new Map([...grouped].flatMap(([hash, matches]) => matches.length === 1 ? [[hash, matches[0]!] as const] : []));
}

/** Compare two scans without consulting time, agent identity, or absolute paths. */
export function diffPreparedSnapshots(baseline: PreparedSnapshot, current: PreparedSnapshot): PatchChange[] {
  if (baseline.contextId !== current.contextId || baseline.revisionId !== current.revisionId) {
    throw new Error("snapshot-context-mismatch");
  }
  const before = new Map(baseline.files.map((file) => [file.relpath, file]));
  const after = new Map(current.files.map((file) => [file.relpath, file]));
  const deleted = baseline.files.filter((file) => !after.has(file.relpath));
  const added = current.files.filter((file) => !before.has(file.relpath));
  const uniqueDeleted = uniqueByHash(deleted);
  const uniqueAdded = uniqueByHash(added);
  const renamedFrom = new Set<string>();
  const renamedTo = new Set<string>();
  const changes: PatchChange[] = [];

  for (const [hash, oldFile] of uniqueDeleted) {
    const newFile = uniqueAdded.get(hash);
    if (!newFile) continue;
    const renamed = change("renamed", newFile, oldFile);
    renamed.previousRelpath = oldFile.relpath;
    changes.push(renamed);
    renamedFrom.add(oldFile.relpath);
    renamedTo.add(newFile.relpath);
  }

  for (const oldFile of deleted) if (!renamedFrom.has(oldFile.relpath)) changes.push(change("deleted", undefined, oldFile));
  for (const newFile of added) if (!renamedTo.has(newFile.relpath)) changes.push(change(newFile.binary ? "binary" : "added", newFile, undefined));

  for (const [relpath, oldFile] of before) {
    const newFile = after.get(relpath);
    if (!newFile) continue;
    if (oldFile.sha256 !== newFile.sha256) changes.push(change(newFile.binary || oldFile.binary ? "binary" : "modified", newFile, oldFile));
    else if (oldFile.mode !== newFile.mode) changes.push(change("mode-changed", newFile, oldFile));
  }

  return changes.sort((a, b) => comparePath(a.relpath, b.relpath));
}
