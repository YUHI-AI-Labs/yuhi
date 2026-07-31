import { extractDocx, extractPptx } from "@yuhi/shared";
import { buildDocumentCompanion, type CompanionInput } from "./doc-companion.js";

/** PDFs are extracted/companion-ised up to this size; larger ones get a placeholder. */
export const PDF_INSPECTION_LIMIT_BYTES = 64 * 1024 * 1024;
/** DOCX/PPTX are unzipped/extracted up to this size; larger ones get a placeholder. */
export const OFFICE_DOCUMENT_INSPECTION_LIMIT_BYTES = 128 * 1024 * 1024;

export type DocumentSourceType = "pdf" | "docx" | "pptx" | "docm" | "pptm";

/**
 * Stable, machine-readable reason a document was kept local instead of shared.
 * Distinct from the human-readable `reason` line in the placeholder markdown, and
 * from the delivery state (`local-only`): this says WHY, not WHAT-happened-to-it.
 */
export type DocumentReasonCode =
  | "document-extraction-failed"
  | "document-unsupported"
  | "document-encrypted"
  | "document-empty"
  | "document-oversize";

export interface DocumentArtifact {
  /** What was actually written to the Prepared Workspace. */
  kind: "companion" | "placeholder";
  markdown: string;
  sourceType: DocumentSourceType;
  extractionMethod: string;
  extractionStatus: "extracted" | "unsupported" | "failed" | "skipped-oversize";
  /** Set only on placeholders (kept-local documents); absent when extracted. */
  reasonCode?: DocumentReasonCode;
  redactionCount: number;
  residualNameRisk: boolean;
  macroDetected: boolean;
  embeddedObjectCount: number;
  imageCount: number;
  hiddenContentDetected: boolean;
  extractedParagraphCount: number;
  extractedTableCount: number;
  extractedSlideCount: number;
  extractedNotesCount: number;
  warnings: string[];
}

/** Injected so tests (and the pdftotext-less path) don't need the external binary. */
export type PdfTextExtractor = (
  absPath: string,
) => Promise<{ text: string; method: "pdf-text" | "ocr" | "none"; pageCount?: number }>;

/**
 * Human-readable original size. Reports bytes/KB so a small file is never rounded
 * to a misleading "0.0 MB"; only genuinely-large files are shown in MB.
 */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown";
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  const mb = bytes / 1_000_000;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** Base for a document that is intentionally NOT shared with the agent. */
function placeholder(
  sourceType: DocumentSourceType,
  reason: string,
  reasonCode: DocumentReasonCode,
  sizeBytes: number,
  extra: Partial<DocumentArtifact> = {},
): DocumentArtifact {
  const label = sourceType.toUpperCase();
  const markdown = [
    `# ${label} kept local`,
    "",
    `Yuhi did not share the original ${label} file with the AI agent.`,
    "",
    `- Source type: ${label}`,
    "- Inspection status: unverified",
    `- Reason: ${reason}`,
    "- Original file shared with agent: no",
    `- Original size: ${formatSize(sizeBytes)}`,
    "",
    "The document may contain information relevant to the task, but its contents were not verified or exposed.",
    "",
    "Ask the user for a summary, plain-text export, PDF export, or smaller version if the document is required.",
    "",
  ].join("\n");
  return {
    kind: "placeholder",
    markdown,
    sourceType,
    reasonCode,
    extractionMethod: "none",
    extractionStatus: extra.extractionStatus ?? "failed",
    redactionCount: 0,
    residualNameRisk: false,
    macroDetected: extra.macroDetected ?? false,
    embeddedObjectCount: extra.embeddedObjectCount ?? 0,
    imageCount: extra.imageCount ?? 0,
    hiddenContentDetected: extra.hiddenContentDetected ?? false,
    extractedParagraphCount: 0,
    extractedTableCount: 0,
    extractedSlideCount: 0,
    extractedNotesCount: 0,
    warnings: extra.warnings ?? [reason],
  };
}

