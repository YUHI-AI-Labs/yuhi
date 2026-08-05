import { describe, it, expect } from "vitest";
import {
  buildDocumentArtifact,
  PDF_INSPECTION_LIMIT_BYTES,
} from "./document-artifact.js";

const noBuffer = async (): Promise<Buffer> => Buffer.alloc(0);

describe("buildDocumentArtifact", () => {
  it("a PDF over 64 MB gets a safe placeholder, never the original", async () => {
    const a = await buildDocumentArtifact({
      sourceType: "pdf",
      absPath: "/x/big.pdf",
      sizeBytes: PDF_INSPECTION_LIMIT_BYTES + 1,
      readBuffer: noBuffer,
    });
    expect(a.kind).toBe("placeholder");
    expect(a.extractionStatus).toBe("skipped-oversize");
    expect(a.markdown).toContain("kept local");
    expect(a.markdown).toContain("Original file shared with agent: no");
    expect(a.markdown).toContain("64 MB");
  });

  it("a PDF with extractable text becomes a companion; secrets are redacted, structured/personal identifiers pass through for downstream masking", async () => {
    // At THIS layer (`buildDocumentArtifact` -> `buildDocumentCompanion`), only
    // secrets are redacted (0.4.7, `docs/design/0.4.7_document_privacy.md`). Emails,
    // phone numbers, and operational IDs must survive unchanged here: masking them
    // at this layer, before the shared taxonomy pipeline runs, both used a token
    // format inconsistent with tabular output (`EMAIL-001` vs. the old `«EMAIL:1»`)
    // and — for an operational id like a student number — was actively wrong, since
    // operational identifiers must be PRESERVED, not masked (identifier-taxonomy.ts).
    // The real, taxonomy-aware masking runs downstream in
    // `packages/core/src/background/wiring.ts`'s pseudonymizer.
    const a = await buildDocumentArtifact({
      sourceType: "pdf",
      absPath: "/x/report.pdf",
      sizeBytes: 10_000,
      readBuffer: noBuffer,
      extractPdfText: async () => ({
        text:
          "Contact taro.yamada@example.ac.jp or 090-1234-5678. Student A000000 passed. " +
          "api_key = AKIAIOSFODNN7EXAMPLEKEY1234567890abcdef",
        method: "pdf-text",
        pageCount: 3,
      }),
    });
    expect(a.kind).toBe("companion");
    expect(a.extractionStatus).toBe("extracted");
    // Only the secret is redacted at this layer.
    expect(a.redactionCount).toBeGreaterThan(0);
    expect(a.markdown).not.toContain("AKIAIOSFODNN7EXAMPLEKEY1234567890abcdef");
    expect(a.residualNameRisk).toBe(true);
    // Email, phone, and the operational student id survive THIS layer unchanged.
    expect(a.markdown).toContain("taro.yamada@example.ac.jp");
    expect(a.markdown).toContain("090-1234-5678");
    expect(a.markdown).toContain("A000000");
    // Never leaks the source path.
    expect(a.markdown).not.toContain("/x/report.pdf");
    // Honest residual-name language, not "fully anonymized".
    expect(a.markdown.toLowerCase()).toContain("residual");
  });

  it("an empty/encrypted PDF (no text) gets a placeholder, never the original", async () => {
    const a = await buildDocumentArtifact({
      sourceType: "pdf",
      absPath: "/x/enc.pdf",
      sizeBytes: 10_000,
      readBuffer: noBuffer,
      extractPdfText: async () => ({ text: "", method: "none" }),
    });
    expect(a.kind).toBe("placeholder");
    expect(a.markdown).toContain("Original file shared with agent: no");
  });

  it("a PDF with no extractor available gets a placeholder (never raw)", async () => {
    const a = await buildDocumentArtifact({
      sourceType: "pdf",
      absPath: "/x/x.pdf",
      sizeBytes: 10_000,
      readBuffer: noBuffer,
    });
    expect(a.kind).toBe("placeholder");
    expect(a.extractionStatus).toBe("unsupported");
  });

  it("a corrupt DOCX buffer yields a placeholder without throwing", async () => {
    const a = await buildDocumentArtifact({
      sourceType: "docx",
      absPath: "/x/broken.docx",
      sizeBytes: 500,
      readBuffer: async () => Buffer.from("not a zip"),
    });
    expect(a.kind).toBe("placeholder");
    expect(a.markdown).toContain("Original file shared with agent: no");
  });
});
