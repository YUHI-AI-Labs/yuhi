import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";

import {
  computeRevisionId,
  canonicalizeRevisionIdInput,
  reduceProgressiveContextState,
  toPublicProgressiveContextState,
  isRevisionId,
  type DeliveredFile,
} from "./revision.js";
import type {
  PublicBackgroundItem,
  BackgroundPreparationStatus,
} from "./types.js";

const BASE_CONTEXT_ID = "sha256:" + "a".repeat(64);

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const BASE_FILES: DeliveredFile[] = [
  { relpath: "src/app.ts", sha256: hash("app") },
  { relpath: "README.md", sha256: hash("readme") },
];

let itemSeq = 0;
function item(
  status: BackgroundPreparationStatus,
  overrides: Partial<PublicBackgroundItem> = {},
): PublicBackgroundItem {
  itemSeq += 1;
  return {
    itemId: overrides.itemId ?? `item-${itemSeq}`,
    runId: "run-1",
    contextId: BASE_CONTEXT_ID,
    relpath: overrides.relpath ?? `docs/source-${itemSeq}.pdf`,
    kind: "document-extraction",
    priority: 0,
    createdAt: 0,
    status,
    ...overrides,
  };
}

describe("computeRevisionId — determinism & exclusions", () => {
  it("is `sha256:<64 hex>` and passes isRevisionId", () => {
    const id = computeRevisionId({ files: BASE_FILES });
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isRevisionId(id)).toBe(true);
  });

  it("same delivered file-set ⇒ byte-identical revisionId (order-independent)", () => {
    const a = computeRevisionId({ files: BASE_FILES });
    const b = computeRevisionId({ files: [...BASE_FILES].reverse() });
    expect(a).toBe(b);
  });

  it("normalizes `sha256:`-prefixed and bare-hex content hashes identically", () => {
    const bare = computeRevisionId({ files: [{ relpath: "a.ts", sha256: hash("x") }] });
    const prefixed = computeRevisionId({
      files: [{ relpath: "a.ts", sha256: "SHA256:" + hash("x").toUpperCase() }],
    });
    expect(bare).toBe(prefixed);
  });

  it("changes when a delivered file's content changes", () => {
    const before = computeRevisionId({ files: BASE_FILES });
    const after = computeRevisionId({
      files: [
        { relpath: "src/app.ts", sha256: hash("app-v2") },
        { relpath: "README.md", sha256: hash("readme") },
      ],
    });
    expect(after).not.toBe(before);
  });

  it("canonical form carries NO time / machine / user / abspath / agent id", () => {
    const canon = canonicalizeRevisionIdInput({
      files: [{ relpath: "docs/report.txt", sha256: hash("companion") }],
    });
    expect(canon).not.toContain("/Users/"); // no absolute path
    expect(canon).not.toMatch(/T\d\d:\d\d/); // no ISO timestamp
    expect(canon).not.toContain("run-");
    expect(canon).not.toContain("sess");
    // Only the whitelisted keys appear.
    expect(canon).toContain("canonicalization");
    expect(canon).toContain("relpath");
    expect(canon).toContain("sha256");
  });
});

