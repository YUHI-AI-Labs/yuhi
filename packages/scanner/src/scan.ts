import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fileCapabilities,
  inspectXlsxRecords,
  type FileInfo,
  type ScanFinding,
  type ScanResult,
  type Severity,
  sha256,
} from "@yuhi/shared";
import { walkRepo } from "./walk.js";
import { looksBinary } from "./binary.js";
import { trackedFiles, isGitRepo } from "./git.js";
import { runDetectors, type DetectorOptions, type Detector } from "./detectors.js";
import { PdfDocumentInspector } from "./document-inspector.js";
import type { DocumentInspector } from "@yuhi/shared";

export interface ScanOptions {
  largeFileBytes: number;
  entropyThreshold: number;
  keywords: string[];
  /** Max bytes to read for secret detection (skip huge files). */
  maxScanBytes?: number;
  detectors?: Detector[];
  explicitIncludeDirs?: ReadonlySet<string>;
  documentInspector?: DocumentInspector;
  /** Mark inspectable documents pending so initial preparation can finish quickly. */
  deferDocumentInspection?: boolean;
  /** In-memory only document text consumer. Callers must not persist raw text. */
  onDocumentText?: (relpath: string, text: string) => void;
}

const DEFAULT_MAX_SCAN_BYTES = 2_000_000;

