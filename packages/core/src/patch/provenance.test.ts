import { describe, expect, it } from "vitest";
import { createPatchManifest } from "./provenance.js";
import type { PatchChange } from "./types.js";

const changes: PatchChange[] = [{
  relpath: "src/a.ts", kind: "modified", beforeHash: "before", afterHash: "after",
  representation: "full", applyEligibility: "eligible", reasonCodes: [],
}];

describe("patch provenance", () => {
  it("keeps patch identity independent of agent, session, and input order", () => {
    const extra: PatchChange = { ...changes[0]!, relpath: "README.md", kind: "added", beforeHash: undefined };
    const claude = createPatchManifest({ contextId: "c", revisionId: "r", sourceBaselineId: "s", agentId: "claude", agentSessionId: "one", changes: [extra, ...changes] });
    const codex = createPatchManifest({ contextId: "c", revisionId: "r", sourceBaselineId: "different-provenance", agentId: "codex", agentSessionId: "two", changes: [...changes, extra] });
    expect(claude.patchId).toBe(codex.patchId);
    expect(claude.changes.map((entry) => entry.relpath)).toEqual(["README.md", "src/a.ts"]);
  });

  it("changes identity when an identity-bearing field changes", () => {
    const first = createPatchManifest({ contextId: "c", revisionId: "r", sourceBaselineId: "s", changes });
    const second = createPatchManifest({ contextId: "c", revisionId: "r", sourceBaselineId: "s", changes: [{ ...changes[0]!, afterHash: "other" }] });
    expect(first.patchId).not.toBe(second.patchId);
    expect(first.patchId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
