import { describe, it, expect } from "vitest";
import { resolveDisclosure, type DisclosureInput } from "./disclosure.js";

const base = (o: Partial<DisclosureInput> = {}): DisclosureInput => ({
  fileId: "f1", fileType: "text", hardBlocked: false, policyExcluded: false,
  unverified: false, unsupported: false, survivingStructuredPii: false,
  residualRisk: false, sanitizedArtifactAvailable: true, ...o,
});

describe("resolveDisclosure — Safety Mode", () => {
  it("Strict excludes unverified/unsupported files (not overridable)", () => {
    const r = resolveDisclosure(base({ unverified: true, unsupported: true, sanitizedArtifactAvailable: false }), "strict");
    expect(r.effectiveDecision).toBe("exclude-policy");
    expect(r.overrideAllowed).toBe(false);
  });
  it("Balanced marks unverified/unsupported as pending-review (overridable)", () => {
    const r = resolveDisclosure(base({ unsupported: true, sanitizedArtifactAvailable: false }), "balanced");
    expect(r.recommendation).toBe("pending-review");
    expect(r.overrideAllowed).toBe(true);
  });
  it("Open lets the user approve an unverified file", () => {
    const r = resolveDisclosure(base({ unsupported: true, sanitizedArtifactAvailable: false }), "open", { userDecision: "include-standard" });
    expect(r.effectiveDecision).toBe("include-standard");
    expect(r.decidedBy).toBe("user");
  });
});

describe("resolveDisclosure — hard blocks (invariant: never overridable)", () => {
  for (const mode of ["strict", "balanced", "open"] as const) {
    it(`credentials/keys stay blocked in ${mode} even with an include user decision`, () => {
      const r = resolveDisclosure(
        base({ hardBlocked: true, hardBlockReason: "Private key detected" }),
        mode,
        { userDecision: "include-full-sanitized" },
      );
      expect(r.effectiveDecision).toBe("blocked");
      expect(r.overrideAllowed).toBe(false);
      expect(r.userDecision).toBe("include-full-sanitized"); // recorded but not applied
    });
  }
});

describe("resolveDisclosure — priority + detail", () => {
  it("explicit per-file user decision beats folder and type rules", () => {
    const r = resolveDisclosure(base(), "balanced", {
      userDecision: "include-compact", folderDecision: "exclude-user", typeDecision: "include-full-sanitized",
    });
    expect(r.effectiveDecision).toBe("include-compact");
    expect(r.decidedBy).toBe("user");
  });
  it("folder rule beats type rule when there is no per-file decision", () => {
    const r = resolveDisclosure(base(), "balanced", { folderDecision: "exclude-user", typeDecision: "include-full-sanitized" });
    expect(r.effectiveDecision).toBe("exclude-user");
    expect(r.decidedBy).toBe("folder");
  });
  it("reset to recommendation (no user decision) uses Yuhi's recommendation", () => {
    const r = resolveDisclosure(base(), "balanced", { defaultContextDetail: "compact" });
    expect(r.effectiveDecision).toBe("include-compact");
    expect(r.decidedBy).toBe("recommendation");
  });
  it("per-file context-detail override beats the workspace default", () => {
    const r = resolveDisclosure(base(), "balanced", { defaultContextDetail: "standard", userContextDetail: "full-sanitized" });
    expect(r.contextDetail).toBe("full-sanitized");
    expect(r.recommendation).toBe("include-full-sanitized");
  });
  it("recommendation and user decision are recorded separately", () => {
    const r = resolveDisclosure(base(), "balanced", { userDecision: "exclude-user" });
    expect(r.recommendation).toBe("include-standard");
    expect(r.userDecision).toBe("exclude-user");
    expect(r.effectiveDecision).toBe("exclude-user");
  });
  it("a surviving structured identifier is excluded in Strict, review elsewhere", () => {
    expect(resolveDisclosure(base({ survivingStructuredPii: true }), "strict").effectiveDecision).toBe("exclude-policy");
    expect(resolveDisclosure(base({ survivingStructuredPii: true }), "balanced").recommendation).toBe("pending-review");
  });
});