function fromCompanion(
  sourceType: DocumentSourceType,
  input: CompanionInput,
  counts: Partial<DocumentArtifact>,
): DocumentArtifact {
  const result = buildDocumentCompanion(input);
  return {
    kind: "companion",
    markdown: result.markdown,
    sourceType,
    extractionMethod: input.meta.extractionMethod,
    extractionStatus: "extracted",
    redactionCount: result.redactionCount,
    residualNameRisk: result.residualNameRisk,
    macroDetected: input.meta.macroDetected ?? false,
    embeddedObjectCount: input.meta.embeddedObjectCount ?? 0,
    imageCount: input.meta.imageCount ?? 0,
    hiddenContentDetected: input.meta.hiddenContent ?? false,
    extractedParagraphCount: counts.extractedParagraphCount ?? 0,
    extractedTableCount: counts.extractedTableCount ?? 0,
    extractedSlideCount: counts.extractedSlideCount ?? 0,
    extractedNotesCount: counts.extractedNotesCount ?? 0,
    warnings: [...result.warnings, ...(counts.warnings ?? [])],
  };
}

/**
 * Build the artifact Yuhi delivers for a document — a sanitized Markdown companion
 * when local extraction succeeds within limits, otherwise a safe placeholder. The
 * ORIGINAL is never returned/delivered. Never throws: any failure yields a
 * placeholder so preparation continues (per-file isolation).
 */
