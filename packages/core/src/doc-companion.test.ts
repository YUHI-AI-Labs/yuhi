import { describe, expect, it } from "vitest";
import { buildDocumentCompanion, type CompanionInput } from "./doc-companion.js";

function baseInput(overrides: Partial<CompanionInput> = {}): CompanionInput {
  return {
    sourceType: "pdf",
    title: "Quarterly Report",
    sections: [
      {
        heading: "Contacts",
        paragraphs: [
          "Reach the office at admin@example.com or call +1 (555) 123-4567.",
          "Student record STU2024001 was updated last week.",
        ],
      },
    ],
    meta: { pages: 3, extractionMethod: "text-layer" },
    ...overrides,
  };
}

describe("buildDocumentCompanion", () => {
  it("redacts emails, phones, and code-like IDs with a positive count", () => {
    const res = buildDocumentCompanion(baseInput());
    expect(res.markdown).not.toContain("admin@example.com");
    expect(res.markdown).not.toContain("555");
    expect(res.markdown).not.toContain("STU2024001");
    expect(res.markdown).toContain("«EMAIL:1»");
    expect(res.markdown).toContain("«PHONE:1»");
    expect(res.markdown).toContain("«ID:1»");
    expect(res.redactionCount).toBeGreaterThan(0);
    // email + phone + id => at least 3 replacements.
    expect(res.redactionCount).toBeGreaterThanOrEqual(3);
  });

  it("gives the same identifier a stable token across blocks", () => {
    const res = buildDocumentCompanion(
      baseInput({
        sections: [
          { paragraphs: ["First: admin@example.com"] },
          { paragraphs: ["Again: admin@example.com"] },
        ],
      }),
    );
    const occurrences = res.markdown.match(/«EMAIL:1»/g) ?? [];
    expect(occurrences.length).toBe(2);
    expect(res.markdown).not.toContain("«EMAIL:2»");
  });

  it("always reports residual name risk and never claims full anonymization", () => {
    const res = buildDocumentCompanion(baseInput());
    expect(res.residualNameRisk).toBe(true);
    expect(res.markdown).toContain(
      "Residual risk: arbitrary personal names in free text may remain",
    );
    // Any mention of "fully anonymized" must be negated ("NOT fully anonymized").
    const md = res.markdown.toLowerCase();
    expect(md).toContain("not fully anonymized");
    expect(md).not.toContain("is fully anonymized");
    expect(md.replace(/not fully anonymized/g, "")).not.toContain("fully anonymized");
    expect(res.warnings.some((w) => /residual risk/i.test(w))).toBe(true);
  });

  it("never emits an absolute path or a filename-looking title", () => {
    const res = buildDocumentCompanion(
      baseInput({
        title: "/Users/someone/secret/report.pdf",
        sections: [
          { paragraphs: ["Extracted from /Users/someone/private/data/file.txt earlier."] },
        ],
      }),
    );
    expect(res.markdown).not.toContain("/Users/someone");
    expect(res.markdown).not.toContain("report.pdf");
    expect(res.markdown).toContain("Untitled document");
    expect(res.markdown).toContain("«PATH»");
  });

  it("renders tables as GitHub markdown and sanitizes their cells", () => {
    const res = buildDocumentCompanion(
      baseInput({
        sections: [
          {
            heading: "Roster",
            paragraphs: [],
            tables: [
              [
                ["Name", "Email", "ID"],
                ["Alice", "alice@school.org", "STU2024002"],
              ],
            ],
          },
        ],
      }),
    );
    expect(res.markdown).toContain("| Name | Email | ID |");
    expect(res.markdown).toContain("| --- | --- | --- |");
    expect(res.markdown).toContain("«EMAIL:1»");
    expect(res.markdown).toContain("«ID:1»");
    expect(res.markdown).not.toContain("alice@school.org");
    expect(res.markdown).not.toContain("STU2024002");
  });

  it("redacts secrets via the shared redactor", () => {
    const res = buildDocumentCompanion(
      baseInput({
        sections: [
          {
            paragraphs: ["api_key = AKIAIOSFODNN7EXAMPLEKEY1234567890abcdef"],
          },
        ],
      }),
    );
    expect(res.markdown).toContain("«REDACTED:");
    expect(res.markdown).not.toContain("AKIAIOSFODNN7EXAMPLEKEY1234567890abcdef");
    expect(res.redactionCount).toBeGreaterThan(0);
  });

  it("surfaces macro / embedded-object / hidden-content warnings without executing them", () => {
    const res = buildDocumentCompanion(
      baseInput({
        sourceType: "pptx",
        meta: {
          slides: 10,
          extractionMethod: "slide-xml",
          macroDetected: true,
          embeddedObjectCount: 2,
          hiddenContent: true,
        },
      }),
    );
    expect(res.warnings.some((w) => /macro/i.test(w))).toBe(true);
    expect(res.warnings.some((w) => /embedded object/i.test(w))).toBe(true);
    expect(res.warnings.some((w) => /hidden content/i.test(w))).toBe(true);
    expect(res.markdown).toContain("NOT executed");
  });
});
