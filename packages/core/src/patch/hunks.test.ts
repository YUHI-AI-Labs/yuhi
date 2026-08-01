import { describe, expect, it } from "vitest";
import { applyTextPatchHunks, buildTextPatchHunks } from "./hunks.js";

describe("selectable text patch hunks", () => {
  it("builds deterministic separated hunks and applies only the selected one", () => {
    const before = ["one", "two", "3", "4", "5", "6", "7", "8", "9", "ten", ""].join("\n");
    const after = ["ONE", "two", "3", "4", "5", "6", "7", "8", "9", "TEN", ""].join("\n");
    const hunks = buildTextPatchHunks(before, after);
    expect(hunks).toHaveLength(2);
    expect(buildTextPatchHunks(before, after).map((hunk) => hunk.hunkId))
      .toEqual(hunks.map((hunk) => hunk.hunkId));
    expect(applyTextPatchHunks(before, hunks, [hunks[0]!.hunkId]).toString("utf8"))
      .toContain("ONE\ntwo");
    expect(applyTextPatchHunks(before, hunks, [hunks[0]!.hunkId]).toString("utf8"))
      .toContain("9\nten");
  });

  it("round-trips all selected hunks to the exact proposed bytes", () => {
    const before = "a\nb\nc\n";
    const after = "a\nB\nc\nd\n";
    const hunks = buildTextPatchHunks(before, after);
    expect(applyTextPatchHunks(before, hunks, hunks.map((hunk) => hunk.hunkId)).toString("utf8"))
      .toBe(after);
  });

  it("round-trips a newly added text file from an empty baseline", () => {
    const after = "new file\nsecond line\n";
    const hunks = buildTextPatchHunks(Buffer.alloc(0), after);
    expect(applyTextPatchHunks(Buffer.alloc(0), hunks, hunks.map((hunk) => hunk.hunkId)).toString("utf8"))
      .toBe(after);
  });
});
