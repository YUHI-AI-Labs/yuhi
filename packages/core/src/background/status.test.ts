import { describe, expect, it } from "vitest";
import { buildPublicStatus } from "./status.js";
import type { PublicBackgroundItem } from "./types.js";

const item = (overrides: Partial<PublicBackgroundItem>): PublicBackgroundItem => ({
  itemId: "item",
  runId: "run",
  contextId: "sha256:test",
  relpath: "document.pdf",
  kind: "document-extraction",
  priority: 0,
  createdAt: 0,
  status: "kept-local",
  ...overrides,
});

describe("public background status", () => {
  it("separates missing companions for warning-available originals from kept-local originals", () => {
    const status = buildPublicStatus([
      item({ itemId: "warning", originalSharedWithWarning: true }),
      item({ itemId: "local", relpath: "strict.pdf" }),
    ]);
    expect(status.counts.companionUnavailable).toBe(1);
    expect(status.counts.keptLocal).toBe(1);
    expect(status.items[0]?.originalSharedWithWarning).toBe(true);
  });
});
