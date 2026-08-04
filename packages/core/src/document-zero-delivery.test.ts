import { describe, it, expect } from "vitest";
import { buildPublicStatus } from "./background/status.js";
import { buildYuhiModeSummary, renderYuhiModeHandoff } from "./yuhi-mode-summary.js";
import { buildPublicPreparedContextSummary } from "./public-prepared-summary.js";
import type { PublicBackgroundItem } from "./background/types.js";
import type { PreparedFileEntry } from "./prepare-workspace.js";

/**
 * Document zero-delivery suite (#16).
 *
 * The reported defect was raw PDF delivery. That did NOT reproduce: a
 * known-sensitive document is kept local in every Safety Mode by design, and the
 * agent is meant to receive its verified companion instead.
 *
 * What reproduced is the opposite failure. When the companion never materializes
 * (OCR unavailable / deferred), the document was counted NOWHERE — not pending, not
 * completed, not failed, not companionUnavailable (which only covers an original
 * delivered with a warning). It vanished from every surface while its manifest entry
 * still read `background-processing-pending`, so the UI reported work in progress
 * forever and never admitted that no context existed.
 */

const pdfEntry = (over: Partial<PreparedFileEntry> = {}): PreparedFileEntry =>
  ({
    relpath: "doc-abc123.pdf",
    originalRelpath: "records.pdf",
    documentId: "doc-abc123",
    action: "prepare-locally",
    status: "skipped",
    outcome: "background-processing-pending",
    transmission: "blocked",
    beforeChars: 900,
    afterChars: 0,
    transformed: false,
    omitted: true,
    availabilityStatus: "background-processing",
    inspectionStatus: "pending",
    backgroundStatus: "pending",
    originalShared: false,
    ...over,
  }) as PreparedFileEntry;

const terminalNoCompanion = (kind: PublicBackgroundItem["kind"]): PublicBackgroundItem =>
  ({
    runId: "run",
    relpath: "records.pdf",
    documentId: "doc-abc123",
    kind,
    status: "kept-local",
    reasonCode: kind === "ocr" ? "background-ocr-unavailable" : "background-ocr-deferred",
    originalSharedWithWarning: false,
  }) as PublicBackgroundItem;

function summaryFor(items: PublicBackgroundItem[]) {
  const files = [pdfEntry()];
  const background = buildPublicStatus(items);
  const prepared = buildPublicPreparedContextSummary({ files, originalWorkspaceModified: false });
  return buildYuhiModeSummary({ files, prepared, background, launchAllowed: true });
}

describe("a document whose companion never arrives is reported, not hidden", () => {
  it("counts it as context-unavailable rather than vanishing", () => {
    const summary = summaryFor([
      terminalNoCompanion("document-extraction"),
      terminalNoCompanion("ocr"),
    ]);
    // ONE document, however many jobs it produced.
    expect(summary.background.contextUnavailable).toBe(1);
    // And it is not misreported as any other state.
    expect(summary.background.pending).toBe(0);
    expect(summary.background.processing).toBe(0);
    expect(summary.background.completed).toBe(0);
    expect(summary.background.companionUnavailable).toBe(0);
  });

  it("does not claim work is still running once every job is terminal", () => {
    const summary = summaryFor([
      terminalNoCompanion("document-extraction"),
      terminalNoCompanion("ocr"),
    ]);
    expect(summary.background.status).not.toBe("running");
    expect(summary.background.status).toBe("completed-with-limitations");
  });

  it("downgrades the launch status to ready-with-warnings", () => {
    // The user must not be told the workspace is simply "ready" when a document they
    // provided produced no context at all.
    expect(summaryFor([terminalNoCompanion("document-extraction")]).launchStatus).toBe(
      "ready-with-warnings",
    );
  });

  it("states it in the agent handoff", () => {
    const handoff = renderYuhiModeHandoff(
      summaryFor([terminalNoCompanion("document-extraction"), terminalNoCompanion("ocr")]),
    );
    expect(handoff).toContain("Documents with no available context: 1");
  });

  it("stays silent when a companion WAS produced", () => {
    const summary = summaryFor([
      {
        runId: "run",
        relpath: "records.pdf",
        documentId: "doc-abc123",
        kind: "document-extraction",
        status: "completed",
        preparedRelpath: ".yuhi/context/doc-abc123.md",
      } as PublicBackgroundItem,
    ]);
    expect(summary.background.contextUnavailable).toBe(0);
    expect(summary.background.completed).toBe(1);
  });

  it("stays silent when the ORIGINAL was delivered with a warning instead", () => {
    // Balanced mode for a document with no known finding: the original is shared, so
    // the agent does have context and this is `companionUnavailable`, not zero context.
    const summary = summaryFor([
      { ...terminalNoCompanion("document-extraction"), originalSharedWithWarning: true } as PublicBackgroundItem,
    ]);
    expect(summary.background.contextUnavailable).toBe(0);
    expect(summary.background.companionUnavailable).toBe(1);
  });

  it("counts two distinct documents separately", () => {
    const summary = (() => {
      const files = [pdfEntry(), pdfEntry({ relpath: "doc-def456.pdf", documentId: "doc-def456" })];
      const background = buildPublicStatus([
        terminalNoCompanion("document-extraction"),
        { ...terminalNoCompanion("ocr"), documentId: "doc-def456" } as PublicBackgroundItem,
      ]);
      const prepared = buildPublicPreparedContextSummary({
        files,
        originalWorkspaceModified: false,
      });
      return buildYuhiModeSummary({ files, prepared, background, launchAllowed: true });
    })();
    expect(summary.background.contextUnavailable).toBe(2);
  });
});
