import { describe, it, expect } from "vitest";
import { fileCapabilities, type PolicyInput, type ScanFinding } from "@yuhi/shared";
import { resolvePolicy } from "./resolve.js";

function finding(detector: string): ScanFinding {
  return {
    detector,
    path: "x",
    severity: "high",
    maskedPreview: "****",
    description: "test",
  };
}

const baseRules: PolicyInput["rules"] = [
  { name: "block-env", match: { paths: ["**/.env", "**/.env.*"] }, action: "block" },
  { name: "allow-env-example", match: { paths: ["**/.env.example"] }, action: "allow" },
  { name: "redact-secrets", match: { detectors: ["api-key"] }, action: "redact" },
  { name: "local-customer", match: { paths: ["customer-data/**"] }, action: "local-only" },
];

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return { defaultAction: "allow", rules: baseRules, interactive: false, ...overrides };
}

describe("resolvePolicy", () => {
  it("applies the default action when nothing matches", () => {
    const { decisions } = resolvePolicy(input(), [{ relpath: "src/index.ts", findings: [] }]);
    expect(decisions[0]?.action).toBe("allow");
    expect(decisions[0]?.ruleName).toBe("default");
  });

  it("blocks .env files by path", () => {
    const { decisions } = resolvePolicy(input(), [{ relpath: ".env", findings: [] }]);
    expect(decisions[0]?.action).toBe("block");
    expect(decisions[0]?.ruleName).toBe("block-env");
  });

  it("blocks .env.local (glob **/.env.*)", () => {
    const { decisions } = resolvePolicy(input(), [{ relpath: "config/.env.local", findings: [] }]);
    expect(decisions[0]?.action).toBe("block");
  });

  it("most-restrictive-wins: .env.example matches allow AND is not blocked by .env glob", () => {
    // .env.example does NOT match **/.env but matches **/.env.* (block) and allow rule.
    // block is more restrictive, so it wins — demonstrating fail-safe precedence.
    const { decisions } = resolvePolicy(input(), [{ relpath: ".env.example", findings: [] }]);
    expect(decisions[0]?.action).toBe("block");
  });

  it("redacts files with detector findings by rule", () => {
    const { decisions } = resolvePolicy(input(), [
      { relpath: "config/app.ts", findings: [finding("api-key")] },
    ]);
    expect(decisions[0]?.action).toBe("redact");
  });

  it("escalates ANY finding to at least redact even without a detector rule", () => {
    const { decisions } = resolvePolicy(input({ rules: [] }), [
      { relpath: "notes.txt", findings: [finding("high-entropy-string")] },
    ]);
    expect(decisions[0]?.action).toBe("redact");
    expect(decisions[0]?.ruleName).toContain("detector:");
  });

  it("automatically selects deterministic pseudonymization for sensitive tabular data", () => {
    const { decisions } = resolvePolicy(input({ rules: [] }), [
      { relpath: "grades.csv", findings: [finding("tabular-direct-identifier-column")] },
    ]);
    expect(decisions[0]?.action).toBe("prepare-locally");
    expect(decisions[0]?.processors).toEqual(["pseudonymize-student-records", "safety-check"]);
    expect(decisions[0]?.ruleName).toBe("detector:tabular-auto-pseudonymize");
  });

  it("routes an unparsed PDF local-only instead of allow", () => {
    const inspection = {
      fileType: "pdf" as const,
      parserAvailable: false,
      scannerAvailable: false,
      transformers: [],
      verifierAvailable: false,
      inspectionAttempted: false,
      inspectionSucceeded: false,
      contentVerified: false,
    };
    const decision = resolvePolicy(input({ rules: [] }), [
      { relpath: "synthetic.pdf", findings: [], inspection },
    ]).decisions[0];
    expect(decision).toMatchObject({
      action: "local-only",
      ruleName: "file-type:pdf-inspection-unavailable",
    });
    expect(decision).not.toHaveProperty("processors");
  });

  it("never selects an XLSX processor when no parser exists", () => {
    const inspection = {
      fileType: "xlsx" as const,
      parserAvailable: false,
      scannerAvailable: false,
      transformers: [],
      verifierAvailable: false,
      inspectionAttempted: false,
      inspectionSucceeded: false,
      contentVerified: false,
    };
    const decision = resolvePolicy(input({ rules: [] }), [
      {
        relpath: "synthetic.xlsx",
        findings: [finding("tabular-unparsed-spreadsheet")],
        inspection,
      },
    ]).decisions[0];
    expect(decision).toMatchObject({
      action: "local-only",
      ruleName: "file-type:xlsx-inspection-unavailable",
    });
    expect(decision).not.toHaveProperty("processors");
  });

  it("does not allow a file whose available parser did not complete inspection", () => {
    const registered = fileCapabilities("large.txt");
    const decision = resolvePolicy(input({ rules: [] }), [{
      relpath: "large.txt",
      findings: [],
      inspection: {
        ...registered,
        inspectionAttempted: false,
        inspectionSucceeded: false,
        contentVerified: false,
      },
    }]).decisions[0];
    expect(decision).toMatchObject({
      action: "local-only",
      ruleName: "file-type:text-inspection-incomplete",
    });
    expect(decision?.processors).toBeUndefined();
  });

  it("does not allow an explicit raw allow to downgrade sensitive tabular data", () => {
    const rules: PolicyInput["rules"] = [
      { name: "explicit-reviewed-export", match: { paths: ["grades.csv"] }, action: "allow" },
    ];
    const { decisions } = resolvePolicy(input({ rules }), [
      { relpath: "grades.csv", findings: [finding("tabular-direct-identifier-column")] },
    ]);
    expect(decisions[0]?.action).toBe("prepare-locally");
    expect(decisions[0]?.ruleName).toBe("detector:tabular-auto-pseudonymize");
  });

  it("honors an explicit supported local transformation", () => {
    const rules: PolicyInput["rules"] = [{
      name: "pseudonymize-students",
      match: { paths: ["grades.csv"] },
      action: "prepare-locally",
      processors: ["pseudonymize-student-records", "safety-check"],
    }];
    const { decisions } = resolvePolicy(input({ rules }), [
      { relpath: "grades.csv", findings: [finding("tabular-direct-identifier-column")] },
    ]);
    expect(decisions[0]?.action).toBe("prepare-locally");
    expect(decisions[0]?.ruleName).toBe("pseudonymize-students");
  });

  it("does not downgrade block to redact when a secret is present in a blocked file", () => {
    const { decisions } = resolvePolicy(input(), [
      { relpath: ".env", findings: [finding("api-key")] },
    ]);
    expect(decisions[0]?.action).toBe("block");
  });

  it("keeps local-only for customer data", () => {
    const { decisions } = resolvePolicy(input(), [
      { relpath: "customer-data/list.csv", findings: [] },
    ]);
    expect(decisions[0]?.action).toBe("local-only");
    expect(decisions[0]?.destinations).toEqual(["local"]);
  });

  it("ask degrades to block when non-interactive", () => {
    const rules: PolicyInput["rules"] = [
      { name: "ask-rule", match: { paths: ["review/**"] }, action: "ask" },
    ];
    const { decisions } = resolvePolicy(input({ rules, interactive: false }), [
      { relpath: "review/a.md", findings: [] },
    ]);
    expect(decisions[0]?.action).toBe("block");
  });

  it("ask stays ask when interactive", () => {
    const rules: PolicyInput["rules"] = [
      { name: "ask-rule", match: { paths: ["review/**"] }, action: "ask" },
    ];
    const { decisions } = resolvePolicy(input({ rules, interactive: true }), [
      { relpath: "review/a.md", findings: [] },
    ]);
    expect(decisions[0]?.action).toBe("ask");
  });

  it("groups decisions byAction", () => {
    const { byAction } = resolvePolicy(input(), [
      { relpath: "src/a.ts", findings: [] },
      { relpath: ".env", findings: [] },
    ]);
    expect(byAction.allow.length).toBe(1);
    expect(byAction.block.length).toBe(1);
  });
});
