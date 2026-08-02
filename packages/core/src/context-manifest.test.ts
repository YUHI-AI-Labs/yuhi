import { describe, it, expect } from "vitest";
import { toPublicContextManifest } from "./context-manifest.js";

const CONTEXT_ID = "sha256:" + "a".repeat(64);

function rawManifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    contextId: CONTEXT_ID,
    // Non-deterministic bookkeeping the on-disk manifest keeps — must NOT appear
    // in the public Context Manifest projection.
    runId: "run-xyz",
    createdAt: "2026-07-31T00:00:00.000Z",
    reductionMode: "balanced",
    safetyMode: "strict",
    files: [
      {
        relpath: "src/app.ts",
        action: "allow",
        status: "ok",
        transmission: "approved",
        transformed: false,
      },
      {
        relpath: "secrets.env",
        action: "local-only",
        status: "ok",
        transmission: "blocked",
        omitted: true,
        transformed: false,
      },
      {
        // Defense-in-depth: an absolute path must be dropped from the public export.
        relpath: "/Users/someone/leak.ts",
        action: "allow",
        status: "ok",
        transmission: "approved",
        transformed: false,
      },
    ],
    warnings: { unverifiedFilesIncluded: 2, cleanCategory: 0 },
  };
}

describe("Context Manifest — public projection", () => {
  it("carries the deterministic Context ID and generator identity", () => {
    const m = toPublicContextManifest(rawManifest());
    expect(m.contextId).toBe(CONTEXT_ID);
    expect(m.generator.name).toBe("Yuhi");
    expect(m.policy.safetyMode).toBe("strict");
    expect(m.source.reductionMode).toBe("balanced");
  });

  it("never contains absolute paths, runId, or createdAt", () => {
    const m = toPublicContextManifest(rawManifest());
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("run-xyz");
    expect(serialized).not.toContain("2026-07-31");
    expect(m.files.every((f) => !f.relpath.startsWith("/"))).toBe(true);
    // The absolute-path row was dropped: 3 raw files -> 2 public files.
    expect(m.files).toHaveLength(2);
  });

  it("summarizes excluded files and exposes only content-free warning categories", () => {
    const m = toPublicContextManifest(rawManifest());
    expect(m.summary.excludedFiles).toBe(1);
    expect(m.warnings).toEqual(["unverifiedFilesIncluded"]);
  });

  it("rejects a manifest without a valid Context ID", () => {
    const bad = rawManifest();
    delete bad.contextId;
    expect(() => toPublicContextManifest(bad)).toThrow(/contextId/);
  });

  it("omits progressiveContext when the manifest predates the revision layer (additive)", () => {
    const m = toPublicContextManifest(rawManifest());
    expect("progressiveContext" in m).toBe(false);
    // The base Context ID is unaffected by the (absent) revision layer.
    expect(m.contextId).toBe(CONTEXT_ID);
  });

  it("projects a stored Progressive Context revision without touching the base Context ID", () => {
    const raw = rawManifest();
    raw.progressiveContext = {
      baseContextId: CONTEXT_ID,
      revision: 1,
      revisionId: "sha256:" + "d".repeat(64),
      completedItems: 1,
      pendingItems: 0,
      failedItems: 0,
      updatedAt: "2026-08-01T12:00:00.000Z",
    };
    const m = toPublicContextManifest(raw);
    expect(m.contextId).toBe(CONTEXT_ID);
    expect(m.progressiveContext?.baseContextId).toBe(CONTEXT_ID);
    expect(m.progressiveContext?.revision).toBe(1);
    expect(m.progressiveContext?.revisionId).toBe("sha256:" + "d".repeat(64));
  });
});
