import { describe, it, expect } from "vitest";
import { runDetectors } from "./detectors.js";
import { shannonEntropy, maskSecret } from "./entropy.js";

const opts = { entropyThreshold: 4.0, keywords: [] as string[] };
const csvOpts = { ...opts, relpath: "synthetic.csv" };

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

  it("detects structured personal-data headers without retaining row values", () => {
    const findings = runDetectors(
      "\uFEFFフルネーム,IDナンバ,学生証番号,評定\nSynthetic Person,100001,200001,A",
      csvOpts,
    );
    const finding = findings.find((item) => item.detector === "tabular-direct-identifier-column");
    expect(finding?.severity).toBe("high");
    expect(JSON.stringify(finding)).not.toContain("Synthetic Person");
    expect(JSON.stringify(finding)).not.toContain("100001");
  });

  it.each([
    ["employee and salary", "employee id,salary\nE-1,100\n", "tabular-associated-salary"],
    ["names and email", "full name,email\nSynthetic A,a@example.test\n", "tabular-direct-identifier-column"],
    ["phone", "name,phone number\nSynthetic A,+1-555-0000\n", "tabular-direct-identifier-column"],
    ["grades only", "grade,quiz\nA,8\n", "tabular-associated-education-performance"],
  ])("detects %s tables using metadata-only findings", (_label, content, detector) => {
    const findings = runDetectors(content, csvOpts);
    expect(findings.some((finding) => finding.detector === detector)).toBe(true);
    expect(JSON.stringify(findings)).not.toContain("Synthetic A");
    expect(JSON.stringify(findings)).not.toContain("E-1");
  });

  it("fails closed on a malformed sensitive CSV header", () => {
    const findings = runDetectors('full name,student id,grade\n"unterminated', csvOpts);
    expect(findings.some((finding) => finding.detector === "tabular-malformed-sensitive-data"))
      .toBe(true);
  });

  it("does not infer a structured table from an ordinary text file", () => {
    const findings = runDetectors(
      "name\nThis is ordinary prose and not a delimited table.",
      { ...opts, relpath: "notes.txt" },
    );
    expect(findings.some((finding) => finding.detector.startsWith("tabular-"))).toBe(false);
  });

  it("fails closed on a repeated headerless identifier-and-score text table", () => {
    const content = Array.from(
      { length: 20 },
      (_, index) => `123456,${String(300000 + index)},${index % 101}`,
    ).join("\n");
    const findings = runDetectors(content, { ...opts, relpath: "synthetic.txt" });
    // Value-based detection now positively recognizes the unique fixed-width
    // numeric column as a direct identifier (better than the vague headerless
    // heuristic), so the table is still flagged sensitive and — in the prepare
    // pipeline — routed to pseudonymization rather than copied verbatim.
    expect(findings.some((finding) =>
      finding.detector === "tabular-direct-identifier-column" ||
      finding.detector === "tabular-headerless-sensitive-data"
    )).toBe(true);
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
