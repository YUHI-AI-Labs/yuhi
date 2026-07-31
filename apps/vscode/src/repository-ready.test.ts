import { describe, it, expect } from "vitest";
import type { PreparationReport } from "@yuhi/core";
import {
  renderRepositoryReadyCard,
  repositoryReadyClipboardText,
  repositoryReadyExportText,
  REPOSITORY_READY_EXPORT_FORMATS,
} from "./repository-ready.js";

const report = (over: Partial<PreparationReport> = {}): PreparationReport => ({
  sourceFiles: 128,
  preparedArtifacts: 131,
  documentsPrepared: 4,
  secretsBlocked: 7,
  identifiersTransformed: 2165,
  largeFilesExcluded: 0,
  estimatedReductionPercent: 94,
  status: "ready",
  safetyMode: "balanced",
  ...over,
});

// Strings that must NEVER appear in any public-safe surface (paths / filenames /
// secret types / identities). The report has no such fields; these guard against
// a regression that ever plumbed one through.
const FORBIDDEN = [
  "/Users/",
  "\\Users\\",
  ".env",
  "meeting-log.md",
  "student-records.xlsx",
  "Nakamoto",
  "nakamolinto",
  "@elyza",
  "API_KEY",
  "password",
];

describe("renderRepositoryReadyCard", () => {
  it("headlines the five metrics, the reduction, and a clear estimate caveat", () => {
    const out = renderRepositoryReadyCard(report());
    expect(out).toContain("Repository Ready");
    expect(out).toContain("Source files");
    expect(out).toContain("Prepared artifacts");
    expect(out).toContain("Documents prepared");
    expect(out).toContain("Secrets blocked");
    expect(out).toContain("Identifiers transformed");
    // Values (grouped) are present.
    expect(out).toContain("128");
    expect(out).toContain("131");
    expect(out).toContain("2,165");
    // Reduction is labelled as accessible-content, explicitly NOT token savings.
    expect(out).toContain("Estimated accessible-content reduction");
    expect(out).toContain("94%");
    expect(out).toContain("agent-accessible content, not model token savings");
  });

  it("offers public-safe copy and export actions with the wired button ids", () => {
    const out = renderRepositoryReadyCard(report());
    expect(out).toContain('id="copyPublicReport"');
    expect(out).toContain("Copy public report");
    expect(out).toContain('id="exportPublicReport"');
    expect(out).toContain("Export");
    expect(out).toContain("public-safe");
  });

  it("hides Large files excluded when zero and shows it when present", () => {
    expect(renderRepositoryReadyCard(report({ largeFilesExcluded: 0 }))).not.toContain(
      "Large files excluded",
    );
    const withLarge = renderRepositoryReadyCard(report({ largeFilesExcluded: 3 }));
    expect(withLarge).toContain("Large files excluded");
    expect(withLarge).toContain(">3<");
  });

  it("switches the header when the run is ready-with-warning", () => {
    const clean = renderRepositoryReadyCard(report({ status: "ready" }));
    expect(clean).toContain("Repository Ready");
    expect(clean).not.toContain("review warnings");
    const warn = renderRepositoryReadyCard(report({ status: "ready-with-warning" }));
    expect(warn).toContain("Ready — review warnings");
    expect(warn).toContain("REVIEW WARNINGS");
  });

  it("renders only aggregate numbers — never a path, filename, or identity", () => {
    const out = renderRepositoryReadyCard(report({ largeFilesExcluded: 5 }));
    for (const forbidden of FORBIDDEN) expect(out).not.toContain(forbidden);
  });
});

describe("Repository Ready copy/export (public-safe output)", () => {
  it("copy produces Markdown with the numbers and no path/identity", () => {
    const md = repositoryReadyClipboardText(report());
    expect(md).toContain("Repository Ready");
    expect(md).toContain("128");
    expect(md).toContain("2,165");
    expect(md).toContain("94%");
    expect(md.toLowerCase()).toContain("not actual model token savings");
    for (const forbidden of FORBIDDEN) expect(md).not.toContain(forbidden);
  });

  it("each export format carries the numbers and leaks no path/identity", () => {
    for (const { format } of REPOSITORY_READY_EXPORT_FORMATS) {
      const out = repositoryReadyExportText(report({ largeFilesExcluded: 6 }), format);
      expect(out).toContain("94");
      for (const forbidden of FORBIDDEN) expect(out).not.toContain(forbidden);
    }
  });

  it("offers exactly Markdown, JSON, and SVG export formats", () => {
    expect(REPOSITORY_READY_EXPORT_FORMATS.map((f) => f.format)).toEqual([
      "markdown",
      "json",
      "svg",
    ]);
    expect(REPOSITORY_READY_EXPORT_FORMATS.map((f) => f.extension)).toEqual([
      "md",
      "json",
      "svg",
    ]);
  });
});
