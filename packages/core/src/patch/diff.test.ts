import { describe, expect, it } from "vitest";
import { diffPreparedSnapshots } from "./diff.js";
import type { PreparedSnapshot, PreparedSnapshotFile } from "./types.js";

const file = (relpath: string, sha256: string, extra: Partial<PreparedSnapshotFile> = {}): PreparedSnapshotFile => ({
  relpath, sha256, sizeBytes: 1, representation: "full", mode: 0o644, binary: false, ...extra,
});
const snapshot = (files: PreparedSnapshotFile[]): PreparedSnapshot => ({
  contextId: "context", revisionId: "revision", createdFromRunId: "run", files,
});

describe("prepared snapshot diff", () => {
  it("detects added, modified, deleted, unique rename, mode, and binary changes", () => {
    const baseline = snapshot([
      file("delete.ts", "d"), file("edit.ts", "old"), file("mode.sh", "m"),
      file("old.ts", "rename"), file("raw.bin", "bin-old", { binary: true }),
    ]);
    const current = snapshot([
      file("add.ts", "a"), file("edit.ts", "new"), file("mode.sh", "m", { mode: 0o755 }),
      file("new.ts", "rename"), file("raw.bin", "bin-new", { binary: true }),
    ]);
    expect(diffPreparedSnapshots(baseline, current).map(({ kind, relpath, previousRelpath }) => ({ kind, relpath, previousRelpath }))).toEqual([
      { kind: "added", relpath: "add.ts", previousRelpath: undefined },
      { kind: "deleted", relpath: "delete.ts", previousRelpath: undefined },
      { kind: "modified", relpath: "edit.ts", previousRelpath: undefined },
      { kind: "mode-changed", relpath: "mode.sh", previousRelpath: undefined },
      { kind: "renamed", relpath: "new.ts", previousRelpath: "old.ts" },
      { kind: "binary", relpath: "raw.bin", previousRelpath: undefined },
    ]);
    const policy = diffPreparedSnapshots(baseline, current);
    expect(policy.find((entry) => entry.kind === "binary")?.applyEligibility).toBe("blocked");
    expect(policy.find((entry) => entry.kind === "mode-changed")?.applyEligibility).toBe("blocked");
  });

  it("detects 1,000 changes in a deterministic 5,000-file snapshot", () => {
    const files = Array.from({ length: 5_000 }, (_, index) => file(`src/file-${String(index).padStart(4, "0")}.ts`, `hash-${index}`));
    const baseline = snapshot(files);
    const current = snapshot(files.map((entry, index) => index < 1_000 ? { ...entry, sha256: `changed-${index}` } : entry));
    const changes = diffPreparedSnapshots(baseline, current);
    expect(changes).toHaveLength(1_000);
    expect(changes.every((change) => change.kind === "modified")).toBe(true);
    expect(changes.map((change) => change.relpath)).toEqual([...changes.map((change) => change.relpath)].sort());
  });

  it("emits add plus delete instead of guessing an ambiguous rename", () => {
    const changes = diffPreparedSnapshots(
      snapshot([file("old-a", "same"), file("old-b", "same")]),
      snapshot([file("new-a", "same"), file("new-b", "same")]),
    );
    expect(changes.map((entry) => entry.kind)).toEqual(["added", "added", "deleted", "deleted"]);
    expect(changes.some((entry) => entry.kind === "renamed")).toBe(false);
  });

  it("blocks internal and non-full representations in the diff model", () => {
    const changes = diffPreparedSnapshots(snapshot([]), snapshot([
      file(".yuhi/session.json", "a"),
      file(".GIT/config", "internal-case"),
      file("summary.ts", "b", { representation: "compressed" }),
      file("derived.md", "c", { representation: "background-artifact" }),
    ]));
    expect(changes.every((entry) => entry.applyEligibility === "blocked")).toBe(true);
    expect(changes.flatMap((entry) => entry.reasonCodes)).toEqual(expect.arrayContaining([
      "patch-sensitive-config", "patch-compressed-source", "patch-background-artifact",
    ]));
    expect(changes.find((entry) => entry.relpath === ".GIT/config")?.applyEligibility).toBe("blocked");
  });
});