export async function buildDocumentArtifact(opts: {
  sourceType: DocumentSourceType;
  absPath: string;
  sizeBytes: number;
  readBuffer: () => Promise<Buffer>;
  extractPdfText?: PdfTextExtractor;
}): Promise<DocumentArtifact> {
  const { sourceType, sizeBytes } = opts;
  const isPdf = sourceType === "pdf";
  const limit = isPdf ? PDF_INSPECTION_LIMIT_BYTES : OFFICE_DOCUMENT_INSPECTION_LIMIT_BYTES;
  const limitLabel = isPdf ? "64 MB PDF inspection limit" : "128 MB document inspection limit";

  if (sizeBytes > limit) {
    return placeholder(sourceType, `Over the ${limitLabel}; not inspected`, "document-oversize", sizeBytes, {
      extractionStatus: "skipped-oversize",
      warnings: [`Over the ${limitLabel}; not inspected.`],
    });
  }

  try {
    if (sourceType === "docx" || sourceType === "docm") {
      const buf = await opts.readBuffer();
      const ex = await extractDocx(buf);
      if (ex.status !== "extracted") {
        const { reason, code } = extractionFailure(sourceType, ex.status);
        return placeholder(sourceType, reason, code, sizeBytes, {
          extractionStatus: ex.status,
          macroDetected: ex.macroDetected,
          warnings: ex.warnings,
        });
      }
      const sections: CompanionInput["sections"] = [];
      if (ex.paragraphs.length) sections.push({ paragraphs: ex.paragraphs });
      if (ex.headersFooters.length) sections.push({ heading: "Headers & footers", paragraphs: ex.headersFooters });
      if (ex.footnotes.length) sections.push({ heading: "Footnotes / endnotes", paragraphs: ex.footnotes });
      if (ex.comments.length) sections.push({ heading: "Comments", paragraphs: ex.comments });
      for (const t of ex.tables) sections.push({ heading: "Table", paragraphs: [], tables: [t] });
      return fromCompanion(sourceType, {
        sourceType: "docx",
        ...(ex.title ? { title: ex.title } : {}),
        sections,
        meta: {
          extractionMethod: "docx-xml",
          macroDetected: ex.macroDetected,
          embeddedObjectCount: ex.embeddedObjectCount,
          imageCount: ex.imageCount,
          hiddenContent: ex.trackedChangesDetected,
        },
      }, {
        extractedParagraphCount: ex.paragraphs.length,
        extractedTableCount: ex.tables.length,
        warnings: [
          ...(ex.macroDetected ? ["Macro (VBA) present — not executed, not shared."] : []),
          ...(ex.embeddedObjectCount ? [`${ex.embeddedObjectCount} embedded object(s) not inspected.`] : []),
          ...(ex.imageCount ? [`${ex.imageCount} image(s): text inside images not inspected.`] : []),
          ...(ex.trackedChangesDetected ? ["Tracked changes / hidden text present."] : []),
        ],
      });
    }

    if (sourceType === "pptx" || sourceType === "pptm") {
      const buf = await opts.readBuffer();
      const ex = await extractPptx(buf);
      if (ex.status !== "extracted") {
        const { reason, code } = extractionFailure(sourceType, ex.status);
        return placeholder(sourceType, reason, code, sizeBytes, {
          extractionStatus: ex.status,
          macroDetected: ex.macroDetected,
          warnings: ex.warnings,
        });
      }
      const sections: CompanionInput["sections"] = [];
      let notes = 0;
      for (const slide of ex.slides) {
        const paras = [...slide.body];
        if (slide.notes.length) { paras.push("Speaker notes:", ...slide.notes); notes += 1; }
        sections.push({
          heading: `Slide ${slide.index + 1}${slide.title ? ` — ${slide.title}` : ""}`,
          paragraphs: paras,
          ...(slide.tables.length ? { tables: slide.tables } : {}),
        });
      }
      return fromCompanion(sourceType, {
        sourceType: "pptx",
        sections,
        meta: {
          slides: ex.slides.length,
          extractionMethod: "pptx-xml",
          macroDetected: ex.macroDetected,
          embeddedObjectCount: ex.embeddedObjectCount,
          imageCount: ex.imageCount,
          hiddenContent: ex.hiddenSlideCount > 0,
        },
      }, {
        extractedSlideCount: ex.slides.length,
        extractedNotesCount: notes,
        warnings: [
          ...(ex.macroDetected ? ["Macro (VBA) present — not executed, not shared."] : []),
          ...(ex.hiddenSlideCount ? [`${ex.hiddenSlideCount} hidden slide(s) detected.`] : []),
          ...(ex.embeddedObjectCount ? [`${ex.embeddedObjectCount} embedded object(s) not inspected.`] : []),
          ...(ex.imageCount ? [`${ex.imageCount} image(s): text inside images not inspected.`] : []),
        ],
      });
    }

    // PDF
    if (!opts.extractPdfText) {
      return placeholder("pdf", "Local PDF text extraction is unavailable (pdftotext not found)", "document-unsupported", sizeBytes, {
        extractionStatus: "unsupported",
      });
    }
    const { text, method, pageCount } = await opts.extractPdfText(opts.absPath);
    if (method === "none" || text.trim().length === 0) {
      return placeholder("pdf", "No extractable text (empty, encrypted, or image-only with no OCR)", "document-empty", sizeBytes, {
        extractionStatus: "failed",
      });
    }
    // Split on form-feed (pdftotext page separator) into page sections.
    const pages = text.split("\f").map((p) => p.trim()).filter(Boolean);
    const sections: CompanionInput["sections"] = pages.map((page, i) => ({
      heading: `Page ${i + 1}`,
      paragraphs: page.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean),
    }));
    return fromCompanion("pdf", {
      sourceType: "pdf",
      sections: sections.length ? sections : [{ paragraphs: [text] }],
      meta: {
        ...(pageCount !== undefined ? { pages: pageCount } : {}),
        extractionMethod: method === "ocr" ? "ocr" : "pdftotext",
      },
    }, {
      extractedParagraphCount: sections.reduce((n, s) => n + s.paragraphs.length, 0),
      warnings: method === "ocr" ? ["Text recovered via OCR; accuracy may vary."] : [],
    });
  } catch (error) {
    return placeholder(
      sourceType,
      `Text extraction failed (${error instanceof Error ? error.name : "error"})`,
      "document-extraction-failed",
      sizeBytes,
    );
  }
}

/** Map an extractor status to a human reason + stable machine reason code. */
function extractionFailure(
  sourceType: DocumentSourceType,
  status: "unsupported" | "failed",
): { reason: string; code: DocumentReasonCode } {
  if (status === "unsupported") {
    return {
      reason: `Unsupported or malformed ${sourceType.toUpperCase()} (not a readable Office document)`,
      code: "document-unsupported",
    };
  }
  return { reason: "Text extraction failed", code: "document-extraction-failed" };
}
