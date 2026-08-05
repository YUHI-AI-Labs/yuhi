import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRIVACY_MODE,
  LEGACY_DELIVERY_MODE_MAPPING_NOTICE,
  PrivacyModeResolutionError,
  isPrivacyMode,
  privacyModeCopyFor,
  privacyModeFromLegacyDeliveryMode,
  resolveDeliveryPolicy,
  resolvePrivacyPolicy,
} from "./privacy-mode.js";

describe("resolvePrivacyPolicy — mode selection + precedence (Section 5)", () => {
  it("CLI overrides workspace config", () => {
    const result = resolvePrivacyPolicy({
      candidates: [
        { mode: "strict", source: "cli" },
        { mode: "balanced", source: "workspace-config" },
      ],
    });
    expect(result.mode).toBe("strict");
    expect(result.source).toBe("cli");
  });

  it("VS Code session selection overrides workspace config", () => {
    const result = resolvePrivacyPolicy({
      candidates: [
        { mode: "strict", source: "vscode-setting" },
        { mode: "balanced", source: "workspace-config" },
      ],
    });
    expect(result.source).toBe("vscode-setting");
  });

  it("workspace config overrides legacy mapping", () => {
    const result = resolvePrivacyPolicy({
      candidates: [
        { mode: "strict", source: "workspace-config" },
        { mode: "balanced", source: "legacy-mapping" },
      ],
    });
    expect(result.source).toBe("workspace-config");
  });

  it("legacy mapping overrides the default", () => {
    const result = resolvePrivacyPolicy({ candidates: [{ mode: "strict", source: "legacy-mapping" }] });
    expect(result.source).toBe("legacy-mapping");
    expect(result.mode).toBe("strict");
  });

  it("no candidates -> default (balanced)", () => {
    const result = resolvePrivacyPolicy({ candidates: [] });
    expect(result.mode).toBe(DEFAULT_PRIVACY_MODE);
    expect(result.source).toBe("default");
  });

  it("a lower-precedence candidate is ignored once a higher one is present, even if empty-string", () => {
    const result = resolvePrivacyPolicy({
      candidates: [
        { mode: "", source: "cli" },
        { mode: "strict", source: "workspace-config" },
      ],
    });
    expect(result.source).toBe("workspace-config");
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

  it("trusted-local with acknowledgement succeeds", () => {
    const result = resolvePrivacyPolicy({
      candidates: [{ mode: "trusted-local", source: "cli" }],
      trustedLocalAcknowledged: true,
    });
    expect(result.mode).toBe("trusted-local");
    expect(result.warningAcknowledged).toBe(true);
  });
});

describe("resolveDeliveryPolicy — the two-axis matrix (Clarification Section 3/5)", () => {
  it("static-prepare redacts secrets in EVERY mode", () => {
    for (const privacyMode of ["balanced", "strict", "trusted-local"] as const) {
      const policy = resolveDeliveryPolicy({ privacyMode, surface: "static-prepare" });
      expect(policy.secretDeliveryMode).toBe("redact");
    }
  });

  it("dynamic-terminal: balanced -> developer-delivery", () => {
    const policy = resolveDeliveryPolicy({ privacyMode: "balanced", surface: "dynamic-terminal" });
    expect(policy.secretDeliveryMode).toBe("developer-delivery");
  });

  it("dynamic-terminal: strict -> redact", () => {
    const policy = resolveDeliveryPolicy({ privacyMode: "strict", surface: "dynamic-terminal" });
    expect(policy.secretDeliveryMode).toBe("redact");
  });

  it("native-gui shares the dynamic-terminal matrix", () => {
    for (const privacyMode of ["balanced", "strict", "trusted-local"] as const) {
      const dynamicTerminal = resolveDeliveryPolicy({ privacyMode, surface: "dynamic-terminal" });
      const nativeGui = resolveDeliveryPolicy({ privacyMode, surface: "native-gui" });
      expect(nativeGui.secretDeliveryMode).toBe(dynamicTerminal.secretDeliveryMode);
    }
  });

  it("trusted-local on a dynamic surface -> developer-delivery, but on static-prepare -> redact (same mode, different surface, different secret behavior BY DESIGN)", () => {
    const dynamic = resolveDeliveryPolicy({
      privacyMode: "trusted-local",
      surface: "native-gui",
      warningAcknowledged: true,
    });
    const staticPrepare = resolveDeliveryPolicy({
      privacyMode: "trusted-local",
      surface: "static-prepare",
    });
    expect(dynamic.secretDeliveryMode).toBe("developer-delivery");
    expect(staticPrepare.secretDeliveryMode).toBe("redact");
    // Identifier transformation, in contrast, is identical across surfaces for one mode.
    expect(dynamic.transformDirectPersonalIdentifiers).toBe(
      staticPrepare.transformDirectPersonalIdentifiers,
    );
  });

  it("transformDirectPersonalIdentifiers is surface-independent: false only for trusted-local", () => {
    for (const surface of ["static-prepare", "dynamic-terminal", "native-gui"] as const) {
      expect(resolveDeliveryPolicy({ privacyMode: "balanced", surface }).transformDirectPersonalIdentifiers).toBe(true);
      expect(resolveDeliveryPolicy({ privacyMode: "strict", surface }).transformDirectPersonalIdentifiers).toBe(true);
      expect(resolveDeliveryPolicy({ privacyMode: "trusted-local", surface }).transformDirectPersonalIdentifiers).toBe(false);
    }
  });

  it("every mode/surface combination preserves operational identifiers and analytical attributes", () => {
    for (const privacyMode of ["balanced", "strict", "trusted-local"] as const) {
      for (const surface of ["static-prepare", "dynamic-terminal", "native-gui"] as const) {
        const policy = resolveDeliveryPolicy({ privacyMode, surface });
        expect(policy.preserveOperationalIdentifiers).toBe(true);
        expect(policy.preserveAnalyticalAttributes).toBe(true);
        expect(policy.requireVerifiedGeneratedArtifacts).toBe(true);
      }
    }
  });

  it("warningRequired is true only for trusted-local, on every surface", () => {
    for (const surface of ["static-prepare", "dynamic-terminal", "native-gui"] as const) {
      expect(resolveDeliveryPolicy({ privacyMode: "balanced", surface }).warningRequired).toBe(false);
      expect(resolveDeliveryPolicy({ privacyMode: "strict", surface }).warningRequired).toBe(false);
      expect(resolveDeliveryPolicy({ privacyMode: "trusted-local", surface }).warningRequired).toBe(true);
    }
  });

  it("trusted-local's warningAcknowledged reflects the input, never silently true", () => {
    const unacknowledged = resolveDeliveryPolicy({ privacyMode: "trusted-local", surface: "static-prepare" });
    expect(unacknowledged.warningAcknowledged).toBe(false);
    const acknowledged = resolveDeliveryPolicy({
      privacyMode: "trusted-local",
      surface: "static-prepare",
      warningAcknowledged: true,
    });
    expect(acknowledged.warningAcknowledged).toBe(true);
  });

  it("does not throw for any input -- validation is resolvePrivacyPolicy's job, not this function's", () => {
    expect(() =>
      resolveDeliveryPolicy({ privacyMode: "trusted-local", surface: "static-prepare" }),
    ).not.toThrow();
  });
});

describe("legacy deliveryMode mapping (Clarification Section 10)", () => {
  it("developer -> balanced (never trusted-local)", () => {
    expect(privacyModeFromLegacyDeliveryMode("developer")).toBe("balanced");
  });

  it("strict -> strict", () => {
    expect(privacyModeFromLegacyDeliveryMode("strict")).toBe("strict");
  });

  it("developer, mapped to balanced, reproduces the legacy Developer Mode secret behavior on a dynamic surface", () => {
    const mode = privacyModeFromLegacyDeliveryMode("developer");
    const policy = resolveDeliveryPolicy({ privacyMode: mode, surface: "dynamic-terminal" });
    expect(policy.secretDeliveryMode).toBe("developer-delivery");
  });

  it("has a one-line, one-time migration notice", () => {
    expect(LEGACY_DELIVERY_MODE_MAPPING_NOTICE).toMatch(/Balanced/);
  });
});

describe("isPrivacyMode", () => {
  it("accepts only the three real modes", () => {
    expect(isPrivacyMode("balanced")).toBe(true);
    expect(isPrivacyMode("strict")).toBe(true);
    expect(isPrivacyMode("trusted-local")).toBe(true);
    expect(isPrivacyMode("maximum-privacy")).toBe(false);
    expect(isPrivacyMode("")).toBe(false);
    expect(isPrivacyMode(undefined)).toBe(false);
  });
});

describe("privacyModeCopyFor — surface-aware copy (Clarification Section 7/8)", () => {
  it("has EN + JA copy for all three modes on both surface families", () => {
    for (const mode of ["balanced", "strict", "trusted-local"] as const) {
      for (const surface of ["static-prepare", "dynamic-terminal", "native-gui"] as const) {
        const copy = privacyModeCopyFor(mode, surface);
        expect(copy.en.length).toBeGreaterThan(0);
        expect(copy.ja.length).toBeGreaterThan(0);
      }
    }
  });

  it("Static Prepare's Balanced copy states secrets ARE redacted", () => {
    const copy = privacyModeCopyFor("balanced", "static-prepare");
    expect(copy.en).toMatch(/secrets are redacted/i);
  });

  it("Dynamic surfaces' Balanced copy states secrets MAY reach the agent, never written to evidence", () => {
    const copy = privacyModeCopyFor("balanced", "dynamic-terminal");
    expect(copy.en).toMatch(/may be delivered to Claude/);
    expect(copy.en).toMatch(/not written to Yuhi public logs or evidence/);
  });

  it("Trusted Local's Static Prepare copy does NOT claim secrets are unmasked (they are still redacted there)", () => {
    const copy = privacyModeCopyFor("trusted-local", "static-prepare");
    expect(copy.en).toMatch(/secrets are still redacted/i);
    expect(copy.en).not.toMatch(/secrets.*unchanged/i);
  });

  it("Trusted Local's dynamic-surface copy DOES warn secrets may be delivered unchanged", () => {
    const copy = privacyModeCopyFor("trusted-local", "dynamic-terminal");
    expect(copy.en).toMatch(/secrets may be delivered unchanged/i);
  });

  it("Trusted Local copy never claims it is 'always fully unmasked' independent of surface", () => {
    for (const surface of ["static-prepare", "dynamic-terminal", "native-gui"] as const) {
      const copy = privacyModeCopyFor("trusted-local", surface);
      expect(copy.en.toLowerCase()).not.toMatch(/always.*unmask/);
    }
  });

  it("Trusted Local copy states no OS-level isolation, on every surface", () => {
    for (const surface of ["static-prepare", "dynamic-terminal", "native-gui"] as const) {
      const copy = privacyModeCopyFor("trusted-local", surface);
      expect(copy.en).toMatch(/does not provide OS-level isolation/);
      expect(copy.ja).toMatch(/OSレベルの隔離を提供しません/);
    }
  });

  it("prohibited-claims guard: no mode/surface copy claims full/complete/guaranteed anonymization", () => {
    for (const mode of ["balanced", "strict", "trusted-local"] as const) {
      for (const surface of ["static-prepare", "dynamic-terminal", "native-gui"] as const) {
        const en = privacyModeCopyFor(mode, surface).en.toLowerCase();
        expect(en).not.toMatch(/all personal (data|information)/);
        expect(en).not.toMatch(/complete(ly)? anonymiz/);
        expect(en).not.toMatch(/guarantee/);
        expect(en).not.toMatch(/secrets never reach claude/);
      }
    }
  });
});
