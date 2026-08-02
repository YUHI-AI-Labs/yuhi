import { describe, expect, it } from "vitest";
import type { PatchChange, PatchReviewResult } from "@yuhi/core";
import { agentDiffTargets, renderAgentChangeReviewHtml, selectedApplicableChanges } from "./agent-review.js";

const ID = `sha256:${"a".repeat(64)}`;

function review(change: PatchChange, applyAllowed: boolean): PatchReviewResult {
  const counts = { low: 0, review: 0, high: 0, blocked: 0 };
  counts[change.risk ?? "blocked"] = 1;
  return {
    schemaVersion: 1,
    preparedWorkingTreeId: ID,
    snapshotId: ID,
    patch: {
      schemaVersion: 1,
      patchId: ID,
      contextId: ID,
      revisionId: ID,
      sourceBaselineId: ID,
      changes: [change],
    },
    changes: [change],
    counts,
    applyAllowed,
    hunksByRelpath: {},
    diffsByRelpath: {},
  };
}

describe("agent change review UI", () => {
  it("renders selectable workflow UI without source content", () => {
    const html = renderAgentChangeReviewHtml(review({
      kind: "modified",
      relpath: "src/app.ts",
      representation: "full",
      applyEligibility: "eligible",
      risk: "low",
      reasonCodes: ["patch-modified", "patch-eligible"],
    }, true), "Claude Code");
    expect(html).toContain("Safe Agent Execution");
    expect(html).toContain("Nothing is applied automatically");
    expect(html).toContain("Apply selected");
    expect(html).toContain("Stop Yuhi and Return");
    expect(html).toContain("Choose Another Workspace");
    expect(html).toContain("type=checkbox");
    expect(html).not.toContain("source contents");
  });

  it("shows a metadata-safe blocked secret state", () => {
    const secret = `sk-${"x".repeat(24)}`;
    const html = renderAgentChangeReviewHtml(review({
      kind: "added",
      relpath: "generated.txt",
      representation: "full",
      applyEligibility: "blocked",
      risk: "blocked",
      reasonCodes: ["patch-added", "patch-secret-added"],
    }, false));
    expect(html).toContain("Some changes cannot be applied");
    expect(html).toContain("Generated content contains a secret or credential");
    expect(html).not.toContain(secret);
  });

  it("never embeds diff payloads in the review webview", () => {
    const secret = `sk-${"x".repeat(24)}`;
    const value = review({
      kind: "added", relpath: "generated.txt", representation: "full",
      applyEligibility: "blocked", risk: "blocked", reasonCodes: ["patch-secret-added"],
    }, false);
    value.diffsByRelpath["generated.txt"] = {
      relpath: "generated.txt", before: "", after: secret, maskedCategories: ["secret"],
    };
    expect(renderAgentChangeReviewHtml(value)).not.toContain(secret);
  });

  it("renders newly generated PII as blocked with no selectable override", () => {
    const html = renderAgentChangeReviewHtml(review({
      kind: "modified",
      relpath: "report.txt",
      representation: "full",
      applyEligibility: "blocked",
      risk: "blocked",
      reasonCodes: ["patch-modified", "patch-pii-added"],
    }, false));
    expect(html).toContain("Generated content contains personal information");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Include anyway");
  });

  it("never returns a blocked file from a forged Apply selection", () => {
    const blocked = review({
      kind: "added",
      relpath: ".env",
      representation: "full",
      applyEligibility: "blocked",
      risk: "blocked",
      reasonCodes: ["patch-sensitive-config"],
    }, false);
    expect(selectedApplicableChanges(blocked, [".env"])).toEqual([]);
  });

  it("resolves Open Diff against the immutable Prepared baseline, never Source", () => {
    const change: PatchChange = {
      kind: "renamed",
      relpath: "src/new.ts",
      previousRelpath: "src/old.ts",
      representation: "full",
      applyEligibility: "eligible",
      reasonCodes: ["patch-renamed"],
    };
    expect(agentDiffTargets("/private/session", "/prepared", change)).toEqual({
      baseline: "/private/session/prepared-baseline/src/old.ts",
      agent: "/prepared/src/new.ts",
    });
    expect(JSON.stringify(agentDiffTargets("/private/session", "/prepared", change)))
      .not.toContain("source");
  });

  it("keeps added-file preview agent-only without inventing a Source comparison", () => {
    const change: PatchChange = {
      kind: "added",
      relpath: "src/new.ts",
      representation: "full",
      applyEligibility: "eligible",
      reasonCodes: ["patch-added"],
    };
    expect(agentDiffTargets("/private/session", "/prepared", change)).toEqual({
      agent: "/prepared/src/new.ts",
    });
  });

  it("explains provenance blocking for Yuhi-transformed artifacts", () => {
    const html = renderAgentChangeReviewHtml(review({
      kind: "modified",
      relpath: "records.csv",
      representation: "background-artifact",
      applyEligibility: "blocked",
      risk: "blocked",
      reasonCodes: ["patch-modified", "patch-background-artifact"],
    }, false));
    expect(html).toContain("Yuhi-generated context cannot be applied");
    expect(html).toContain("disabled");
  });

  it("renders a bounded summary and selectable rows for 1,000 changed files", () => {
    const base = review({
      kind: "modified",
      relpath: "src/0.ts",
      representation: "full",
      applyEligibility: "eligible",
      risk: "low",
      reasonCodes: ["patch-modified", "patch-eligible"],
    }, true);
    base.changes = Array.from({ length: 1_000 }, (_, index) => ({
      ...base.changes[0]!,
      relpath: `src/${index}.ts`,
    }));
    base.patch.changes = base.changes;
    base.counts.low = 1_000;
    const html = renderAgentChangeReviewHtml(base);
    expect(html).toContain("src/999.ts");
    expect(html).toContain("Low risk: ");
    expect((html.match(/class=pick/g) ?? [])).toHaveLength(1);
  });

  it("renders hunk selectors and posts the selected hunk identities", () => {
    const data = review({
      kind: "modified",
      relpath: "src/app.ts",
      representation: "full",
      applyEligibility: "eligible",
      risk: "low",
      reasonCodes: ["patch-modified", "patch-eligible"],
    }, true);
    data.hunksByRelpath["src/app.ts"] = [
      { hunkId: `sha256:${"1".repeat(64)}`, beforeStart: 1, beforeCount: 1, afterStart: 1, afterCount: 1 },
      { hunkId: `sha256:${"2".repeat(64)}`, beforeStart: 20, beforeCount: 2, afterStart: 20, afterCount: 2 },
    ];
    const html = renderAgentChangeReviewHtml(data);
    expect(html).toContain("Select hunks");
    expect(html).toContain("hunkSelections:hunkSelections()");
    expect(html).not.toContain("replacementLines");
  });
});
