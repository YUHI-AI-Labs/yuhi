import type { PreparedFileEntry } from "./prepare-workspace.js";

/**
 * The delivery facts every public surface must agree on (#12).
 *
 * Render layers MUST read this and MUST NOT re-derive or hardcode any of it. The
 * regression this prevents: the CLI printed `Raw fallback used: No` as a literal
 * string and mapped a FAILED privacy scan to "Not applicable", while the manifest
 * for the same run recorded `identifierLeaks: 1` — so the surface a user actually
 * reads denied what Yuhi had already detected.
 */
export interface DeliveryIntegritySummary {
  /** Delivered files whose bytes differ from source because Yuhi transformed them. */
  transformedFiles: number;
  /** Delivered files where the UNTRANSFORMED original was shipped as a fallback. */
  rawFallbackFiles: number;
  /** Of those, how many carry known identifier findings in the delivered bytes. */
  rawFallbackWithFindings: number;
  postTransformScanPassed: number;
  postTransformScanFailed: number;
  postTransformScanNotApplicable: number;
  /** Files genuinely withheld from the agent-visible tree. Never counts a delivery. */
  excludedByRecommendation: number;
  /** Delivered files carrying an explicit warning (unverified / inspection-pending). */
  deliveredWithWarning: number;
}

/** True when this entry is present in the agent-visible tree. */
function isDelivered(file: PreparedFileEntry): boolean {
  return file.omitted !== true;
}

export function buildDeliveryIntegritySummary(
  files: readonly PreparedFileEntry[],
): DeliveryIntegritySummary {
  let transformedFiles = 0;
  let rawFallbackFiles = 0;
  let rawFallbackWithFindings = 0;
  let postTransformScanPassed = 0;
  let postTransformScanFailed = 0;
  let postTransformScanNotApplicable = 0;
  let excludedByRecommendation = 0;
  let deliveredWithWarning = 0;

  for (const file of files) {
    if (!isDelivered(file)) {
      excludedByRecommendation += 1;
      continue;
    }
    if (file.transformed === true) transformedFiles += 1;
    if (file.rawFallback === true) {
      rawFallbackFiles += 1;
      // "Findings remain" means the delivered bytes were checked and residue found.
      if (file.finalRescanVerified === false || file.failureCategory === "reidentification-risk") {
        rawFallbackWithFindings += 1;
      }
    }
    switch (file.postTransformScan) {
      case "passed":
        postTransformScanPassed += 1;
        break;
      case "failed":
        postTransformScanFailed += 1;
        break;
      case "not-applicable":
        postTransformScanNotApplicable += 1;
        break;
      default:
        // No scan verdict recorded: the file was never a transformation candidate.
        postTransformScanNotApplicable += 1;
    }
    if (
      file.outcome === "included-unverified" ||
      file.availabilityStatus === "available-with-warning" ||
      file.warningCode !== undefined
    ) {
      deliveredWithWarning += 1;
    }
  }

  return {
    transformedFiles,
    rawFallbackFiles,
    rawFallbackWithFindings,
    postTransformScanPassed,
    postTransformScanFailed,
    postTransformScanNotApplicable,
    excludedByRecommendation,
    deliveredWithWarning,
  };
}

/** Copy for the post-transformation scan line. Never says "Not applicable" for a failure. */
export function postTransformScanLabel(summary: DeliveryIntegritySummary): string {
  if (summary.postTransformScanFailed > 0) {
    return `Failed — ${summary.postTransformScanFailed} file(s) still contain identifier residue`;
  }
  if (summary.rawFallbackFiles > 0 && summary.postTransformScanPassed === 0) {
    return "Not run — raw representation delivered";
  }
  if (summary.postTransformScanPassed > 0) return "Passed";
  return "Not run — nothing required transformation";
}

/** Human-readable warnings a surface must show when raw originals were delivered. */
export function deliveryIntegrityWarnings(summary: DeliveryIntegritySummary): string[] {
  const lines: string[] = [];
  if (summary.rawFallbackFiles > 0) {
    lines.push(
      `Delivered with a warning: Yes — ${summary.rawFallbackFiles} file(s) delivered as the ` +
        "original because a safe transformation could not be verified",
    );
  }
  if (summary.rawFallbackWithFindings > 0) {
    lines.push(
      `Detected identifier residue: ${summary.rawFallbackWithFindings} file(s)`,
    );
    lines.push("Known identifier findings remain in the delivered raw representation");
  }
  return lines;
}
