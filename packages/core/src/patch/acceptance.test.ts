import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyPatchAtomically, undoPatch, type AtomicPatchChange } from "./apply.js";
import { capturePatchSession, reviewPatchSession } from "./session.js";
import { applyPatchSession } from "./trusted-apply.js";

const roots: string[] = [];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture(
  files: Record<string, string> = { "src/app.ts": "export const value = 1;\n" },
  manifestFiles?: unknown[],
) {
  const root = await mkdtemp(path.join(tmpdir(), "yuhi-patch-acceptance-"));
  roots.push(root);
  const managedBase = path.join(root, "managed");
  const runId = "synthetic-run";
  const preparedRoot = path.join(managedBase, runId);
  const sourceRoot = path.join(root, "source");
  for (const [relpath, contents] of Object.entries(files)) {
    for (const directory of [sourceRoot, preparedRoot]) {
      await mkdir(path.dirname(path.join(directory, relpath)), { recursive: true });
      await writeFile(path.join(directory, relpath), contents);
    }
  }
  await writeFile(path.join(preparedRoot, "manifest.json"), JSON.stringify({
    schemaVersion: 2,
    files: manifestFiles ?? Object.keys(files).map((relpath) => ({
      relpath,
      contextRepresentation: "full",
    })),
  }));
  return { root, managedBase, runId, preparedRoot, sourceRoot };
}

async function session(
  env: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  agentId: "claude" | "codex" = "claude",
) {
  return capturePatchSession({
    ...env,
    sessionId,
    agentId,
    contextId: `sha256:${"a".repeat(64)}`,
    revisionId: `sha256:${"b".repeat(64)}`,
  });
}

function trustedRequest(
  env: Awaited<ReturnType<typeof fixture>>,
  state: Awaited<ReturnType<typeof session>>,
  review: Awaited<ReturnType<typeof reviewPatchSession>>,
  selectedRelpaths: string[],
) {
  return {
    managedBase: env.managedBase,
    runId: env.runId,
    sessionId: state.sessionId,
    selectedRelpaths,
    expectedPatchId: review.patch.patchId,
    expectedSnapshotId: review.snapshotId,
    expectedSourceBaselineId: review.patch.sourceBaselineId,
    expectedPreparedWorkingTreeId: review.preparedWorkingTreeId,
  };
}

