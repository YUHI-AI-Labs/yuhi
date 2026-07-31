import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { PdfDocumentInspector } from "./document-inspector.js";

const file = { relpath: "synthetic.pdf", absPath: "/synthetic/input.pdf" };

describe("PdfDocumentInspector", () => {
  it("extracts PDF text only through the in-memory consumer", async () => {
    let consumed = "";
    const inspector = new PdfDocumentInspector({
      runCommand: async (command) => {
        if (command === "pdfinfo") return { stdout: "Pages:          2\n", stderr: "" };
        if (command === "pdftotext") {
          return { stdout: "Synthetic document text", stderr: "" };
        }
        throw new Error("unexpected command");
      },
    });
    const result = await inspector.inspect(file, (text) => { consumed = text; });
    expect(result).toEqual({
      status: "inspected",
      extractedTextAvailable: true,
      extractionMethod: "pdf-text",
      pageCount: 2,
      warnings: [],
    });
    expect(consumed).toBe("Synthetic document text");
    expect(JSON.stringify(result)).not.toContain(consumed);
  });

  it("uses local OCR when the PDF has no text layer", async () => {
    let consumed = "";
    const inspector = new PdfDocumentInspector({
      runCommand: async (command, args) => {
        if (command === "pdfinfo") return { stdout: "Pages: 1\n", stderr: "" };
        if (command === "pdftotext") return { stdout: "", stderr: "" };
        if (command === "pdftoppm") {
          await writeFile(`${args.at(-1)!}-1.png`, Buffer.from("synthetic image"));
          return { stdout: "", stderr: "" };
        }
        if (command === "tesseract") return { stdout: "OCR-only synthetic text", stderr: "" };
        throw new Error("unexpected command");
      },
    });
    const result = await inspector.inspect(file, (text) => { consumed = text; });
    expect(result).toMatchObject({
      status: "inspected",
      extractedTextAvailable: true,
      extractionMethod: "ocr",
      pageCount: 1,
    });
    expect(consumed).toBe("OCR-only synthetic text");
    expect(JSON.stringify(result)).not.toContain(consumed);
  });

  it("returns metadata-only unavailable status when local tools cannot inspect", async () => {
    const unavailable = Object.assign(new Error("not found"), { code: "ENOENT" });
    const inspector = new PdfDocumentInspector({
      runCommand: async () => { throw unavailable; },
    });
    const result = await inspector.inspect(file, () => {
      throw new Error("must not receive text");
    });
    expect(result.status).toBe("unavailable");
    expect(result.extractedTextAvailable).toBe(false);
    expect(result.extractionMethod).toBe("none");
    expect(result.warnings).toEqual([
      "pdf-text-extraction-unavailable",
      "ocr-render-unavailable",
    ]);
  });
});
