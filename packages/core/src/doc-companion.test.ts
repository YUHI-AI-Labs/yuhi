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
  it("does NOT mask structured identifiers itself (0.4.7) — that is wiring.ts's job downstream", () => {
    // Pre-0.4.7 this function masked emails/phones/code-IDs itself with its own
    // «EMAIL:N»-style tokens — unconditionally, including operational IDs like
    // STU2024001, which the taxonomy requires PRESERVED, and using a token format
    // inconsistent with what the SAME value gets in a CSV (`EMAIL-001`). Masking
    // here also ran BEFORE the identity-linkage detection that needs the raw ID
    // value present, breaking cross-format linkage entirely. This function's own
    // output must now carry these values through untouched; only secrets are
    // redacted at this layer.
    const res = buildDocumentCompanion(baseInput());
    expect(res.markdown).toContain("admin@example.com");
    expect(res.markdown).toContain("STU2024001");
    expect(res.markdown).not.toContain("«EMAIL:");
    expect(res.markdown).not.toContain("«ID:");
    expect(res.markdown).not.toContain("«PHONE:");
  });

  it("always reports residual name risk and never claims full anonymization", () => {
    const res = buildDocumentCompanion(baseInput());
    expect(res.residualNameRisk).toBe(true);
    expect(res.markdown).toContain("Residual risk:");
    // Any mention of "anonymized" must be negated ("NOT guaranteed fully anonymized").
    const md = res.markdown.toLowerCase();
    expect(md).toContain("not guaranteed fully anonymized");
    expect(md).not.toContain("is fully anonymized");
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

  it("renders tables as GitHub markdown; cell values pass through for downstream masking", () => {
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
    // Structured identifiers are no longer masked at this layer (see the test above);
    // an operational ID must survive so wiring.ts's linkage detection can find it.
    expect(res.markdown).toContain("alice@school.org");
    expect(res.markdown).toContain("STU2024002");
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
