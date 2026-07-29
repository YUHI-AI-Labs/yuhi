import { describe, it, expect } from "vitest";
import type { PolicyInput, ScanFinding } from "@yuhi/shared";
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
