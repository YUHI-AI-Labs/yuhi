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

  it("a PDF with extractable text becomes a sanitized companion; structured PII is redacted", async () => {
    const a = await buildDocumentArtifact({
      sourceType: "pdf",
      absPath: "/x/report.pdf",
      sizeBytes: 10_000,
      readBuffer: noBuffer,
      extractPdfText: async () => ({
        text: "Contact taro.yamada@example.ac.jp or 090-1234-5678. Student A000000 passed.",
        method: "pdf-text",
        pageCount: 3,
      }),
    });
    expect(a.kind).toBe("companion");
    expect(a.extractionStatus).toBe("extracted");
    expect(a.redactionCount).toBeGreaterThan(0);
    expect(a.residualNameRisk).toBe(true);
    // Structured identifiers are redacted out of the companion.
    expect(a.markdown).not.toContain("taro.yamada@example.ac.jp");
    expect(a.markdown).not.toContain("090-1234-5678");
    expect(a.markdown).not.toContain("A000000");
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
