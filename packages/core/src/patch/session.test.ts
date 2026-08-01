import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { capturePatchSession, loadPatchSession, materializePatchSelection, reviewPatchSession } from "./session.js";
import { applyPatchSession } from "./trusted-apply.js";

const roots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "yuhi-patch-session-"));
  roots.push(root);
  const managedBase = path.join(root, "managed");
  const runId = "run-synthetic";
  const preparedRoot = path.join(managedBase, runId);
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(preparedRoot, "src"), { recursive: true });
  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await writeFile(path.join(preparedRoot, "src", "app.ts"), "export const value = 1;\n");
  await writeFile(path.join(sourceRoot, "src", "app.ts"), "export const value = 1;\n");
  await writeFile(path.join(preparedRoot, "manifest.json"), JSON.stringify({
    schemaVersion: 2,
    files: [{ relpath: "src/app.ts", contextRepresentation: "full" }],
  }));
  return { root, managedBase, runId, preparedRoot, sourceRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private patch session", () => {
  it("captures outside the agent root and detects a deterministic eligible edit", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "session-1",
      contextId: `sha256:${"a".repeat(64)}`,
      revisionId: `sha256:${"b".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "export const value = 2;\n");
    const review = await reviewPatchSession(state, { sessionId: "session-1", id: "codex" });
    expect(review.changes).toHaveLength(1);
    expect(review.changes[0]).toMatchObject({
      relpath: "src/app.ts",
      kind: "modified",
      risk: "low",
      applyEligibility: "eligible",
      sourceChanged: false,
    });
    expect(review.patch.patchId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect((await loadPatchSession(env.managedBase, env.runId)).snapshotId).toBe(state.snapshotId);
    expect(existsSync(path.join(env.preparedRoot, ".internal"))).toBe(false);
    expect((await readdir(env.preparedRoot)).includes("patches")).toBe(false);
    expect(JSON.stringify(review)).not.toContain(env.sourceRoot);
    expect(JSON.stringify(review)).not.toContain(env.preparedRoot);
  });

  it("binds every review to the exact deterministic Prepared Working Tree", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "working-tree-identity",
      contextId: `sha256:${"1".repeat(64)}`,
      revisionId: `sha256:${"2".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "first agent edit\n");
    const first = await reviewPatchSession(state);
    const repeated = await reviewPatchSession(state);
    expect(first.preparedWorkingTreeId).toBe(repeated.preparedWorkingTreeId);
    expect(first.preparedWorkingTreeId).toMatch(/^sha256:[a-f0-9]{64}$/);

    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "second agent edit\n");
    const second = await reviewPatchSession(state);
    expect(second.preparedWorkingTreeId).not.toBe(first.preparedWorkingTreeId);
  });

  it("blocks transformed provenance and a Source conflict without exposing bytes", async () => {
    const env = await fixture();
    await writeFile(path.join(env.preparedRoot, "records.csv"), "Student 001,90\n");
    await writeFile(path.join(env.sourceRoot, "records.csv"), "Synthetic Name,90\n");
    await writeFile(path.join(env.preparedRoot, "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      files: [
        { relpath: "src/app.ts", contextRepresentation: "full" },
        { relpath: "records.csv", transformed: true, transformations: ["pseudonymized"] },
      ],
    }));
    const state = await capturePatchSession({
      ...env,
      sessionId: "session-2",
      contextId: `sha256:${"c".repeat(64)}`,
      revisionId: `sha256:${"d".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "records.csv"), "Student 001,95\n");
    // Agent-visible manifest tampering must never upgrade transformed provenance.
    await writeFile(path.join(env.preparedRoot, "manifest.json"), JSON.stringify({
      files: [{ relpath: "records.csv", contextRepresentation: "full" }],
    }));
    await writeFile(path.join(env.sourceRoot, "src", "app.ts"), "user edit\n");
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "agent edit\n");
    const review = await reviewPatchSession(state);
    expect(review.applyAllowed).toBe(false);
    expect(review.changes.find((change) => change.relpath === "records.csv")).toMatchObject({
      applyEligibility: "blocked",
      representation: "background-artifact",
    });
    expect(review.changes.find((change) => change.relpath === "src/app.ts")).toMatchObject({
      sourceChanged: true,
      applyEligibility: "blocked",
    });
    expect(JSON.stringify(review)).not.toContain("Synthetic Name");
    expect(hash("Synthetic Name,90\n")).not.toBe("");
  });

  it("creates a separate immutable snapshot for every agent launch in the same Context", async () => {
    const env = await fixture();
    const common = {
      ...env,
      contextId: `sha256:${"e".repeat(64)}`,
      revisionId: `sha256:${"f".repeat(64)}`,
    };
    const claude = await capturePatchSession({ ...common, sessionId: "claude-session" });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "claude edit\n");
    const codex = await capturePatchSession({ ...common, sessionId: "codex-session" });
    expect(claude.sessionId).not.toBe(codex.sessionId);
    expect(claude.snapshotId).not.toBe(codex.snapshotId);
    expect(claude.snapshot.contextId).toBe(codex.snapshot.contextId);
    expect((await loadPatchSession(env.managedBase, env.runId)).sessionId).toBe("codex-session");
    expect((await reviewPatchSession(claude)).changes).toHaveLength(1);
  });

  it("keeps prior unreviewed changes visible when a new agent session continues", async () => {
    const env = await fixture();
    const common = {
      ...env,
      contextId: `sha256:${"3".repeat(64)}`,
      revisionId: `sha256:${"4".repeat(64)}`,
    };
    const first = await capturePatchSession({ ...common, sessionId: "first", agentId: "claude" });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "first agent edit\n");
    expect((await reviewPatchSession(first)).changes).toHaveLength(1);
    const second = await capturePatchSession({
      ...common,
      sessionId: "second",
      agentId: "codex",
      inheritFromSessionId: first.sessionId,
    });
    expect(second.sessionId).toBe("second");
    expect(second.agentId).toBe("codex");
    expect((await reviewPatchSession(second)).changes).toHaveLength(1);
  });

  it("detects an agent-created symlink as blocked without following it", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "session-symlink",
      contextId: `sha256:${"1".repeat(64)}`,
      revisionId: `sha256:${"2".repeat(64)}`,
    });
    await symlink(env.sourceRoot, path.join(env.preparedRoot, "escape"));
    const review = await reviewPatchSession(state);
    expect(review.changes.find((change) => change.relpath === "escape")).toMatchObject({
      unsafeType: "symlink",
      applyEligibility: "blocked",
    });
    expect(review.changes.flatMap((change) => change.reasonCodes)).toContain("patch-symlink");
    expect(JSON.stringify(review)).not.toContain(env.sourceRoot);
  });

  it("fails closed when a Source file is replaced by a symlink before review", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "source-symlink-replacement",
      contextId: `sha256:${"d".repeat(64)}`,
      revisionId: `sha256:${"e".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "agent edit\n");
    await rm(path.join(env.sourceRoot, "src", "app.ts"));
    await symlink(path.join(env.preparedRoot, "src", "app.ts"), path.join(env.sourceRoot, "src", "app.ts"));

    await expect(reviewPatchSession(state)).rejects.toThrow("patch-symlink");
  });

  it("fails closed when the private baseline is replaced by an escaping symlink", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "baseline-symlink-replacement",
      contextId: `sha256:${"f".repeat(64)}`,
      revisionId: `sha256:${"0".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "agent edit\n");
    const baseline = path.join(state.privateSessionRoot, "prepared-baseline", "src", "app.ts");
    await rm(baseline);
    await symlink(path.join(env.sourceRoot, "src", "app.ts"), baseline);

    await expect(reviewPatchSession(state)).rejects.toThrow("patch-symlink");
  });

  it("blocks Apply when the affected Source file was already Git-dirty at launch", async () => {
    const env = await fixture();
    await execFileAsync("git", ["init", "-q"], { cwd: env.sourceRoot });
    await execFileAsync("git", ["add", "src/app.ts"], { cwd: env.sourceRoot });
    await execFileAsync(
      "git",
      ["-c", "user.name=Yuhi Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline"],
      { cwd: env.sourceRoot },
    );
    await writeFile(path.join(env.sourceRoot, "src", "app.ts"), "uncommitted user edit\n");
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "uncommitted user edit\n");
    const state = await capturePatchSession({
      ...env,
      sessionId: "git-dirty",
      contextId: `sha256:${"5".repeat(64)}`,
      revisionId: `sha256:${"6".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "agent edit\n");
    expect((await reviewPatchSession(state)).changes[0]).toMatchObject({
      applyEligibility: "blocked",
      sourceChanged: true,
    });
  });

  it("trusts private background provenance, not an agent-editable public status file", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "background-provenance",
      contextId: `sha256:${"7".repeat(64)}`,
      revisionId: `sha256:${"8".repeat(64)}`,
    });
    await mkdir(path.join(env.preparedRoot, ".yuhi"), { recursive: true });
    await writeFile(
      path.join(env.preparedRoot, ".yuhi", "background-status.json"),
      JSON.stringify({ items: [{ preparedRelpath: "src/agent-created.ts" }] }),
    );
    await writeFile(path.join(env.preparedRoot, "src", "agent-created.ts"), "safe agent output\n");

    const privateItems = path.join(env.managedBase, ".internal", "background", env.runId, "items");
    await mkdir(privateItems, { recursive: true });
    await writeFile(
      path.join(privateItems, "item.json"),
      JSON.stringify({ status: "completed", preparedRelpath: "docs/generated-summary.md" }),
    );
    await mkdir(path.join(env.preparedRoot, "docs"), { recursive: true });
    await writeFile(path.join(env.preparedRoot, "docs", "generated-summary.md"), "background result\n");

    const review = await reviewPatchSession(state);
    expect(review.changes.find((change) => change.relpath === "src/agent-created.ts"))
      .toMatchObject({ representation: "full" });
    expect(review.changes.some((change) => change.relpath === "docs/generated-summary.md")).toBe(false);
  });

  it("materializes only selected text hunks into a private, rescanned candidate", async () => {
    const env = await fixture();
    const before = ["one", "two", "3", "4", "5", "6", "7", "8", "9", "ten", ""].join("\n");
    const after = ["ONE", "two", "3", "4", "5", "6", "7", "8", "9", "TEN", ""].join("\n");
    await writeFile(path.join(env.sourceRoot, "src", "app.ts"), before);
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), before);
    const state = await capturePatchSession({
      ...env,
      sessionId: "hunks",
      contextId: `sha256:${"9".repeat(64)}`,
      revisionId: `sha256:${"a".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), after);
    const review = await reviewPatchSession(state);
    const hunks = review.hunksByRelpath["src/app.ts"]!;
    expect(hunks).toHaveLength(2);
    const candidate = await materializePatchSelection(
      state,
      review,
      ["src/app.ts"],
      { "src/app.ts": [hunks[0]!.hunkId] },
    );
    const selected = await readFile(path.join(candidate.preparedRoot, "src", "app.ts"), "utf8");
    expect(selected).toContain("ONE\ntwo");
    expect(selected).toContain("9\nten");
    expect(await readFile(path.join(env.sourceRoot, "src", "app.ts"), "utf8")).toBe(before);
  });

  it("rejects a stale review after the Prepared Working Tree changes", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "stale-working-tree",
      contextId: `sha256:${"1".repeat(64)}`,
      revisionId: `sha256:${"2".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "first agent edit\n");
    const review = await reviewPatchSession(state);
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "second agent edit\n");
    await expect(materializePatchSelection(state, review, ["src/app.ts"]))
      .rejects.toThrow("patch-review-stale");
  });

  it("rejects forged snapshot and source-baseline review identities", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "forged-review-identities",
      contextId: `sha256:${"3".repeat(64)}`,
      revisionId: `sha256:${"4".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "agent edit\n");
    const review = await reviewPatchSession(state);
    await expect(materializePatchSelection(
      state,
      { ...review, snapshotId: `sha256:${"f".repeat(64)}` },
      ["src/app.ts"],
    )).rejects.toThrow("patch-review-stale");
    await expect(materializePatchSelection(
      state,
      { ...review, patch: { ...review.patch, sourceBaselineId: `sha256:${"e".repeat(64)}` } },
      ["src/app.ts"],
    )).rejects.toThrow("patch-review-stale");
  });

  it("applies only the selected hunk to the Original Workspace", async () => {
    const env = await fixture();
    const before = ["one", "two", "3", "4", "5", "6", "7", "8", "9", "ten", ""].join("\n");
    const after = ["ONE", "two", "3", "4", "5", "6", "7", "8", "9", "TEN", ""].join("\n");
    await writeFile(path.join(env.sourceRoot, "src", "app.ts"), before);
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), before);
    const state = await capturePatchSession({
      ...env,
      sessionId: "hunk-apply",
      contextId: `sha256:${"b".repeat(64)}`,
      revisionId: `sha256:${"c".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), after);
    const review = await reviewPatchSession(state);
    const hunks = review.hunksByRelpath["src/app.ts"]!;
    const result = await applyPatchSession({
      managedBase: env.managedBase,
      runId: env.runId,
      sessionId: state.sessionId,
      selectedRelpaths: ["src/app.ts"],
      hunkSelections: { "src/app.ts": [hunks[0]!.hunkId] },
      expectedPatchId: review.patch.patchId,
      expectedSnapshotId: review.snapshotId,
      expectedSourceBaselineId: review.patch.sourceBaselineId,
      expectedPreparedWorkingTreeId: review.preparedWorkingTreeId,
    });

    expect(result.status).toBe("applied");
    expect(await readFile(path.join(env.sourceRoot, "src", "app.ts"), "utf8"))
      .toBe(["ONE", "two", "3", "4", "5", "6", "7", "8", "9", "ten", ""].join("\n"));
  });

  it("rejects forged review identities without mutating Source", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "forged-identities",
      contextId: `sha256:${"d".repeat(64)}`,
      revisionId: `sha256:${"e".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "agent edit\n");
    const review = await reviewPatchSession(state);
    const request = {
      managedBase: env.managedBase,
      runId: env.runId,
      sessionId: state.sessionId,
      selectedRelpaths: ["src/app.ts"],
      expectedPatchId: review.patch.patchId,
      expectedSnapshotId: review.snapshotId,
      expectedSourceBaselineId: review.patch.sourceBaselineId,
      expectedPreparedWorkingTreeId: review.preparedWorkingTreeId,
    };
    for (const [key, code] of [
      ["expectedPatchId", "patch-review-stale"],
      ["expectedSnapshotId", "patch-snapshot-stale"],
      ["expectedSourceBaselineId", "patch-source-baseline-stale"],
      ["expectedPreparedWorkingTreeId", "patch-working-tree-stale"],
    ] as const) {
      await expect(applyPatchSession({ ...request, [key]: `sha256:${"0".repeat(64)}` }))
        .rejects.toThrow(code);
    }
    expect(await readFile(path.join(env.sourceRoot, "src", "app.ts"), "utf8"))
      .toBe("export const value = 1;\n");
  });

  it("reconstructs security decisions and rejects caller-forged eligibility metadata", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "forged-eligibility",
      contextId: `sha256:${"f".repeat(64)}`,
      revisionId: `sha256:${"1".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "OPENAI_API_KEY=sk-synthetic-not-real-1234567890\n");
    const review = await reviewPatchSession(state);
    expect(review.changes[0]?.applyEligibility).toBe("blocked");
    const forged = {
      managedBase: env.managedBase,
      runId: env.runId,
      sessionId: state.sessionId,
      selectedRelpaths: ["src/app.ts"],
      expectedPatchId: review.patch.patchId,
      expectedSnapshotId: review.snapshotId,
      expectedSourceBaselineId: review.patch.sourceBaselineId,
      expectedPreparedWorkingTreeId: review.preparedWorkingTreeId,
      changes: [{ relpath: "src/app.ts", applyEligibility: "eligible", risk: "low", reasonCodes: [] }],
    } as Parameters<typeof applyPatchSession>[0] & { changes: unknown[] };
    await expect(applyPatchSession(forged)).rejects.toThrow("patch-selection-ineligible");
    await expect(applyPatchSession({
      ...forged,
      selectedRelpaths: ["src/safe-looking-substitution.ts"],
    })).rejects.toThrow("patch-selection-stale");
    expect(await readFile(path.join(env.sourceRoot, "src", "app.ts"), "utf8"))
      .toBe("export const value = 1;\n");
  });

  it("rejects a Prepared Working Tree changed after review", async () => {
    const env = await fixture();
    const state = await capturePatchSession({
      ...env,
      sessionId: "stale-tree",
      contextId: `sha256:${"2".repeat(64)}`,
      revisionId: `sha256:${"3".repeat(64)}`,
    });
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "first edit\n");
    const review = await reviewPatchSession(state);
    await writeFile(path.join(env.preparedRoot, "src", "app.ts"), "second edit\n");
    await expect(applyPatchSession({
      managedBase: env.managedBase,
      runId: env.runId,
      sessionId: state.sessionId,
      selectedRelpaths: ["src/app.ts"],
      expectedPatchId: review.patch.patchId,
      expectedSnapshotId: review.snapshotId,
      expectedSourceBaselineId: review.patch.sourceBaselineId,
      expectedPreparedWorkingTreeId: review.preparedWorkingTreeId,
    })).rejects.toThrow("patch-working-tree-stale");
    expect(await readFile(path.join(env.sourceRoot, "src", "app.ts"), "utf8"))
      .toBe("export const value = 1;\n");
  });
});
