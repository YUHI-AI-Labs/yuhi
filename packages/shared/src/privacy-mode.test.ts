import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRIVACY_MODE,
  LEGACY_DELIVERY_MODE_MAPPING_NOTICE,
  PRIVACY_MODE_COPY,
  PrivacyModeResolutionError,
  isPrivacyMode,
  privacyModeFromLegacyDeliveryMode,
  resolvePrivacyPolicy,
} from "./privacy-mode.js";

describe("resolvePrivacyPolicy — shape per mode", () => {
  it("balanced: transforms identifiers, does not redact secrets, tolerates secret residue only", () => {
    const policy = resolvePrivacyPolicy({ candidates: [{ mode: "balanced", source: "cli" }] });
    expect(policy).toMatchObject({
      mode: "balanced",
      transformDirectPersonalIdentifiers: true,
      preserveOperationalIdentifiers: true,
      preserveAnalyticalAttributes: true,
      redactDetectedSecretsBeforeDelivery: false,
      requireVerifiedGeneratedArtifacts: true,
      allowUnresolvedDirectPersonalResidue: false,
      allowUnresolvedSecretResidue: true,
      warningRequired: false,
      warningAcknowledged: true,
      source: "cli",
    });
  });

  it("strict: transforms identifiers AND redacts secrets; tolerates neither residue", () => {
    const policy = resolvePrivacyPolicy({ candidates: [{ mode: "strict", source: "cli" }] });
    expect(policy).toMatchObject({
      mode: "strict",
      transformDirectPersonalIdentifiers: true,
      redactDetectedSecretsBeforeDelivery: true,
      allowUnresolvedDirectPersonalResidue: false,
      allowUnresolvedSecretResidue: false,
      warningRequired: false,
    });
  });

  it("trusted-local: no transformation, tolerates all residue, still requires verified artifacts", () => {
    const policy = resolvePrivacyPolicy({
      candidates: [{ mode: "trusted-local", source: "cli" }],
      trustedLocalAcknowledged: true,
    });
    expect(policy).toMatchObject({
      mode: "trusted-local",
      transformDirectPersonalIdentifiers: false,
      redactDetectedSecretsBeforeDelivery: false,
      requireVerifiedGeneratedArtifacts: true,
      allowUnresolvedDirectPersonalResidue: true,
      allowUnresolvedSecretResidue: true,
      warningRequired: true,
      warningAcknowledged: true,
    });
  });

  it("every mode preserves operational identifiers and analytical attributes (never a per-mode choice)", () => {
    for (const mode of ["balanced", "strict"] as const) {
      const policy = resolvePrivacyPolicy({ candidates: [{ mode, source: "cli" }] });
      expect(policy.preserveOperationalIdentifiers).toBe(true);
      expect(policy.preserveAnalyticalAttributes).toBe(true);
    }
  });
});

describe("resolvePrivacyPolicy — precedence (Section 5)", () => {
  it("CLI overrides workspace config", () => {
    const policy = resolvePrivacyPolicy({
      candidates: [
        { mode: "strict", source: "cli" },
        { mode: "balanced", source: "workspace-config" },
      ],
    });
    expect(policy.mode).toBe("strict");
    expect(policy.source).toBe("cli");
  });

  it("VS Code session selection overrides workspace config", () => {
    const policy = resolvePrivacyPolicy({
      candidates: [
        { mode: "strict", source: "vscode-setting" },
        { mode: "balanced", source: "workspace-config" },
      ],
    });
    expect(policy.source).toBe("vscode-setting");
  });

  it("workspace config overrides legacy mapping", () => {
    const policy = resolvePrivacyPolicy({
      candidates: [
        { mode: "strict", source: "workspace-config" },
        { mode: "balanced", source: "legacy-mapping" },
      ],
    });
    expect(policy.source).toBe("workspace-config");
  });

  it("legacy mapping overrides the default", () => {
    const policy = resolvePrivacyPolicy({
      candidates: [{ mode: "strict", source: "legacy-mapping" }],
    });
    expect(policy.source).toBe("legacy-mapping");
    expect(policy.mode).toBe("strict");
  });

  it("no candidates -> default (balanced)", () => {
    const policy = resolvePrivacyPolicy({ candidates: [] });
    expect(policy.mode).toBe(DEFAULT_PRIVACY_MODE);
    expect(policy.source).toBe("default");
  });

  it("a lower-precedence candidate is ignored once a higher one is present, even if empty-string", () => {
    const policy = resolvePrivacyPolicy({
      candidates: [
        { mode: "", source: "cli" }, // not explicitly set on the CLI
        { mode: "strict", source: "workspace-config" },
      ],
    });
    expect(policy.source).toBe("workspace-config");
  });

  it("an invalid explicit value fails, never silently falls back", () => {
    expect(() =>
      resolvePrivacyPolicy({ candidates: [{ mode: "paranoid", source: "cli" }] }),
    ).toThrow(PrivacyModeResolutionError);
  });

  it("trusted-local without acknowledgement fails", () => {
    expect(() =>
      resolvePrivacyPolicy({ candidates: [{ mode: "trusted-local", source: "cli" }] }),
    ).toThrow(/acknowledgement/);
  });

  it("trusted-local with acknowledgement=false still fails (not just absent)", () => {
    expect(() =>
      resolvePrivacyPolicy({
        candidates: [{ mode: "trusted-local", source: "cli" }],
        trustedLocalAcknowledged: false,
      }),
    ).toThrow(PrivacyModeResolutionError);
  });
});

describe("legacy deliveryMode mapping", () => {
  it("developer -> balanced (never trusted-local)", () => {
    expect(privacyModeFromLegacyDeliveryMode("developer")).toBe("balanced");
  });

  it("strict -> strict", () => {
    expect(privacyModeFromLegacyDeliveryMode("strict")).toBe("strict");
  });

  it("has a one-line, one-time migration notice", () => {
    expect(LEGACY_DELIVERY_MODE_MAPPING_NOTICE).toMatch(/Balanced/);
  });
});

describe("isPrivacyMode / copy", () => {
  it("accepts only the three real modes", () => {
    expect(isPrivacyMode("balanced")).toBe(true);
    expect(isPrivacyMode("strict")).toBe(true);
    expect(isPrivacyMode("trusted-local")).toBe(true);
    expect(isPrivacyMode("maximum-privacy")).toBe(false);
    expect(isPrivacyMode("")).toBe(false);
    expect(isPrivacyMode(undefined)).toBe(false);
  });

  it("has EN + JA copy for all three modes, and Trusted Local's copy states no OS isolation", () => {
    for (const mode of ["balanced", "strict", "trusted-local"] as const) {
      expect(PRIVACY_MODE_COPY[mode].en.length).toBeGreaterThan(0);
      expect(PRIVACY_MODE_COPY[mode].ja.length).toBeGreaterThan(0);
    }
    expect(PRIVACY_MODE_COPY["trusted-local"].en).toMatch(/does not provide OS-level isolation/);
    expect(PRIVACY_MODE_COPY["trusted-local"].ja).toMatch(/OSレベルの隔離を提供しません/);
  });

  it("prohibited-claims guard: no mode's copy claims full/complete anonymization or removal of all data", () => {
    for (const mode of ["balanced", "strict", "trusted-local"] as const) {
      const en = PRIVACY_MODE_COPY[mode].en.toLowerCase();
      expect(en).not.toMatch(/all personal (data|information)/);
      expect(en).not.toMatch(/complete(ly)? anonymiz/);
      expect(en).not.toMatch(/guarantee/);
    }
  });
});
