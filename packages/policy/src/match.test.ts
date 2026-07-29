import { describe, it, expect } from "vitest";
import type { PolicyRule } from "@yuhi/shared";
import { compileRule, ruleMatches } from "./match.js";

function m(rule: PolicyRule, relpath: string): boolean {
  return ruleMatches(compileRule(rule), { relpath, findings: [] }).matched;
}

describe("glob matching", () => {
  const blockEnv: PolicyRule = {
    name: "block-env",
    action: "block",
    match: {
      paths: ["**/.env", "**/.env.*", "!**/.env.example", "!**/.env.sample", "**/credentials.json"],
    },
  };

  it("matches dotfiles (.env at root)", () => {
    expect(m(blockEnv, ".env")).toBe(true);
  });

  it("matches nested env files", () => {
    expect(m(blockEnv, "config/.env.production")).toBe(true);
  });

  it("negation excludes .env.example and .env.sample", () => {
    expect(m(blockEnv, ".env.example")).toBe(false);
    expect(m(blockEnv, ".env.sample")).toBe(false);
  });

  it("still matches other positive patterns alongside negations", () => {
    expect(m(blockEnv, "src/credentials.json")).toBe(true);
  });

  it("does not match unrelated files", () => {
    expect(m(blockEnv, "src/index.ts")).toBe(false);
  });

  it("directory globs match nested content", () => {
    const rule: PolicyRule = {
      name: "customer",
      action: "local-only",
      match: { paths: ["customer-data/**"] },
    };
    expect(m(rule, "customer-data/2026/list.csv")).toBe(true);
    expect(m(rule, "other/list.csv")).toBe(false); // unrelated dir
  });

  it("matches by detector id", () => {
    const rule: PolicyRule = {
      name: "secrets",
      action: "redact",
      match: { detectors: ["api-key"] },
    };
    const res = ruleMatches(compileRule(rule), {
      relpath: "x.ts",
      findings: [
        { detector: "api-key", path: "x.ts", severity: "high", maskedPreview: "****", description: "" },
      ],
    });
    expect(res.matched).toBe(true);
    expect(res.via).toBe("detector");
  });
});