describe("reduceProgressiveContextState — immutable base id + revision rules", () => {
  const fixedNow = () => new Date("2026-08-01T12:00:00.000Z");

  it("base contextId is identical before and after background completion", () => {
    const before = reduceProgressiveContextState({
      baseContextId: BASE_CONTEXT_ID,
      basePreparedFiles: BASE_FILES,
      backgroundItems: [item("pending"), item("processing")],
      now: fixedNow,
    });
    const after = reduceProgressiveContextState({
      baseContextId: BASE_CONTEXT_ID,
      basePreparedFiles: BASE_FILES,
      backgroundItems: [
        item("completed", { relpath: "docs/a.pdf", preparedRelpath: "docs/a.pdf.txt" }),
      ],
      publishedArtifactHashes: { "docs/a.pdf.txt": hash("companion-a") },
      now: fixedNow,
    });
    expect(before.baseContextId).toBe(BASE_CONTEXT_ID);
    expect(after.baseContextId).toBe(BASE_CONTEXT_ID);
    expect(after.baseContextId).toBe(before.baseContextId);
  });

  it("revision starts at 0 at prepare (no completed items)", () => {
    const state = reduceProgressiveContextState({
      baseContextId: BASE_CONTEXT_ID,
      basePreparedFiles: BASE_FILES,
      backgroundItems: [],
      now: fixedNow,
    });
    expect(state.revision).toBe(0);
    expect(state.completedItems).toBe(0);
  });

  it("revision increments when a safe artifact is published", () => {
    const state = reduceProgressiveContextState({
      baseContextId: BASE_CONTEXT_ID,
      basePreparedFiles: BASE_FILES,
      backgroundItems: [
        item("completed", { preparedRelpath: "docs/a.txt" }),
        item("completed", { preparedRelpath: "docs/b.txt" }),
      ],
      publishedArtifactHashes: { "docs/a.txt": hash("a"), "docs/b.txt": hash("b") },
      now: fixedNow,
    });
    expect(state.revision).toBe(2);
    expect(state.completedItems).toBe(2);
  });

  it("a failed / kept-local / cancelled / timed-out item does NOT bump the revision", () => {
    const unpublished: BackgroundPreparationStatus[] = [
      "failed",
      "kept-local",
      "cancelled",
      "timed-out",
    ];
    for (const status of unpublished) {
      const state = reduceProgressiveContextState({
        baseContextId: BASE_CONTEXT_ID,
        basePreparedFiles: BASE_FILES,
        backgroundItems: [item(status, { preparedRelpath: undefined })],
        now: fixedNow,
      });
      expect(state.revision, status).toBe(0);
      expect(state.completedItems, status).toBe(0);
      expect(state.failedItems, status).toBe(1);
      // revisionId equals the base-only revisionId — no artifact was delivered.
      expect(state.revisionId).toBe(computeRevisionId({ files: BASE_FILES }));
    }
  });

  it("counts pending/processing as pending; unpublished terminals as failed", () => {
    const state = reduceProgressiveContextState({
      baseContextId: BASE_CONTEXT_ID,
      basePreparedFiles: BASE_FILES,
      backgroundItems: [
        item("pending"),
        item("processing"),
        item("completed", { preparedRelpath: "docs/c.txt" }),
        item("failed"),
        item("kept-local"),
      ],
      publishedArtifactHashes: { "docs/c.txt": hash("c") },
      now: fixedNow,
    });
    expect(state.pendingItems).toBe(2);
    expect(state.completedItems).toBe(1);
    expect(state.failedItems).toBe(2);
  });

  it("revisionId is invariant across time (updatedAt is NOT part of it)", () => {
    const args = {
      baseContextId: BASE_CONTEXT_ID,
      basePreparedFiles: BASE_FILES,
      backgroundItems: [item("completed", { preparedRelpath: "docs/x.txt" })],
      publishedArtifactHashes: { "docs/x.txt": hash("x") },
    };
    const t1 = reduceProgressiveContextState({ ...args, now: () => new Date("2020-01-01T00:00:00Z") });
    const t2 = reduceProgressiveContextState({ ...args, now: () => new Date("2099-12-31T23:59:59Z") });
    expect(t1.updatedAt).not.toBe(t2.updatedAt);
    expect(t1.revisionId).toBe(t2.revisionId);
  });

  it("SAME baseContextId + revisionId for Claude and Codex from the same delivered set", () => {
    // Two different agents, two different runIds/itemIds — but the SAME delivered
    // file-set (same base files + same published artifact content) must yield the
    // same base id AND the same revisionId.
    const publishedHashes = { "docs/report.txt": hash("verified-companion") };

    const claude = reduceProgressiveContextState({
      baseContextId: BASE_CONTEXT_ID,
      basePreparedFiles: BASE_FILES,
      backgroundItems: [
        item("completed", {
          itemId: "claude-item",
          runId: "claude-run",
          relpath: "docs/report.pdf",
          preparedRelpath: "docs/report.txt",
        }),
      ],
      publishedArtifactHashes: publishedHashes,
      now: () => new Date("2026-08-01T00:00:00Z"),
    });

    const codex = reduceProgressiveContextState({
      baseContextId: BASE_CONTEXT_ID,
      basePreparedFiles: [...BASE_FILES].reverse(),
      backgroundItems: [
        item("completed", {
          itemId: "codex-item",
          runId: "codex-run",
          relpath: "docs/report.pdf",
          preparedRelpath: "docs/report.txt",
        }),
      ],
      publishedArtifactHashes: publishedHashes,
      now: () => new Date("2027-05-05T05:05:05Z"),
    });

    expect(codex.baseContextId).toBe(claude.baseContextId);
    expect(codex.revisionId).toBe(claude.revisionId);
    expect(codex.revision).toBe(claude.revision);
  });

  it("revisionId is invariant to machine / username / agent id (none participate)", () => {
    // Machine/user/agent identity is simply never an input to the reducer; a
    // revisionId derived from the same delivered set cannot change with them.
    const base = reduceProgressiveContextState({
      baseContextId: BASE_CONTEXT_ID,
      basePreparedFiles: BASE_FILES,
      backgroundItems: [item("completed", { preparedRelpath: "d.txt" })],
      publishedArtifactHashes: { "d.txt": hash("d") },
      now: () => new Date("2026-08-01T00:00:00Z"),
    });
    // Recompute the delivered-set revisionId directly (agent-free) and compare.
    const direct = computeRevisionId({
      files: [...BASE_FILES, { relpath: "d.txt", sha256: hash("d") }],
    });
    expect(base.revisionId).toBe(direct);
  });

  it("determinism: same inputs ⇒ byte-identical revisionId", () => {
    const mk = () =>
      reduceProgressiveContextState({
        baseContextId: BASE_CONTEXT_ID,
        basePreparedFiles: BASE_FILES,
        backgroundItems: [
          item("completed", { itemId: "i1", preparedRelpath: "one.txt" }),
          item("completed", { itemId: "i2", preparedRelpath: "two.txt" }),
        ],
        publishedArtifactHashes: { "one.txt": hash("1"), "two.txt": hash("2") },
        now: () => new Date("2026-08-01T00:00:00Z"),
      });
    expect(mk().revisionId).toBe(mk().revisionId);
  });
});

describe("toPublicProgressiveContextState — public projector", () => {
  it("whitelists fields and carries no absolute path", () => {
    const state = reduceProgressiveContextState({
      baseContextId: BASE_CONTEXT_ID,
      basePreparedFiles: BASE_FILES,
      backgroundItems: [item("completed", { preparedRelpath: "p.txt" })],
      publishedArtifactHashes: { "p.txt": hash("p") },
    });
    const raw = { ...state, workingDirectory: "/Users/someone/prepared", machine: "host-1" };
    const projected = toPublicProgressiveContextState(raw)!;
    expect(projected.baseContextId).toBe(BASE_CONTEXT_ID);
    expect(projected.revisionId).toBe(state.revisionId);
    expect(JSON.stringify(projected)).not.toContain("/Users/");
    expect(JSON.stringify(projected)).not.toContain("host-1");
  });

  it("returns undefined when base id or revisionId is invalid", () => {
    expect(toPublicProgressiveContextState({})).toBeUndefined();
    expect(
      toPublicProgressiveContextState({ baseContextId: BASE_CONTEXT_ID, revisionId: "nope" }),
    ).toBeUndefined();
  });
});
