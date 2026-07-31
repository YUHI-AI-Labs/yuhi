import { describe, it, expect } from "vitest";
import { buildAiReadinessReport, formatAiReadinessReport, type ReadinessFile } from "./ai-readiness-report.js";

describe("buildAiReadinessReport", () => {
  const files: ReadinessFile[] = [
    { outcome: "included-unchanged", beforeChars: 1000, afterChars: 1000 },
    { outcome: "included-transformed", maskedValues: 18, beforeChars: 2000, afterChars: 1200 },
    { outcome: "included-transformed", document: { deliveredArtifactType: "sanitized-pdf-companion", redactionCount: 7 }, beforeChars: 50000, afterChars: 2000 },
    { outcome: "included-transformed", document: { deliveredArtifactType: "sanitized-docx-companion", redactionCount: 3 }, beforeChars: 40000, afterChars: 1500 },
    { outcome: "included-unverified", document: { deliveredArtifactType: "safe-placeholder" }, beforeChars: 90_000_000, afterChars: 300 },
    { outcome: "included-unverified", limitation: "transformation-unavailable", beforeChars: 5_000_000, afterChars: 5_000_000 },
    { omitted: true, failureCategory: "unresolved-secret", beforeChars: 500 },
    { omitted: true, failureCategory: "unresolved-secret", beforeChars: 500 },
  ];

  it("counts outcomes honestly", () => {
    const r = buildAiReadinessReport(files);
    expect(r.secretsBlocked).toBe(2);            // two credential files kept local
    expect(r.documentsSummarized).toBe(2);       // pdf + docx companions
    expect(r.piiTransformed).toBe(18 + 7 + 3);   // tabular + doc redactions
    expect(r.largeFilesReduced).toBe(2);         // placeholder + oversize passthrough
    expect(r.preparedFiles).toBe(6);             // delivered (non-omitted)
    expect(r.estimatedReductionPercent).toBeGreaterThan(0);
    expect(r.ready).toBe(true);
  });

  it("estimated reduction is 0 for an empty repo (no divide-by-zero)", () => {
    expect(buildAiReadinessReport([]).estimatedReductionPercent).toBe(0);
  });

  it("formats a readable outcomes block (no policy jargon)", () => {
    const text = formatAiReadinessReport(buildAiReadinessReport(files));
    expect(text).toContain("Repository Ready");
    expect(text).toContain("Secrets blocked");
    expect(text).toContain("Ready for Claude Code.");
    expect(text).toContain("%");
  });
});