function atomicChange(relpath: string, before: string, after: string): AtomicPatchChange {
  return {
    relpath,
    kind: "modified",
    beforeHash: sha256(before),
    afterHash: sha256(after),
    beforeSizeBytes: Buffer.byteLength(before),
    afterSizeBytes: Buffer.byteLength(after),
    representation: "full",
    applyEligibility: "eligible",
    reasonCodes: [],
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("v0.3.6 synthetic filesystem acceptance", () => {
  it("A: reviews, applies, and transactionally undoes a normal full-representation edit", async () => {
    const env = await fixture();
    const state = await session(env, "claude-normal");
    await writeFile(path.join(env.preparedRoot, "src/app.ts"), "export const value = 2;\n");
    const review = await reviewPatchSession(state, { id: "claude" });

    const applied = await applyPatchSession(trustedRequest(env, state, review, ["src/app.ts"]));
    expect(applied).toMatchObject({ status: "applied", applied: ["src/app.ts"] });
    expect(await readFile(path.join(env.sourceRoot, "src/app.ts"), "utf8"))
      .toBe("export const value = 2;\n");

    const undone = await undoPatch(path.join(env.managedBase, ".internal"), applied.patchId);
    expect(undone).toMatchObject({ status: "undone", applied: ["src/app.ts"] });
    expect(await readFile(path.join(env.sourceRoot, "src/app.ts"), "utf8"))
      .toBe("export const value = 1;\n");
  });

  it("B: blocks Apply when Source changes after the private baseline was captured", async () => {
    const env = await fixture();
    const state = await session(env, "source-conflict");
    await writeFile(path.join(env.preparedRoot, "src/app.ts"), "agent edit\n");
    await writeFile(path.join(env.sourceRoot, "src/app.ts"), "user edit\n");
    const review = await reviewPatchSession(state);

    expect(review.changes[0]).toMatchObject({
      relpath: "src/app.ts",
      sourceChanged: true,
      applyEligibility: "blocked",
    });
    await expect(applyPatchSession(trustedRequest(env, state, review, ["src/app.ts"])))
      .rejects.toThrow("patch-selection-ineligible");
    expect(await readFile(path.join(env.sourceRoot, "src/app.ts"), "utf8")).toBe("user edit\n");
  });

  it("C: refuses a compressed prepared representation at the trusted Apply boundary", async () => {
    const env = await fixture(
      { "docs/summary.md": "compressed baseline\n" },
      [{ relpath: "docs/summary.md", contextRepresentation: "compressed" }],
    );
    const state = await session(env, "compressed-block");
    await writeFile(path.join(env.preparedRoot, "docs/summary.md"), "agent changed summary\n");
    const review = await reviewPatchSession(state);

    expect(review.changes[0]).toMatchObject({
      representation: "compressed",
      applyEligibility: "blocked",
    });
    await expect(applyPatchSession(trustedRequest(env, state, review, ["docs/summary.md"])))
      .rejects.toThrow("patch-selection-ineligible");
    expect(await readFile(path.join(env.sourceRoot, "docs/summary.md"), "utf8"))
      .toBe("compressed baseline\n");
  });

  it("D: blocks a generated secret even when caller metadata is forged and exposes no value", async () => {
    const env = await fixture();
    const state = await session(env, "secret-block");
    const syntheticSecret = "sk-synthetic-acceptance-not-real-1234567890";
    await writeFile(path.join(env.preparedRoot, "src/app.ts"), `API_KEY=${syntheticSecret}\n`);
    const review = await reviewPatchSession(state);
    const serializedReview = JSON.stringify(review);

    expect(review.changes[0]?.applyEligibility).toBe("blocked");
    expect(serializedReview).not.toContain(syntheticSecret);
    const forged = {
      ...trustedRequest(env, state, review, ["src/app.ts"]),
      changes: [{ relpath: "src/app.ts", applyEligibility: "eligible", risk: "low" }],
    } as Parameters<typeof applyPatchSession>[0] & { changes: unknown[] };
    await expect(applyPatchSession(forged)).rejects.toThrow("patch-selection-ineligible");
    expect(await readFile(path.join(env.sourceRoot, "src/app.ts"), "utf8"))
      .toBe("export const value = 1;\n");
  });

  it("E: rolls back both files after a deterministic failure during the second mutation", async () => {
    const env = await fixture({ "a.txt": "a-old\n", "b.txt": "b-old\n" });
    await writeFile(path.join(env.preparedRoot, "a.txt"), "a-new\n");
    await writeFile(path.join(env.preparedRoot, "b.txt"), "b-new\n");

    const result = await applyPatchAtomically({
      sourceRoot: env.sourceRoot,
      preparedRoot: env.preparedRoot,
      privateRoot: path.join(env.managedBase, ".internal"),
      patchId: "synthetic-mid-apply-failure",
      changes: [
        atomicChange("a.txt", "a-old\n", "a-new\n"),
        atomicChange("b.txt", "b-old\n", "b-new\n"),
      ],
      testHooks: {
        afterDestinationWrite: (_change, index) => {
          if (index === 1) throw new Error("synthetic-fault");
        },
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      rolledBack: ["b.txt", "a.txt"],
      recoveryRequired: false,
    });
    expect(await readFile(path.join(env.sourceRoot, "a.txt"), "utf8")).toBe("a-old\n");
    expect(await readFile(path.join(env.sourceRoot, "b.txt"), "utf8")).toBe("b-old\n");
    expect(JSON.stringify(result)).not.toContain(env.sourceRoot);
  });

  it("F: separates Claude and Codex sessions while preserving earlier unreviewed changes", async () => {
    const env = await fixture();
    const claude = await session(env, "claude-session", "claude");
    await writeFile(path.join(env.preparedRoot, "src/app.ts"), "claude unreviewed edit\n");
    const claudeReview = await reviewPatchSession(claude, { id: "claude" });

    const codex = await capturePatchSession({
      ...env,
      sessionId: "codex-session",
      agentId: "codex",
      contextId: claude.snapshot.contextId,
      revisionId: claude.snapshot.revisionId,
      inheritFromSessionId: claude.sessionId,
    });
    const codexReview = await reviewPatchSession(codex, { id: "codex" });

    expect(codex.sessionId).not.toBe(claude.sessionId);
    expect(codex.snapshotId).toBe(claude.snapshotId);
    expect(claudeReview.changes.map((change) => change.relpath)).toEqual(["src/app.ts"]);
    expect(codexReview.changes.map((change) => change.relpath)).toEqual(["src/app.ts"]);
    expect(codexReview.patch).toMatchObject({
      agentSessionId: "codex-session",
      agentId: "codex",
    });
    expect(JSON.stringify(codexReview)).not.toContain(env.sourceRoot);
  });
});
