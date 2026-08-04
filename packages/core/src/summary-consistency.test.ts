import { describe, it, expect } from "vitest";
import { buildPublicStatus } from "./background/status.js";
import { buildAiReadinessReport } from "./ai-readiness-report.js";
import { buildPreparationReport } from "./preparation-report.js";
import type { PublicBackgroundItem } from "./background/types.js";

/**
 * Cross-surface summary suite (#13/#14/#15).
 *
 * Three separate misreports lived here:
 *   - `Math.max(0, ...)` clamped a real -23.1% reduction to a headline "0%" while the
 *     same CLI output printed -23.1% twelve lines later.
 *   - `largeFilesExcluded` was fed from `largeFilesReduced`, which counted the
 *     raw-fallback file — neither large nor excluded.
 *   - one PDF produced two background jobs, and `total` (a JOB count) was read
 *     everywhere as a FILE count, so one document appeared twice; `status` also
 *     stayed "running" after every job reached a terminal state.
 */

describe("estimated reduction is never clamped", () => {
  it("reports a NEGATIVE reduction when the prepared context grew", () => {
    // Pseudonymization can enlarge output: ASCII tokens replacing short multi-byte
    // values. That is a real -25%, not 0%.
    const r = buildAiReadinessReport([
      { outcome: "included-transformed", maskedValues: 3, beforeChars: 1000, afterChars: 1250 },
    ]);
    expect(r.estimatedReductionPercent).toBeCloseTo(-25, 5);
    expect(r.estimatedReductionPercent).toBeLessThan(0);
  });

  it("still reports 0 only when there is nothing to reduce", () => {
    expect(buildAiReadinessReport([]).estimatedReductionPercent).toBe(0);
  });

  it("agrees with the public context summary on the same run", () => {
    const files = [
      { outcome: "included-transformed", maskedValues: 3, beforeChars: 1000, afterChars: 1250 },
    ];
    const readiness = buildAiReadinessReport(files);
    const before = 1000;
    const after = 1250;
    const contextPercent = ((before - after) / before) * 100;
    // The formula CLAUDE.md fixes, and the headline, must be the same number.
    expect(readiness.estimatedReductionPercent).toBeCloseTo(contextPercent, 5);
  });
});

describe("a verification fallback is not a large file", () => {
  it("does not count a raw fallback as a reduced large artifact", () => {
    const r = buildAiReadinessReport([
      {
        outcome: "included-unverified",
        limitation: "transformation-unavailable",
        rawFallback: true,
        beforeChars: 5000,
        afterChars: 5000,
      },
    ]);
    expect(r.largeFilesReduced).toBe(0);
  });

  it("still counts a genuine oversize passthrough", () => {
    const r = buildAiReadinessReport([
      {
        outcome: "included-unverified",
        limitation: "transformation-unavailable",
        beforeChars: 5_000_000,
        afterChars: 5_000_000,
      },
    ]);
    expect(r.largeFilesReduced).toBe(1);
  });

  it("names the row for what it counts", () => {
    const report = buildPreparationReport(
      buildAiReadinessReport([
        {
          outcome: "included-unverified",
          limitation: "transformation-unavailable",
          rawFallback: true,
          beforeChars: 10,
          afterChars: 10,
        },
      ]),
      1,
    );
    expect(report.largeArtifactsReduced).toBe(0);
    // The old name is still emitted as a DEPRECATED alias so an existing
    // `yuhi report --format json` consumer does not break on a patch release; it must
    // carry the same value, never a separate count.
    expect(report.largeFilesExcluded).toBe(report.largeArtifactsReduced);
  });
});

describe("background accounting separates documents from jobs", () => {
  const item = (over: Partial<PublicBackgroundItem>): PublicBackgroundItem =>
    ({
      runId: "r",
      relpath: "records.pdf",
      documentId: "doc-abc123",
      kind: "document-extraction",
      status: "kept-local",
      ...over,
    }) as PublicBackgroundItem;

  it("counts ONE source document when a single PDF creates two jobs", () => {
    const status = buildPublicStatus([
      item({ kind: "document-extraction", reasonCode: "background-ocr-deferred" }),
      item({ kind: "ocr", reasonCode: "background-ocr-unavailable" }),
    ]);
    // The job count and the file count are different numbers, and both are stated.
    expect(status.accounting.inspectionJobs).toBe(2);
    expect(status.accounting.sourceDocuments).toBe(1);
    expect(status.accounting.keptLocalDocuments).toBe(1);
    // The legacy field is still a job count; nothing should read it as files.
    expect(status.counts.total).toBe(2);
  });

  it("is idle once every job is terminal, never permanently running", () => {
    const status = buildPublicStatus([
      item({ kind: "document-extraction" }),
      item({ kind: "ocr" }),
    ]);
    expect(status.counts.pending).toBe(0);
    expect(status.counts.processing).toBe(0);
    expect(status.activity).toBe("idle");
  });

  it("is running only while work is actually outstanding", () => {
    expect(buildPublicStatus([item({ status: "pending" })]).activity).toBe("running");
    expect(buildPublicStatus([item({ status: "processing" })]).activity).toBe("running");
    expect(buildPublicStatus([item({ status: "completed" })]).activity).toBe("idle");
    expect(buildPublicStatus([item({ status: "failed" })]).activity).toBe("idle");
  });

  it("counts companions only when one was actually published", () => {
    const withCompanion = buildPublicStatus([
      item({ status: "completed", preparedRelpath: ".yuhi/context/doc-abc123.md" }),
    ]);
    expect(withCompanion.accounting.companionsCreated).toBe(1);
    expect(withCompanion.accounting.completedJobs).toBe(1);

    const withoutCompanion = buildPublicStatus([item({ status: "completed" })]);
    expect(withoutCompanion.accounting.companionsCreated).toBe(0);
    expect(withoutCompanion.accounting.completedJobs).toBe(1);
  });

  it("does not inflate the document count across two distinct documents", () => {
    const status = buildPublicStatus([
      item({ documentId: "doc-aaa", kind: "document-extraction" }),
      item({ documentId: "doc-aaa", kind: "ocr" }),
      item({ documentId: "doc-bbb", kind: "document-extraction" }),
    ]);
    expect(status.accounting.sourceDocuments).toBe(2);
    expect(status.accounting.inspectionJobs).toBe(3);
    expect(status.accounting.keptLocalDocuments).toBe(2);
  });
});
