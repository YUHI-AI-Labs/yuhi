import { describe, it, expect } from "vitest";
import { runDetectors } from "./detectors.js";
import { shannonEntropy, maskSecret } from "./entropy.js";

const opts = { entropyThreshold: 4.0, keywords: [] as string[] };

describe("detectors", () => {
  it("detects an AWS access key id and does NOT leak the raw value", () => {
    const raw = "AKIA" + "IOSFODNN7EXAMPLE";
    const findings = runDetectors(`const k = "${raw}"`, opts);
    const f = findings.find((x) => x.detector === "api-key");
    expect(f).toBeTruthy();
    expect(f!.maskedPreview).not.toContain("IOSFODNN7EXAMPLE");
    expect(f!.maskedPreview).toContain("*");
  });

  it("detects a PEM private key block as critical", () => {
    const findings = runDetectors("-----BEGIN RSA " + "PRIVATE " + "KEY-----\nabc", opts);
    const f = findings.find((x) => x.detector === "private-key");
    expect(f?.severity).toBe("critical");
  });

  it("detects an Anthropic-style key", () => {
    const findings = runDetectors('KEY="' + "sk-ant-" + 'api03-abcdefghijklmnopqrstuvwxyz012345"', opts);
    expect(findings.some((f) => f.detector === "api-key")).toBe(true);
  });

  it("detects a database url with embedded credentials", () => {
    const findings = runDetectors("DATABASE_URL=postgres://user:s3cr3t@db.example.com:5432/app", opts);
    expect(findings.some((f) => f.detector === "database-url")).toBe(true);
  });

  it("does not flag ordinary source code", () => {
    const findings = runDetectors("export function add(a: number, b: number) { return a + b; }", opts);
    expect(findings.length).toBe(0);
  });

  it("flags high-entropy strings only near secret-like assignments", () => {
    const secretish = 'const apiKey = "Zx9Qw3Er7Ty1Ui5Op2As6Df4Gh8Jk0Lm3Zx9Qw"';
    const boring = 'const path = "src/components/very/deep/nested/directory/file"';
    expect(runDetectors(secretish, opts).some((f) => f.detector === "high-entropy-string")).toBe(true);
    expect(runDetectors(boring, opts).some((f) => f.detector === "high-entropy-string")).toBe(false);
  });

  it("supports user keywords", () => {
    const findings = runDetectors("Project Poseidon is confidential", {
      entropyThreshold: 4,
      keywords: ["Poseidon"],
    });
    expect(findings.some((f) => f.detector === "user-keyword")).toBe(true);
  });
});

describe("entropy + masking", () => {
  it("computes higher entropy for random-looking strings", () => {
    expect(shannonEntropy("aaaaaaaa")).toBeLessThan(shannonEntropy("aZ4$kP9!"));
  });

  it("maskSecret never returns the full value", () => {
    const v = "SUPERSECRETVALUE1234567890";
    expect(maskSecret(v)).not.toContain("SECRETVALUE");
  });
});
