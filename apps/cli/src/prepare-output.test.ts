import { describe, expect, it } from "vitest";
import type { PrepareReport } from "@yuhi/core";
import {
  buildCliPrepareResult,
  cliPrepareExitCode,
  formatCliPrepareResult,
} from "./prepare-output.js";

function report(partial = false): PrepareReport {
  const error = {
    relpath: "synthetic-malformed.csv",
    action: "local-only" as const,
    status: "error" as const,
    transmission: "blocked" as const,
    beforeChars: 10,
    afterChars: 0,
    omitted: true,
    error: "Malformed delimited table: synthetic",
  };
  return {
    runId: partial ? "run-partial" : "run-success",
    outDir: "/not-for-output",
    report: {
      beforeChars: 400,
      afterChars: 200,
      beforeTokens: 100,
      afterTokens: 50,
      tokensSaved: 50,
      percentReduction: 0.5,
      hasData: true,
      filesExcluded: partial ? 1 : 0,
      filesSummarized: 0,
      sensitiveMasked: 1,
      sourceModified: 0,
      approx: true,
    },
    files: [
      {
        relpath: "synthetic.csv",
        action: "prepare-locally",
        status: "ok",
        transmission: "approved",
        beforeChars: 100,
        afterChars: 100,
        transformed: true,
        transformations: ["pseudonymized"],
      },
      ...(partial ? [error] : []),
    ],
    blocked: [],
    errors: partial ? [error] : [],
    decisions: [],
    sourceModified: 0,
    tabularAcceptance: {
      entitiesPseudonymized: 100,
      identifierColumnsTransformed: 3,
      analyticalColumnsPreserved: 26,
      postTransformScanPassed: !partial,
      malformedTables: partial ? 1 : 0,
      unverifiedTransformations: partial ? 1 : 0,
      rawFallbackUsed: false,
      launchAllowed: !partial,
      claudeCodeStarted: false,
      unsupportedOrUnverifiedFiles: 0,
      restrictedUnresolvedFiles: 0,
      hasLimitations: false,
    },
  };
}

describe("CLI preparation acceptance output", () => {
  it("renders metadata-safe success and JSON schema", () => {
    const result = buildCliPrepareResult(report());
    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "Success",
      entitiesPseudonymized: 100,
      launchAllowed: true,
      rawFallbackUsed: false,
    });
    expect(cliPrepareExitCode(result)).toBe(0);
    const text = formatCliPrepareResult(result);
    expect(text).toContain("Entities pseudonymized: 100");
    expect(text).not.toContain("/not-for-output");
    expect(JSON.stringify(result)).not.toContain("synthetic.csv");
  });

  it("renders Partial with exit 2 and no raw details", () => {
    const result = buildCliPrepareResult(report(true));
    expect(result.status).toBe("Partial");
    expect(result.launchAllowed).toBe(false);
    expect(result.safeErrorCategory).toEqual(["malformed-table", "unverified-transformation"]);
    expect(cliPrepareExitCode(result)).toBe(2);
    const text = formatCliPrepareResult(result);
    expect(text).toContain("Preparation incomplete");
    expect(text).toContain("Raw fallback used: No");
    expect(text).toContain("Files kept local: 1");
    expect(text).toContain("Launch allowed: No");
    expect(text).not.toContain("synthetic-malformed.csv");
    expect(text).not.toContain("/not-for-output");
  });

  it("uses the shared limitation counts for a successful unsupported file", () => {
    const fixture = report();
    fixture.tabularAcceptance = {
      ...fixture.tabularAcceptance!,
      unsupportedOrUnverifiedFiles: 1,
      restrictedUnresolvedFiles: 0,
      hasLimitations: true,
    };
    const result = buildCliPrepareResult(fixture);
    expect(result.status).toBe("Success");
    expect(formatCliPrepareResult(result)).toContain(
      "Some files could not be safely inspected or transformed.",
    );
    expect(formatCliPrepareResult(result)).toContain("Unsupported or unverified files: 1");
  });
});
