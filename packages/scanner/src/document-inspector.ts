import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DocumentInspectionFile,
  DocumentInspectionResult,
  DocumentInspector,
} from "@yuhi/shared";

const execFileAsync = promisify(execFile);

type LocalCommand = (
  file: string,
  args: string[],
  options?: { maxBuffer?: number; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Common install locations for local CLI tools (pdftotext, pdfinfo, tesseract).
 * A VS Code window launched from Finder/Dock inherits a minimal PATH that omits
 * these, so brew/MacPorts tools would otherwise be unfindable and PDF inspection
 * would fail silently. Appended (not prepended) so a user's PATH still wins.
 */
const EXTRA_TOOL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"];

function commandEnv(): NodeJS.ProcessEnv {
  const current = process.env.PATH ?? "";
  const parts = current.split(path.delimiter).filter(Boolean);
  for (const dir of EXTRA_TOOL_DIRS) if (!parts.includes(dir)) parts.push(dir);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

const defaultCommand: LocalCommand = async (file, args, options) => {
  const result = await execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: options?.maxBuffer ?? 20_000_000,
    timeout: options?.timeout ?? 120_000,
    env: commandEnv(),
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export interface PdfDocumentInspectorOptions {
  runCommand?: LocalCommand;
}

/** Local-only PDF text/OCR inspection. No extracted content is returned or persisted. */
export class PdfDocumentInspector implements DocumentInspector {
  private readonly run: LocalCommand;

  constructor(options: PdfDocumentInspectorOptions = {}) {
    this.run = options.runCommand ?? defaultCommand;
  }

  canInspect(file: DocumentInspectionFile): boolean {
    return path.extname(file.relpath).toLowerCase() === ".pdf";
  }

  async inspect(
    file: DocumentInspectionFile,
    consumeExtractedText: (text: string) => void,
  ): Promise<DocumentInspectionResult> {
    let pageCount: number | undefined;
    const extractionWarnings: string[] = [];
    try {
      const info = await this.run("pdfinfo", [file.absPath], { timeout: 30_000 });
      const match = info.stdout.match(/^Pages:\s+(\d+)$/m);
      if (match) pageCount = Number(match[1]);
    } catch {
      // Page count is optional and never changes the safety decision.
    }

    try {
      const extracted = await this.run("pdftotext", ["-q", file.absPath, "-"], {
        maxBuffer: 30_000_000,
        timeout: 120_000,
      });
      if (extracted.stdout.trim().length > 0) {
        consumeExtractedText(extracted.stdout);
        return {
          status: "inspected",
          extractedTextAvailable: true,
          extractionMethod: "pdf-text",
          ...(pageCount !== undefined ? { pageCount } : {}),
          warnings: [],
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        extractionWarnings.push("pdf-text-extraction-unavailable");
      }
      // A damaged/no-text PDF may still be recoverable through the OCR path.
    }

    const work = await mkdtemp(path.join(tmpdir(), "yuhi-pdf-ocr-"));
    try {
      const prefix = path.join(work, "page");
      try {
        await this.run(
          "pdftoppm",
          ["-png", "-r", "150", file.absPath, prefix],
          { timeout: 180_000 },
        );
      } catch (error) {
        return {
          status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "failed",
          extractedTextAvailable: false,
          extractionMethod: "none",
          ...(pageCount !== undefined ? { pageCount } : {}),
          warnings: [...extractionWarnings, "ocr-render-unavailable"],
        };
      }
      const images = (await readdir(work))
        .filter((name) => /^page-\d+\.png$/i.test(name))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (images.length === 0) {
        return {
          status: "failed",
          extractedTextAvailable: false,
          extractionMethod: "none",
          ...(pageCount !== undefined ? { pageCount } : {}),
          warnings: [...extractionWarnings, "ocr-render-failed"],
        };
      }
      const pages: string[] = [];
      for (const image of images) {
        try {
          const result = await this.run(
            "tesseract",
            [path.join(work, image), "stdout", "--dpi", "150"],
            { maxBuffer: 20_000_000, timeout: 120_000 },
          );
          pages.push(result.stdout);
        } catch (error) {
          return {
            status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "failed",
            extractedTextAvailable: false,
            extractionMethod: "none",
            ...(pageCount !== undefined ? { pageCount } : {}),
            warnings: [...extractionWarnings, "ocr-engine-unavailable"],
          };
        }
      }
      const text = pages.join("\n").trim();
      if (!text) {
        return {
          status: "failed",
          extractedTextAvailable: false,
          extractionMethod: "ocr",
          ...(pageCount !== undefined ? { pageCount } : {}),
          warnings: [...extractionWarnings, "ocr-no-text"],
        };
      }
      consumeExtractedText(text);
      return {
        status: "inspected",
        extractedTextAvailable: true,
        extractionMethod: "ocr",
        ...(pageCount !== undefined ? { pageCount } : {}),
        warnings: [],
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
