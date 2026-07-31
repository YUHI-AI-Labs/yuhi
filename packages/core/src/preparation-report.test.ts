import { describe, it, expect } from "vitest";
import { buildAiReadinessReport, type ReadinessFile } from "./ai-readiness-report.js";
import {
  buildPreparationReport,
  formatPreparationReport,
  type PreparationReport,
} from "./preparation-report.js";

const files: ReadinessFile[] = [
  { outcome: "included-unchanged", beforeChars: 1000, afterChars: 1000 },
  { outcome: "included-transformed", maskedValues: 18, beforeChars: 2000, afterChars: 1200 },
  {
    outcome: "included-transformed",
    document: { deliveredArtifactType: "sanitized-pdf-companion", redactionCount: 7 },
    beforeChars: 50000,
    afterChars: 2000,
  },
  { omitted: true, failureCategory: "unresolved-secret", beforeChars: 500 },
];

describe("buildPreparationReport", () => {
  it("maps readiness outcomes to shareable, public-safe numbers", () => {
    const readiness = buildAiReadinessReport(files);
    const r = buildPreparationReport(readiness, files.length);
    expect(r.sourceFiles).toBe(4);
    expect(r.preparedArtifacts).toBe(readiness.preparedFiles);
    expect(r.documentsPrepared).toBe(1);
    expect(r.secretsBlocked).toBe(1);
    expect(r.identifiersTransformed).toBe(18 + 7);
    expect(r.estimatedReductionPercent).toBeGreaterThan(0);
    expect(r.status).toBe("ready");
  });

  it("never reports fewer source files than prepared artifacts", () => {
    const readiness = buildAiReadinessReport(files);
    // Even if a caller passes a too-small total, sourceFiles stays >= preparedArtifacts.
    const r = buildPreparationReport(readiness, 0);
    expect(r.sourceFiles).toBeGreaterThanOrEqual(r.preparedArtifacts);
  });

  it("flags a warning status when the workspace has warnings", () => {
    const r = buildPreparationReport(buildAiReadinessReport(files), 4, { warning: true });
    expect(r.status).toBe("ready-with-warning");
  });
});

const sample: PreparationReport = {
  sourceFiles: 5224,
  preparedArtifacts: 317,
  documentsPrepared: 42,
  secretsBlocked: 18,
  identifiersTransformed: 103,
  largeFilesExcluded: 15,
  estimatedReductionPercent: 94,
  status: "ready",
};

describe("formatPreparationReport (all formats are public-safe: numbers only)", () => {
  it("terminal matches the fixed Repository Ready shape with grouped numbers", () => {
    const t = formatPreparationReport(sample, "terminal");
    expect(t).toContain("Repository Ready");
    expect(t).toContain("Source files");
    expect(t).toContain("Prepared artifacts");
    expect(t).toContain("5,224"); // thousands separator, no locale surprises
    expect(t).toContain("94%");
    expect(t).toContain("Ready for Claude Code.");
    expect(t).not.toContain("AI-ready"); // corrected wording
  });

  it("markdown renders a table plus the estimate disclaimer", () => {
    const md = formatPreparationReport(sample, "markdown");
    expect(md).toContain("## Repository Ready");
    expect(md).toContain("| Secrets blocked | 18 |");
    expect(md).toContain("| Source files | 5,224 |");
    expect(md).toContain("94%");
    expect(md).toContain("not actual model token savings");
  });

  it("json round-trips the report for machine processing", () => {
    const parsed = JSON.parse(formatPreparationReport(sample, "json"));
    expect(parsed).toEqual(sample);
  });

  it("svg is a self-contained badge with the reduction figure", () => {
    const svg = formatPreparationReport(sample, "svg");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("Prepared with Yuhi");
    expect(svg).toContain("94% reduced");
    // No external references or executable content (xmlns URI is not a fetch).
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/<image/i);
    expect(svg).not.toMatch(/href\s*=/i);
    expect(svg).not.toMatch(/url\s*\(/i);
    expect(svg).not.toMatch(/@import/i);
  });

  it("no format leaks a filename, path, or identity (only aggregate numbers)", () => {
    for (const fmt of ["terminal", "markdown", "json", "svg"] as const) {
      const out = formatPreparationReport(sample, fmt);
      expect(out).not.toMatch(/\/(Users|home)\//);
      expect(out).not.toMatch(/\.(pdf|csv|xlsx|docx|env)\b/i);
    }
  });

  it("renders cleanly at the 0% and near-100% edges and with zero counts", () => {
    const empty: PreparationReport = {
      sourceFiles: 0,
      preparedArtifacts: 0,
      documentsPrepared: 0,
      secretsBlocked: 0,
      identifiersTransformed: 0,
      largeFilesExcluded: 0,
      estimatedReductionPercent: 0,
      status: "ready",
    };
    for (const fmt of ["terminal", "markdown", "json", "svg"] as const) {
      expect(() => formatPreparationReport(empty, fmt)).not.toThrow();
    }
    const t0 = formatPreparationReport(empty, "terminal");
    expect(t0).toContain("0%");
    // largeFilesExcluded row is hidden when zero, present when non-zero.
    expect(t0).not.toContain("Large files excluded");
    expect(formatPreparationReport(sample, "terminal")).toContain("Large files excluded");

    const near100 = { ...empty, estimatedReductionPercent: 99.9 };
    expect(formatPreparationReport(near100, "terminal")).toContain("99.9%");
    expect(formatPreparationReport(near100, "svg")).toContain("99.9% reduced");
  });
});
