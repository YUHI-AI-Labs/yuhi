import { describe, it, expect } from "vitest";
import { buildWhatAiCanSeeView, type WhatAiCanSeeSource } from "./what-ai-can-see.js";
import { resolveDisclosure, type DisclosureInput } from "./disclosure.js";

const rec = (o: Partial<DisclosureInput>, mode: any = "balanced", ov: any = {}) =>
  resolveDisclosure({ fileId: "f", fileType: "t", hardBlocked: false, policyExcluded: false, unverified: false, unsupported: false, survivingStructuredPii: false, residualRisk: false, sanitizedArtifactAvailable: true, ...o }, mode, ov);

describe("buildWhatAiCanSeeView", () => {
  it("splits into available / not-available with accurate labels", () => {
    const sources: WhatAiCanSeeSource[] = [
      { record: rec({}), displayName: "src/app.ts", fileType: "code", sizeBytes: 1000 },
      { record: rec({}, "balanced", { userContextDetail: "compact" }), displayName: "big.md", fileType: "doc", sizeBytes: 2000 },
      { record: rec({ hardBlocked: true, hardBlockReason: "Credential" }), displayName: ".env", fileType: "config", sizeBytes: 50 },
      { record: rec({ unsupported: true, sanitizedArtifactAvailable: false }), displayName: "x.bin", fileType: "binary", sizeBytes: 999 },
      { record: rec({}, "balanced", { userDecision: "exclude-user" }), displayName: "contract.pdf", fileType: "doc", sizeBytes: 3000, originalKeptLocal: true },
    ];
    const view = buildWhatAiCanSeeView(sources);
    expect(view.available.map((i) => i.displayName)).toEqual(["src/app.ts", "big.md"]);
    expect(view.available.find((i) => i.displayName === "big.md")?.statusLabel).toBe("Compact summary");
    expect(view.counts.hardBlocked).toBe(1);
    expect(view.counts.pendingReview).toBe(1);
    expect(view.counts.excludedUser).toBe(1);
    expect(view.notAvailable.find((i) => i.displayName === ".env")?.statusLabel).toContain("Hard blocked");
    expect(view.reduction.estimatedContentReductionPercent).toBeGreaterThan(0);
  });

  it("labels a document companion as available with an 'original kept local' note", () => {
    const view = buildWhatAiCanSeeView([
      { record: rec({ residualRisk: true }), displayName: "requirements.pdf.md", fileType: "doc", sizeBytes: 1000, deliveredArtifactType: "sanitized-pdf-companion", originalKeptLocal: true },
    ]);
    expect(view.available[0]?.note).toContain("Original kept local");
  });
});