function emptyRisk(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

export async function scanRepo(root: string, options: ScanOptions): Promise<ScanResult> {
  const absRoot = path.resolve(root);
  const { entries, warnings } = walkRepo(absRoot, {
    ...(options.explicitIncludeDirs !== undefined
      ? { explicitIncludeDirs: options.explicitIncludeDirs }
      : {}),
  });
  const tracked = trackedFiles(absRoot);
  const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  const detectorOpts: DetectorOptions = {
    entropyThreshold: options.entropyThreshold,
    keywords: options.keywords,
  };
  const documentInspector = options.documentInspector ?? new PdfDocumentInspector();

  const files: FileInfo[] = [];
  const allFindings: ScanFinding[] = [];
  const riskSummary = emptyRisk();

  for (const entry of entries) {
    const isLarge = entry.size > options.largeFileBytes;
    const info: FileInfo = {
      relpath: entry.relpath,
      absPath: entry.absPath,
      size: entry.size,
      flags: {
        isBinary: false,
        isSymlink: entry.isSymlink,
        ...(entry.symlinkTarget !== undefined ? { symlinkTarget: entry.symlinkTarget } : {}),
        isLarge,
        ...(tracked !== null ? { tracked: tracked.has(entry.relpath) } : {}),
      },
      findings: [],
      inspection: {
        ...fileCapabilities(entry.relpath),
        inspectionAttempted: false,
        inspectionSucceeded: false,
        contentVerified: false,
      },
    };

    if (entry.isSymlink) {
      warnings.push(`Symlink skipped (not followed): ${entry.relpath}`);
      files.push(info);
      continue;
    }

    // Read for binary detection + secret scan (bounded).
    if (!isLarge && entry.size <= maxScanBytes) {
      let buf: Buffer;
      try {
        buf = readFileSync(entry.absPath);
      } catch {
        warnings.push(`Could not read file: ${entry.relpath}`);
        files.push(info);
        continue;
      }
      info.sha256 = sha256(buf);
      const detectedBinary = looksBinary(buf);
      const capabilities = fileCapabilities(entry.relpath, detectedBinary);
      if (!options.deferDocumentInspection && documentInspector.canInspect(info)) {
        let extractedText = "";
        const documentInspection = await documentInspector.inspect(
          info,
          (text) => { extractedText = text; },
        );
        info.documentInspection = documentInspection;
        info.flags.isBinary = true;
        if (documentInspection.status === "inspected" && extractedText.length > 0) {
          options.onDocumentText?.(entry.relpath, extractedText);
          info.inspection = {
            ...capabilities,
            parserAvailable: true,
            scannerAvailable: true,
            verifierAvailable: true,
            inspectionAttempted: true,
            inspectionSucceeded: true,
            contentVerified: true,
          };
          const findings = runDetectors(
            extractedText,
            { ...detectorOpts, relpath: entry.relpath },
            options.detectors,
          ).map((finding) => ({ ...finding, path: entry.relpath }));
          const personalPatterns = [
            { detector: "document-personal-email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
            { detector: "document-personal-phone", pattern: /(?:\+\d{1,3}[- ]?)?(?:\(\d{2,4}\)[- ]?)?\d{2,4}[- ]\d{2,4}[- ]\d{3,4}/ },
            { detector: "document-personal-address", pattern: /(?:住所|address)\s*[:：]/i },
            { detector: "document-personal-name", pattern: /(?:氏名|full\s*name|name)\s*[:：]/i },
          ];
          for (const personal of personalPatterns) {
            if (personal.pattern.test(extractedText)) {
              findings.push({
                detector: personal.detector,
                path: entry.relpath,
                severity: "medium",
                maskedPreview: "[possible personal information]",
                description: "Document contains possible personal information",
              });
            }
          }
          const documentSecrets = [
            {
              detector: "document-credential-assignment",
              pattern: /(?:password|passwd|pwd|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S+/i,
            },
            {
              detector: "document-private-url",
              pattern: /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/i,
            },
          ];
          for (const secret of documentSecrets) {
            if (secret.pattern.test(extractedText)) {
              findings.push({
                detector: secret.detector,
                path: entry.relpath,
                severity: "high",
                maskedPreview: "[document secret-like content]",
                description: "Document contains secret-like content",
              });
            }
          }
          info.findings = findings;
          for (const finding of findings) {
            allFindings.push(finding);
            riskSummary[finding.severity] += 1;
          }
          extractedText = "";
        } else {
          info.inspection = {
            ...capabilities,
            inspectionAttempted: true,
            inspectionSucceeded: false,
            contentVerified: false,
          };
        }
      } else if (/\.xlsx$/i.test(entry.relpath) && capabilities.parserAvailable) {
        info.flags.isBinary = true;
        try {
          const workbook = await inspectXlsxRecords(buf);
          info.inspection = {
            ...capabilities,
            inspectionAttempted: true,
            inspectionSucceeded: true,
            contentVerified: true,
          };
          const findings: ScanFinding[] = [];
          if (workbook.directIdentifierColumns > 0) {
            findings.push({
              detector: "tabular-direct-identifier-column",
              path: entry.relpath,
              severity: workbook.associatedDataPresent ? "high" : "medium",
              maskedPreview: "[identifier columns detected]",
              description: "Workbook contains direct-identifier columns",
            });
          }
          if (workbook.associatedDataPresent) {
            findings.push({
              detector: "tabular-education-performance",
              path: entry.relpath,
              severity: workbook.directIdentifierColumns > 0 ? "high" : "medium",
              maskedPreview: "[analytical columns detected]",
              description: "Workbook contains associated analytical data",
            });
          }
          info.findings = findings;
          for (const finding of findings) {
            allFindings.push(finding);
            riskSummary[finding.severity] += 1;
          }
        } catch {
          info.inspection = {
            ...capabilities,
            inspectionAttempted: true,
            inspectionSucceeded: false,
            contentVerified: false,
          };
          const finding: ScanFinding = {
            detector: "tabular-unparsed-spreadsheet",
            path: entry.relpath,
            severity: "high",
            maskedPreview: "[spreadsheet kept local]",
            description: "Spreadsheet could not be parsed and verified locally",
          };
          info.findings = [finding];
          allFindings.push(finding);
          riskSummary.high += 1;
        }
      } else if (detectedBinary || !capabilities.parserAvailable) {
        info.flags.isBinary = detectedBinary;
        info.inspection = {
          ...capabilities,
          inspectionAttempted: false,
          inspectionSucceeded: false,
          contentVerified: false,
        };
      } else {
        info.inspection = {
          ...fileCapabilities(entry.relpath, false),
          inspectionAttempted: true,
          inspectionSucceeded: true,
          contentVerified: true,
        };
        const content = buf.toString("utf8");
        const findings = runDetectors(
          content,
          { ...detectorOpts, relpath: entry.relpath },
          options.detectors,
        ).map((f) => ({
          ...f,
          path: entry.relpath,
        }));
        info.findings = findings;
        for (const f of findings) {
          allFindings.push(f);
          riskSummary[f.severity]++;
        }
      }
    } else {
      // Large file: flag but do not read for detection.
      info.flags.isBinary = false;
    }

    files.push(info);
  }

  return {
    root: absRoot,
    filesInspected: files.length,
    files,
    findings: allFindings,
    riskSummary,
    warnings,
  };
}

export { isGitRepo };
