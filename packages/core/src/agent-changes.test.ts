import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  applyAgentChanges,
  captureAgentChangeBaseline,
  reviewAgentChanges,
  writeAgentApplyAudit,
} from "./agent-changes.js";

const roots: string[] = [];

async function fixture(): Promise<{ root: string; original: string; prepared: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "yuhi-agent-changes-"));
  roots.push(root);
  const original = path.join(root, "original");
  const prepared = path.join(root, "prepared");
  await mkdir(path.join(original, "src"), { recursive: true });
  await mkdir(path.join(prepared, "src"), { recursive: true });
  await writeFile(path.join(original, "src", "app.ts"), "export const value = 1;\n");
  await writeFile(path.join(prepared, "src", "app.ts"), "export const value = 1;\n");
  await writeFile(path.join(prepared, "manifest.json"), JSON.stringify({
    schemaVersion: 2,
    runId: "run-safe",
    files: [{
      relpath: "src/app.ts",
      action: "allow",
      status: "ok",
      outcome: "included-unchanged",
      transformed: false,
      transformations: [],
    }],
  }));
  return { root, original, prepared };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent change workflow", () => {
  it("detects, scans, and explicitly applies safe changes", async () => {
    const f = await fixture();
    const baseline = await captureAgentChangeBaseline("run-safe", f.prepared, f.original);
    await writeFile(path.join(f.prepared, "src", "app.ts"), "export const value = 2;\n");
    await writeFile(path.join(f.prepared, "README.md"), "Synthetic output.\n");

    const review = await reviewAgentChanges(baseline, f.prepared, f.original);
    expect(review.changes.map((change) => [change.kind, change.relpath])).toEqual([
      ["created", "README.md"],
      ["modified", "src/app.ts"],
    ]);
    expect(review.security.safe).toBe(true);
    expect(review.applyAllowed).toBe(true);
    expect(await readFile(path.join(f.original, "src", "app.ts"), "utf8"))
      .toBe("export const value = 1;\n");

    const result = await applyAgentChanges(baseline, f.prepared, f.original);
    expect(result.audit.applyResult).toBe("applied");
    expect(await readFile(path.join(f.original, "src", "app.ts"), "utf8"))
      .toBe("export const value = 2;\n");
    expect(await readFile(path.join(f.original, "README.md"), "utf8")).toBe("Synthetic output.\n");
  });

  it("blocks a generated secret without exposing it in review or audit", async () => {
    const f = await fixture();
    const baseline = await captureAgentChangeBaseline("run-secret", f.prepared, f.original);
    const secret = `sk-${"x".repeat(24)}`;
    await writeFile(path.join(f.prepared, "generated.txt"), `API_KEY=${secret}\n`);

    const result = await applyAgentChanges(baseline, f.prepared, f.original);
    expect(result.review.applyAllowed).toBe(false);
    expect(result.review.blockers).toContain("sensitive-output");
    expect(result.audit.applyResult).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(existsSync(path.join(f.original, "generated.txt"))).toBe(false);

    const auditPath = path.join(f.root, "audit", "agent.jsonl");
    await writeAgentApplyAudit(auditPath, result.audit);
    expect(await readFile(auditPath, "utf8")).not.toContain(secret);
  });

  it("blocks a short synthetic API-key assignment in an env-suffixed file", async () => {
    const f = await fixture();
    const baseline = await captureAgentChangeBaseline("run-short-secret", f.prepared, f.original);
    const syntheticValue = ["sk", "test", "value"].join("-");
    await writeFile(
      path.join(f.prepared, "test.env"),
      `API_KEY=${syntheticValue}\n`,
    );
    const review = await reviewAgentChanges(baseline, f.prepared, f.original);
    expect(review.applyAllowed).toBe(false);
    expect(review.blockers).toContain("sensitive-output");
    expect(review.security.findingCounts["credential-assignment"]).toBe(1);
    expect(JSON.stringify(review)).not.toContain(syntheticValue);
  });

  it("blocks apply when the original changed after preparation", async () => {
    const f = await fixture();
    const baseline = await captureAgentChangeBaseline("run-conflict", f.prepared, f.original);
    await writeFile(path.join(f.prepared, "src", "app.ts"), "export const value = 2;\n");
    await writeFile(path.join(f.original, "src", "app.ts"), "export const value = 99;\n");

    const result = await applyAgentChanges(baseline, f.prepared, f.original);
    expect(result.review.blockers).toContain("original-conflict");
    expect(result.audit.applyResult).toBe("blocked");
    expect(await readFile(path.join(f.original, "src", "app.ts"), "utf8"))
      .toBe("export const value = 99;\n");
  });

  it("tracks deletes and deterministic renames", async () => {
    const f = await fixture();
    await writeFile(path.join(f.original, "old.txt"), "rename me\n");
    await writeFile(path.join(f.prepared, "old.txt"), "rename me\n");
    const baseline = await captureAgentChangeBaseline("run-rename", f.prepared, f.original);
    await writeFile(path.join(f.prepared, "new.txt"), "rename me\n");
    await rm(path.join(f.prepared, "old.txt"));
    await rm(path.join(f.prepared, "src", "app.ts"));

    const review = await reviewAgentChanges(baseline, f.prepared, f.original);
    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "renamed", previousRelpath: "old.txt", relpath: "new.txt" }),
      expect.objectContaining({ kind: "deleted", relpath: "src/app.ts" }),
    ]));
  });

  it("blocks reverse application of edits to pseudonymized files", async () => {
    const f = await fixture();
    await writeFile(path.join(f.prepared, "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      runId: "run-transformed",
      files: [{
        relpath: "src/app.ts",
        action: "summarize",
        status: "ok",
        outcome: "included-transformed",
        transformed: true,
        transformations: ["pseudonymized"],
      }],
    }));
    const baseline = await captureAgentChangeBaseline("run-transformed", f.prepared, f.original);
    await writeFile(path.join(f.prepared, "src", "app.ts"), "export const value = 2;\n");

    const review = await reviewAgentChanges(baseline, f.prepared, f.original);
    expect(review.blockers).toContain("ineligible-provenance");
    expect(review.applyAllowed).toBe(false);
  });

  it.each([
    ["absolute", "/tmp/outside.txt"],
    ["parent traversal", "../outside.txt"],
    ["nested traversal", "src/../../outside.txt"],
    ["Windows absolute", "C:\\outside.txt"],
  ])("rejects %s paths from a tampered baseline", async (_label, relpath) => {
    const f = await fixture();
    const baseline = await captureAgentChangeBaseline("run-path", f.prepared, f.original);
    baseline.files[0]!.relpath = relpath;
    const review = await reviewAgentChanges(baseline, f.prepared, f.original);
    expect(review.applyAllowed).toBe(false);
    expect(review.blockers).toContain("unsafe-path");
  });

  it("rejects a prepared symlink escape without reading its target", async () => {
    const f = await fixture();
    const baseline = await captureAgentChangeBaseline("run-symlink", f.prepared, f.original);
    const outside = path.join(f.root, "outside.txt");
    await writeFile(outside, "outside remains untouched\n");
    await symlink(outside, path.join(f.prepared, "escape.txt"));
    const review = await reviewAgentChanges(baseline, f.prepared, f.original);
    expect(review.applyAllowed).toBe(false);
    expect(review.blockers).toContain("unsafe-path");
    expect(await readFile(outside, "utf8")).toBe("outside remains untouched\n");
  });

  it("rejects Yuhi internal metadata changes", async () => {
    const f = await fixture();
    const baseline = await captureAgentChangeBaseline("run-metadata", f.prepared, f.original);
    await writeFile(path.join(f.prepared, "manifest.json"), JSON.stringify({ changed: true }));
    const review = await reviewAgentChanges(baseline, f.prepared, f.original);
    expect(review.applyAllowed).toBe(false);
    expect(review.blockers).toContain("internal-metadata-change");
  });

  it("does not infer ambiguous same-hash renames", async () => {
    const f = await fixture();
    for (const name of ["old-a.txt", "old-b.txt"]) {
      await writeFile(path.join(f.original, name), "same\n");
      await writeFile(path.join(f.prepared, name), "same\n");
    }
    const baseline = await captureAgentChangeBaseline("run-ambiguous", f.prepared, f.original);
    await rm(path.join(f.prepared, "old-a.txt"));
    await rm(path.join(f.prepared, "old-b.txt"));
    await writeFile(path.join(f.prepared, "new-a.txt"), "same\n");
    await writeFile(path.join(f.prepared, "new-b.txt"), "same\n");
    const review = await reviewAgentChanges(baseline, f.prepared, f.original);
    expect(review.changes.filter((change) => change.kind === "renamed")).toHaveLength(0);
    expect(review.changes.filter((change) => change.kind === "created")).toHaveLength(2);
    expect(review.changes.filter((change) => change.kind === "deleted")).toHaveLength(2);
  });

  it("rolls back every completed mutation after a halfway failure", async () => {
    const f = await fixture();
    await writeFile(path.join(f.original, "second.txt"), "before second\n");
    await writeFile(path.join(f.prepared, "second.txt"), "before second\n");
    const baseline = await captureAgentChangeBaseline("run-halfway", f.prepared, f.original);
    await writeFile(path.join(f.prepared, "src", "app.ts"), "export const value = 2;\n");
    await writeFile(path.join(f.prepared, "second.txt"), "after second\n");
    const recoveryBase = path.join(f.root, "recovery");
    const result = await applyAgentChanges(baseline, f.prepared, f.original, {
      recoveryBase,
      beforeMutation: (_change, index) => {
        if (index === 1) throw new Error("synthetic failure");
      },
    });
    expect(result.audit.applyResult).toBe("failed-restored");
    expect(await readFile(path.join(f.original, "src", "app.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    expect(await readFile(path.join(f.original, "second.txt"), "utf8")).toBe("before second\n");
  });

  it("rolls back after final verification failure and never reports success", async () => {
    const f = await fixture();
    const baseline = await captureAgentChangeBaseline("run-final", f.prepared, f.original);
    await writeFile(path.join(f.prepared, "src", "app.ts"), "export const value = 2;\n");
    const result = await applyAgentChanges(baseline, f.prepared, f.original, {
      recoveryBase: path.join(f.root, "recovery"),
      beforeFinalVerification: () => {
        throw new Error("synthetic final verification failure");
      },
    });
    expect(result.audit.applyResult).toBe("failed-restored");
    expect(await readFile(path.join(f.original, "src", "app.ts"), "utf8"))
      .toBe("export const value = 1;\n");
  });

  it.each(["create", "modify", "delete", "rename"] as const)(
    "restores the Original Workspace after a failure during %s",
    async (operation) => {
      const f = await fixture();
      if (operation === "delete" || operation === "rename") {
        await writeFile(path.join(f.original, "old.txt"), "old bytes\n");
        await writeFile(path.join(f.prepared, "old.txt"), "old bytes\n");
      }
      const baseline = await captureAgentChangeBaseline(`run-${operation}`, f.prepared, f.original);
      if (operation === "create") {
        await writeFile(path.join(f.prepared, "created.txt"), "created bytes\n");
      } else if (operation === "modify") {
        await writeFile(path.join(f.prepared, "src", "app.ts"), "export const value = 2;\n");
      } else if (operation === "delete") {
        await rm(path.join(f.prepared, "old.txt"));
      } else {
        await writeFile(path.join(f.prepared, "renamed.txt"), "old bytes\n");
        await rm(path.join(f.prepared, "old.txt"));
      }
      const result = await applyAgentChanges(baseline, f.prepared, f.original, {
        recoveryBase: path.join(f.root, "recovery"),
        afterMutation: () => {
          throw new Error("synthetic post-mutation failure");
        },
      });
      expect(result.audit.applyResult).toBe("failed-restored");
      expect(await readFile(path.join(f.original, "src", "app.ts"), "utf8"))
        .toBe("export const value = 1;\n");
      if (operation === "create") {
        expect(existsSync(path.join(f.original, "created.txt"))).toBe(false);
      }
      if (operation === "delete" || operation === "rename") {
        expect(await readFile(path.join(f.original, "old.txt"), "utf8")).toBe("old bytes\n");
      }
      if (operation === "rename") {
        expect(existsSync(path.join(f.original, "renamed.txt"))).toBe(false);
      }
    },
  );

  it("applies a reviewed deletion transactionally", async () => {
    const f = await fixture();
    const baseline = await captureAgentChangeBaseline("run-delete", f.prepared, f.original);
    await rm(path.join(f.prepared, "src", "app.ts"));
    const result = await applyAgentChanges(baseline, f.prepared, f.original, {
      recoveryBase: path.join(f.root, "recovery"),
    });
    expect(result.audit.applyResult).toBe("applied");
    expect(existsSync(path.join(f.original, "src", "app.ts"))).toBe(false);
  });

  it("blocks a symlink replacement introduced after review", async () => {
    const f = await fixture();
    const baseline = await captureAgentChangeBaseline("run-toctou", f.prepared, f.original);
    await writeFile(path.join(f.prepared, "src", "app.ts"), "export const value = 2;\n");
    const outside = path.join(f.root, "outside.txt");
    await writeFile(outside, "outside\n");
    const result = await applyAgentChanges(baseline, f.prepared, f.original, {
      recoveryBase: path.join(f.root, "recovery"),
      beforeMutation: async () => {
        await rm(path.join(f.original, "src", "app.ts"));
        await symlink(outside, path.join(f.original, "src", "app.ts"));
      },
    });
    expect(result.audit.applyResult).toBe("recovery-required");
    expect(result.recoveryPath).toBeTruthy();
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });

  it("survives extension-host style JSON persistence before review", async () => {
    const f = await fixture();
    const captured = await captureAgentChangeBaseline("run-restart", f.prepared, f.original);
    const restored = JSON.parse(JSON.stringify(captured));
    await writeFile(path.join(f.prepared, "src", "app.ts"), "export const value = 2;\n");
    const review = await reviewAgentChanges(restored, f.prepared, f.original);
    expect(review.applyAllowed).toBe(true);
    expect(review.changes).toHaveLength(1);
  });
});
