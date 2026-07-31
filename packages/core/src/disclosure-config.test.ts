import { describe, it, expect } from "vitest";
import {
  parseDisclosureConfig, migrateWorkspaceDisclosure, fileIdFor, deriveDisclosureInput,
  DEFAULT_DISCLOSURE_CONFIG, type LegacyManifestFile,
} from "./disclosure-config.js";

describe("parseDisclosureConfig", () => {
  it("returns safe defaults for garbage/missing input (fail-safe to Balanced/Standard)", () => {
    for (const bad of [null, undefined, 42, "x", { safetyMode: "nope", defaultContextDetail: "nope" }]) {
      const c = parseDisclosureConfig(bad);
      expect(c.safetyMode).toBe("balanced");
      expect(c.defaultContextDetail).toBe("standard");
      expect(c.localAI.enabled).toBe(true);
    }
  });
  it("accepts valid values and clamps localAI numbers", () => {
    const c = parseDisclosureConfig({
      safetyMode: "strict", defaultContextDetail: "compact",
      localAI: { enabled: false, maxConcurrentRequests: 999, requestTimeoutMs: 10_000_000, summaryModel: "llama3" },
      fileOverrides: { fA: { decision: "exclude-user", contextDetail: "full-sanitized" } },
    });
    expect(c.safetyMode).toBe("strict");
    expect(c.defaultContextDetail).toBe("compact");
    expect(c.localAI.enabled).toBe(false);
    expect(c.localAI.maxConcurrentRequests).toBe(8);   // clamped
    expect(c.localAI.requestTimeoutMs).toBe(300_000);  // clamped
    expect(c.fileOverrides.fA?.decision).toBe("exclude-user");
  });
});

describe("fileIdFor", () => {
  it("is stable, deterministic, and never contains the raw path", () => {
    const id = fileIdFor("check/9999990001-評定.pdf");
    expect(id).toBe(fileIdFor("check/9999990001-評定.pdf"));
    expect(id).not.toContain("9999990001");
    expect(id).not.toContain("/");
    expect(fileIdFor("a")).not.toBe(fileIdFor("b"));
  });
});

describe("migrateWorkspaceDisclosure (v0.2.9 -> v0.3)", () => {
  const files: LegacyManifestFile[] = [
    { relpath: "src/app.ts", outcome: "included-unchanged" },
    { relpath: "grades.csv", outcome: "included-transformed" },
    { relpath: "report.pdf.md", outcome: "included-transformed", document: { deliveredArtifactType: "sanitized-pdf-companion", residualNameRisk: true, originalSharedWithAgent: false } },
    { relpath: "big.log", outcome: "included-unverified" },
    { relpath: ".env", omitted: true, failureCategory: "unresolved-secret" },
  ];

  it("defaults to Balanced/Standard and preserves verifiable sanitized artifacts", () => {
    const { config, records } = migrateWorkspaceDisclosure(files);
    expect(config.safetyMode).toBe("balanced");
    expect(config.defaultContextDetail).toBe("standard");
    const csv = records.find((r) => r.fileId === fileIdFor("grades.csv"));
    expect(csv?.effectiveDecision).toBe("include-standard");
    const doc = records.find((r) => r.fileId === fileIdFor("report.pdf.md"));
    expect(doc?.effectiveDecision).toBe("include-standard"); // companion is includable
  });

  it("keeps a credential file hard-blocked and non-overridable", () => {
    const { records } = migrateWorkspaceDisclosure(files);
    const env = records.find((r) => r.fileId === fileIdFor(".env"));
    expect(env?.effectiveDecision).toBe("blocked");
    expect(env?.overrideAllowed).toBe(false);
  });

  it("marks an unverified file as pending-review", () => {
    const { records, pendingReview } = migrateWorkspaceDisclosure(files);
    const log = records.find((r) => r.fileId === fileIdFor("big.log"));
    expect(log?.effectiveDecision).toBe("pending-review");
    expect(pendingReview).toBeGreaterThanOrEqual(1);
  });

  it("a preserved user override survives migration (does not silently reset)", () => {
    const id = fileIdFor("grades.csv");
    const { records } = migrateWorkspaceDisclosure(files, {
      ...DEFAULT_DISCLOSURE_CONFIG, fileOverrides: { [id]: { decision: "exclude-user" } },
    });
    expect(records.find((r) => r.fileId === id)?.effectiveDecision).toBe("exclude-user");
  });

  it("deriveDisclosureInput never marks a companion as unverified/unsupported", () => {
    const inp = deriveDisclosureInput(files[2]!, "x");
    expect(inp.sanitizedArtifactAvailable).toBe(true);
    expect(inp.unverified).toBe(false);
    expect(inp.residualRisk).toBe(true);
  });
});
