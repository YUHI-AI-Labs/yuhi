import { describe, it, expect } from "vitest";
import { buildAiReadinessReport, buildAiReadinessScore, aiReadinessBadge, formatAiReadinessScore, type ReadinessFile } from "./ai-readiness-report.js";

describe("AI Readiness Score", () => {
  const files: ReadinessFile[] = [
    { outcome: "included-transformed", maskedValues: 18, beforeChars: 5000, afterChars: 1000 },
    { outcome: "included-transformed", document: { deliveredArtifactType: "sanitized-pdf-companion", redactionCount: 7 }, beforeChars: 90000, afterChars: 2000 },
    { omitted: true, failureCategory: "unresolved-secret", beforeChars: 200 },
  ];
  it("produces a 0-100 score with per-category stars", () => {
    const score = buildAiReadinessScore(buildAiReadinessReport(files), { categories: 4, topModules: 5 });
    expect(score.score).toBeGreaterThan(0);
    expect(score.score).toBeLessThanOrEqual(100);
    expect(score.categories.map((c) => c.name)).toEqual([
      "Secrets blocked", "Documents prepared", "Repository structure", "Context reduction",
    ]);
    for (const c of score.categories) {
      expect(c.stars).toBeGreaterThanOrEqual(0);
      expect(c.stars).toBeLessThanOrEqual(5);
    }
  });
  it("badge + formatted output are shareable strings", () => {
    const score = buildAiReadinessScore(buildAiReadinessReport(files));
    expect(aiReadinessBadge(score)).toMatch(/^AI Ready \d{1,3}\/100$/);
    expect(formatAiReadinessScore(score)).toContain("★");
    expect(formatAiReadinessScore(score)).toContain("/ 100");
  });
});
