import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyPatchAtomically,
  discardPreparedChanges,
  patchHistory,
  undoPatch,
  type AtomicPatchChange,
} from "./apply.js";

const temporaryRoots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function environment() {
  const root = mkdtempSync(path.join(tmpdir(), "yuhi-patch-"));
  temporaryRoots.push(root);
  const sourceRoot = path.join(root, "source");
  const preparedRoot = path.join(root, "prepared");
  const privateRoot = path.join(root, "private");
  mkdirSync(sourceRoot);
  mkdirSync(preparedRoot);
  return { root, sourceRoot, preparedRoot, privateRoot };
}

function change(overrides: Partial<AtomicPatchChange>): AtomicPatchChange {
  return {
    relpath: "src/a.ts",
    kind: "modified",
    beforeHash: hash("before"),
    afterHash: hash("after"),
    beforeSizeBytes: 6,
    afterSizeBytes: 5,
    representation: "full",
    applyEligibility: "eligible",
    reasonCodes: [],
    ...overrides,
  };
}

function put(root: string, relpath: string, contents: string): void {
  const filename = path.join(root, relpath);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, contents);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("atomic patch application", () => {
  it("applies only after full preflight, writes private backup, and records relative history", async () => {
    const env = environment();
    put(env.sourceRoot, "src/a.ts", "before");
    put(env.preparedRoot, "src/a.ts", "after");

    const result = await applyPatchAtomically({
      ...env,
      patchId: "patch-1",
      changes: [change({})],
    });

    expect(result).toMatchObject({ status: "applied", applied: ["src/a.ts"], pending: [] });
    expect(readFileSync(path.join(env.sourceRoot, "src/a.ts"), "utf8")).toBe("after");
    expect(
      readFileSync(path.join(env.privateRoot, "patches/patch-1/backup/src/a.ts"), "utf8"),
    ).toBe("before");
    expect(await patchHistory(env.privateRoot)).toEqual([
      { patchId: "patch-1", status: "applied", files: ["src/a.ts"] },
    ]);
  });

  it("fails the entire preflight without mutating an otherwise valid selected file", async () => {
    const env = environment();
    put(env.sourceRoot, "good.txt", "old");
    put(env.preparedRoot, "good.txt", "new");
    put(env.sourceRoot, "conflict.txt", "user edit");
    put(env.preparedRoot, "conflict.txt", "agent edit");
    const changes = [
      change({ relpath: "good.txt", beforeHash: hash("old"), afterHash: hash("new") }),
      change({
        relpath: "conflict.txt",
        beforeHash: hash("baseline"),
        afterHash: hash("agent edit"),
      }),
    ];

    const result = await applyPatchAtomically({ ...env, patchId: "preflight", changes });

    expect(result.status).toBe("failed");
    expect(result.applied).toEqual([]);
    expect(readFileSync(path.join(env.sourceRoot, "good.txt"), "utf8")).toBe("old");
  });

  it("rejects blocked eligibility and rescans the exact proposed bytes before Apply", async () => {
    const cases: Array<{ id: string; relpath: string; after: string; eligibility?: AtomicPatchChange["applyEligibility"] }> = [
      { id: "declared-blocked", relpath: "safe.txt", after: "ordinary", eligibility: "blocked" },
      { id: "secret", relpath: "generated.txt", after: "API_KEY=sk-proj-abcdefghijklmnop" },
      { id: "credential-file", relpath: ".env", after: "DEBUG=true" },
      { id: "unreviewed-pii", relpath: "contact.txt", after: "person@example.com" },
    ];
    for (const candidate of cases) {
      const env = environment();
      put(env.sourceRoot, candidate.relpath, "before");
      put(env.preparedRoot, candidate.relpath, candidate.after);
      const result = await applyPatchAtomically({
        ...env,
        patchId: candidate.id,
        changes: [change({
          relpath: candidate.relpath,
          beforeHash: hash("before"),
          afterHash: hash(candidate.after),
          applyEligibility: candidate.eligibility ?? "eligible",
        })],
      });
      expect(result).toMatchObject({ status: "failed", applied: [], pending: [candidate.relpath] });
      expect(readFileSync(path.join(env.sourceRoot, candidate.relpath), "utf8")).toBe("before");
    }
  });

  it("rolls back prior and in-progress writes after a deterministic mid-operation failure", async () => {
    const env = environment();
    put(env.sourceRoot, "first.txt", "first-old");
    put(env.sourceRoot, "second.txt", "second-old");
    put(env.preparedRoot, "first.txt", "first-new");
    put(env.preparedRoot, "second.txt", "second-new");
    const changes = [
      change({ relpath: "first.txt", beforeHash: hash("first-old"), afterHash: hash("first-new") }),
      change({
        relpath: "second.txt",
        beforeHash: hash("second-old"),
        afterHash: hash("second-new"),
      }),
    ];

    const result = await applyPatchAtomically({
      ...env,
      patchId: "mid-operation-failure",
      changes,
      testHooks: {
        afterDestinationWrite: (_change, index) => {
          if (index === 1) throw new Error("injected-after-rename-failure");
        },
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      applied: ["first.txt", "second.txt"],
      pending: [],
      rolledBack: ["second.txt", "first.txt"],
      recoveryRequired: false,
    });
    expect(readFileSync(path.join(env.sourceRoot, "first.txt"), "utf8")).toBe("first-old");
    expect(readFileSync(path.join(env.sourceRoot, "second.txt"), "utf8")).toBe("second-old");
    const record = JSON.parse(readFileSync(
      path.join(env.privateRoot, "patches/mid-operation-failure/record.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(record).toMatchObject({
      transactionStatus: "rolled-back",
      attempted: ["first.txt", "second.txt"],
      rolledBack: ["second.txt", "first.txt"],
      rollbackFailed: [],
      finalObservedHashes: {
        "first.txt": hash("first-old"),
        "second.txt": hash("second-old"),
      },
    });
  });

  it("rechecks containment immediately before mutation and never follows a raced symlink", async () => {
    const env = environment();
    const outside = path.join(env.root, "outside");
    mkdirSync(outside);
    put(outside, "victim.txt", "outside-safe");
    put(env.sourceRoot, "nested/victim.txt", "source-old");
    put(env.preparedRoot, "nested/victim.txt", "agent-new");

    const result = await applyPatchAtomically({
      ...env,
      patchId: "symlink-race",
      changes: [
        change({
          relpath: "nested/victim.txt",
          beforeHash: hash("source-old"),
          afterHash: hash("agent-new"),
        }),
      ],
      testHooks: {
        beforeMutation: () => {
          renameSync(
            path.join(env.sourceRoot, "nested"),
            path.join(env.sourceRoot, "nested-moved"),
          );
          symlinkSync(outside, path.join(env.sourceRoot, "nested"));
        },
      },
    });

    expect(result.status).toBe("failed");
    expect(readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe("outside-safe");
    expect(readFileSync(path.join(env.sourceRoot, "nested-moved/victim.txt"), "utf8")).toBe(
      "source-old",
    );
  });

  it("rejects traversal, internal paths, compressed files, and symlink escapes", async () => {
    const env = environment();
    put(env.preparedRoot, "escape.txt", "after");
    const outside = path.join(env.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(env.sourceRoot, "linked"));
    put(env.preparedRoot, "linked/a.txt", "after");
    for (const candidate of [
      change({ relpath: "../escape.txt", kind: "added", beforeHash: undefined }),
      change({ relpath: ".git/config", kind: "added", beforeHash: undefined }),
      change({
        relpath: "escape.txt",
        kind: "added",
        beforeHash: undefined,
        representation: "compressed",
      }),
      change({ relpath: "linked/a.txt", kind: "added", beforeHash: undefined }),
    ]) {
      const result = await applyPatchAtomically({
        ...env,
        patchId: `blocked-${Math.random()}`,
        changes: [candidate],
      });
      expect(result.status).toBe("failed");
    }
    expect(readFileSync(path.join(env.preparedRoot, "escape.txt"), "utf8")).toBe("after");
  });

  it("undo restores modifications, deletions and renames, and removes additions", async () => {
    const env = environment();
    put(env.sourceRoot, "modified.txt", "m0");
    put(env.sourceRoot, "deleted.txt", "d0");
    put(env.sourceRoot, "old-name.txt", "r0");
    put(env.preparedRoot, "modified.txt", "m1");
    put(env.preparedRoot, "added.txt", "a1");
    put(env.preparedRoot, "new-name.txt", "r1");
    const changes = [
      change({ relpath: "modified.txt", beforeHash: hash("m0"), afterHash: hash("m1") }),
      change({ relpath: "added.txt", kind: "added", beforeHash: undefined, afterHash: hash("a1") }),
      change({
        relpath: "deleted.txt",
        kind: "deleted",
        beforeHash: hash("d0"),
        afterHash: undefined,
      }),
      change({
        relpath: "new-name.txt",
        previousRelpath: "old-name.txt",
        kind: "renamed",
        beforeHash: hash("r0"),
        afterHash: hash("r1"),
      }),
    ];
    expect((await applyPatchAtomically({ ...env, patchId: "undo-all", changes })).status).toBe(
      "applied",
    );

    const result = await undoPatch(env.privateRoot, "undo-all");

    expect(result.status).toBe("undone");
    expect(readFileSync(path.join(env.sourceRoot, "modified.txt"), "utf8")).toBe("m0");
    expect(readFileSync(path.join(env.sourceRoot, "deleted.txt"), "utf8")).toBe("d0");
    expect(readFileSync(path.join(env.sourceRoot, "old-name.txt"), "utf8")).toBe("r0");
    expect(() => readFileSync(path.join(env.sourceRoot, "added.txt"))).toThrow();
    expect(() => readFileSync(path.join(env.sourceRoot, "new-name.txt"))).toThrow();
  });

  it("blocks undo when the user changed source after apply", async () => {
    const env = environment();
    put(env.sourceRoot, "src/a.ts", "before");
    put(env.preparedRoot, "src/a.ts", "after");
    await applyPatchAtomically({ ...env, patchId: "conflict", changes: [change({})] });
    put(env.sourceRoot, "src/a.ts", "user edit");

    const result = await undoPatch(env.privateRoot, "conflict");

    expect(result).toMatchObject({ status: "conflict", reasonCode: "patch-undo-conflict" });
    expect(readFileSync(path.join(env.sourceRoot, "src/a.ts"), "utf8")).toBe("user edit");
  });

  it("transactionally restores the post-apply state when undo fails halfway", async () => {
    const env = environment();
    put(env.sourceRoot, "first.txt", "first-old");
    put(env.sourceRoot, "second.txt", "second-old");
    put(env.preparedRoot, "first.txt", "first-new");
    put(env.preparedRoot, "second.txt", "second-new");
    const changes = [
      change({ relpath: "first.txt", beforeHash: hash("first-old"), afterHash: hash("first-new") }),
      change({ relpath: "second.txt", beforeHash: hash("second-old"), afterHash: hash("second-new") }),
    ];
    expect((await applyPatchAtomically({ ...env, patchId: "undo-transaction", changes })).status).toBe("applied");

    const result = await undoPatch(env.privateRoot, "undo-transaction", {
      beforeMutation: (_change, index) => {
        if (index === 1) throw new Error("injected-undo-failure");
      },
    });

    expect(result).toMatchObject({
      status: "undo-rolled-back",
      applied: ["second.txt"],
      pending: ["first.txt"],
      rolledBack: ["second.txt"],
      recoveryRequired: false,
    });
    expect(readFileSync(path.join(env.sourceRoot, "first.txt"), "utf8")).toBe("first-new");
    expect(readFileSync(path.join(env.sourceRoot, "second.txt"), "utf8")).toBe("second-new");
    expect(await patchHistory(env.privateRoot)).toEqual([
      { patchId: "undo-transaction", status: "applied", files: ["first.txt", "second.txt"] },
    ]);
  });

  it("retains private recovery material and reports recovery required when undo rollback fails", async () => {
    const env = environment();
    put(env.sourceRoot, "a.txt", "old-a");
    put(env.sourceRoot, "b.txt", "old-b");
    put(env.preparedRoot, "a.txt", "new-a");
    put(env.preparedRoot, "b.txt", "new-b");
    const changes = [
      change({ relpath: "a.txt", beforeHash: hash("old-a"), afterHash: hash("new-a") }),
      change({ relpath: "b.txt", beforeHash: hash("old-b"), afterHash: hash("new-b") }),
    ];
    await applyPatchAtomically({ ...env, patchId: "undo-recovery", changes });

    const result = await undoPatch(env.privateRoot, "undo-recovery", {
      beforeMutation: (_change, index) => {
        if (index === 1) throw new Error("stop-undo");
      },
      beforeRollback: () => {
        throw new Error("stop-recovery");
      },
    });

    expect(result).toMatchObject({
      status: "undo-rollback-failed",
      recoveryRequired: true,
      rolledBack: [],
    });
    const patchRoot = path.join(env.privateRoot, "patches", "undo-recovery");
    expect(readdirSync(patchRoot).some((name) => name.startsWith("undo-recovery-"))).toBe(true);
    expect(existsSync(path.join(patchRoot, "record.json"))).toBe(true);
    expect(await patchHistory(env.privateRoot)).toEqual([
      {
        patchId: "undo-recovery",
        status: "undo-recovery-required",
        files: ["a.txt", "b.txt"],
      },
    ]);
    expect(JSON.parse(readFileSync(path.join(patchRoot, "record.json"), "utf8")))
      .toMatchObject({ transactionStatus: "undo-rollback-failed" });
    expect(await undoPatch(env.privateRoot, "undo-recovery")).toMatchObject({
      status: "conflict",
      recoveryRequired: true,
    });
  });

  it("never reuses or overwrites an existing patch identity", async () => {
    const env = environment();
    put(env.sourceRoot, "src/a.ts", "before");
    put(env.preparedRoot, "src/a.ts", "after");
    await applyPatchAtomically({ ...env, patchId: "immutable-id", changes: [change({})] });
    await undoPatch(env.privateRoot, "immutable-id");

    const replay = await applyPatchAtomically({
      ...env,
      patchId: "immutable-id",
      changes: [change({})],
    });

    expect(replay.status).toBe("failed");
    expect(readFileSync(path.join(env.sourceRoot, "src/a.ts"), "utf8")).toBe("before");
    expect(await patchHistory(env.privateRoot)).toEqual([
      { patchId: "immutable-id", status: "undone", files: ["src/a.ts"] },
    ]);
  });

  it("discard restores agent changes while preserving background artifacts", async () => {
    const env = environment();
    const baseline = path.join(env.privateRoot, "baseline");
    put(baseline, "code.ts", "baseline");
    put(env.preparedRoot, "code.ts", "agent edit");
    put(env.preparedRoot, "notes.generated.md", "background result");
    const changes = [
      change({ relpath: "code.ts", beforeHash: hash("baseline"), afterHash: hash("agent edit") }),
      change({
        relpath: "notes.generated.md",
        kind: "added",
        beforeHash: undefined,
        afterHash: hash("background result"),
        representation: "background-artifact",
      }),
    ];

    expect(await discardPreparedChanges(env.preparedRoot, baseline, changes)).toEqual(["code.ts"]);
    expect(readFileSync(path.join(env.preparedRoot, "code.ts"), "utf8")).toBe("baseline");
    expect(readFileSync(path.join(env.preparedRoot, "notes.generated.md"), "utf8")).toBe(
      "background result",
    );
  });
});
