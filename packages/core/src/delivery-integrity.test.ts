import { describe, it, expect } from "vitest";
import {
  buildDeliveryIntegritySummary,
  deliveryIntegrityWarnings,
  postTransformScanLabel,
} from "./delivery-integrity.js";
import type { PreparedFileEntry } from "./prepare-workspace.js";

/**
 * Delivery-integrity suite (#12).
 *
 * The defect: `rawFallbackUsed` was typed as the literal `false` and the CLI printed
 * it as a hardcoded string, while a FAILED privacy scan rendered as "Not applicable"
 * and delivered-but-unverified files were counted as "excluded by recommendation".
 * Every surface therefore denied what the manifest had already recorded.
 */

function entry(over: Partial<PreparedFileEntry> = {}): PreparedFileEntry {
  return {
    relpath: "a.csv",
    action: "allow",
    status: "ok",
    transmission: "approved",
    beforeChars: 100,
    afterChars: 100,
    ...over,
  } as PreparedFileEntry;
}

describe("buildDeliveryIntegritySummary", () => {
  it("counts a raw fallback with residue, and never calls it excluded", () => {
    const summary = buildDeliveryIntegritySummary([
      entry({
        relpath: "identifiers.csv",
        outcome: "included-unverified",
        transformed: false,
        rawFallback: true,
        postTransformScan: "failed",
        finalRescanVerified: false,
        failureCategory: "reidentification-risk",
      }),
      entry({ relpath: "ok.csv", transformed: true, postTransformScan: "passed", finalRescanVerified: true }),
    ]);
    expect(summary.rawFallbackFiles).toBe(1);
    expect(summary.rawFallbackWithFindings).toBe(1);
    expect(summary.postTransformScanFailed).toBe(1);
    expect(summary.postTransformScanPassed).toBe(1);
    expect(summary.transformedFiles).toBe(1);
    expect(summary.deliveredWithWarning).toBe(1);
    // The critical assertion: a DELIVERED file is never counted as excluded.
    expect(summary.excludedByRecommendation).toBe(0);
  });

  it("counts only genuinely withheld files as excluded by recommendation", () => {
    const summary = buildDeliveryIntegritySummary([
      entry({ relpath: "kept.csv", omitted: true, outcome: "local-only-transformation-failed" }),
      entry({ relpath: "sent.csv", transformed: true, postTransformScan: "passed" }),
    ]);
    expect(summary.excludedByRecommendation).toBe(1);
    expect(summary.deliveredWithWarning).toBe(0);
  });
});

describe("postTransformScanLabel", () => {
  it("says Failed — never 'Not applicable' — when residue was found", () => {
    const label = postTransformScanLabel(
      buildDeliveryIntegritySummary([
        entry({ postTransformScan: "failed", finalRescanVerified: false }),
      ]),
    );
    expect(label).toMatch(/^Failed/);
    expect(label).not.toMatch(/Not applicable/);
  });

  it("says the scan was not run when a raw representation was delivered", () => {
    const label = postTransformScanLabel(
      buildDeliveryIntegritySummary([
        entry({ rawFallback: true, postTransformScan: "not-applicable" }),
      ]),
    );
    expect(label).toBe("Not run — raw representation delivered");
    expect(label).not.toMatch(/Not applicable/);
  });

  it("says Passed only when a scan actually passed and none failed", () => {
    const label = postTransformScanLabel(
      buildDeliveryIntegritySummary([entry({ transformed: true, postTransformScan: "passed" })]),
    );
    expect(label).toBe("Passed");
  });

  it("never reports Passed while any file failed", () => {
    const label = postTransformScanLabel(
      buildDeliveryIntegritySummary([
        entry({ relpath: "a.csv", transformed: true, postTransformScan: "passed" }),
        entry({ relpath: "b.csv", postTransformScan: "failed", finalRescanVerified: false }),
      ]),
    );
    expect(label).toMatch(/^Failed/);
  });
});

describe("deliveryIntegrityWarnings", () => {
  it("states plainly that an un-de-identified original was included", () => {
    const lines = deliveryIntegrityWarnings(
      buildDeliveryIntegritySummary([
        entry({
          rawFallback: true,
          postTransformScan: "not-applicable",
          finalRescanVerified: false,
          outcome: "included-unverified",
        }),
      ]),
    );
    expect(lines.join("\n")).toMatch(/Delivered with a warning: Yes/);
    expect(lines.join("\n")).toMatch(/Detected identifier residue: 1 file\(s\)/);
    expect(lines.join("\n")).toMatch(/Known identifier findings remain/);
  });

  it("is silent when nothing was delivered raw", () => {
    expect(
      deliveryIntegrityWarnings(
        buildDeliveryIntegritySummary([entry({ transformed: true, postTransformScan: "passed" })]),
      ),
    ).toEqual([]);
  });
});
