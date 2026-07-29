import { readFileSync } from "node:fs";
import path from "node:path";
import { type FileInfo, type ScanFinding, type ScanResult, type Severity, sha256 } from "@yuhi/shared";
import { walkRepo } from "./walk.js";
import { looksBinary } from "./binary.js";
import { trackedFiles, isGitRepo } from "./git.js";
import { runDetectors, type DetectorOptions, type Detector } from "./detectors.js";

export interface ScanOptions {
  largeFileBytes: number;
  entropyThreshold: number;
  keywords: string[];
  /** Max bytes to read for secret detection (skip huge files). */
  maxScanBytes?: number;
  detectors?: Detector[];
}

const DEFAULT_MAX_SCAN_BYTES = 2_000_000;

function emptyRisk(): Record<Severity, number> {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

export function scanRepo(root: string, options: ScanOptions): ScanResult {
  const absRoot = path.resolve(root);
  const { entries, warnings } = walkRepo(absRoot);
  const tracked = trackedFiles(absRoot);
  const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  const detectorOpts: DetectorOptions = {
    entropyThreshold: options.entropyThreshold,
    keywords: options.keywords,
  };

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
      if (looksBinary(buf)) {
        info.flags.isBinary = true;
      } else {
        const content = buf.toString("utf8");
        const findings = runDetectors(content, detectorOpts, options.detectors).map((f) => ({
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
