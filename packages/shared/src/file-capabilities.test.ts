import { describe, expect, it } from "vitest";
import { fileCapabilities, processorSupported } from "./file-capabilities.js";

describe("file capability registry", () => {
  it("supports verified XLSX transformation while keeping PDF local-only", () => {
    expect(fileCapabilities("synthetic.xlsx", true)).toMatchObject({
      parserAvailable: true,
      scannerAvailable: true,
      transformers: ["pseudonymize-student-records", "safety-check"],
      verifierAvailable: true,
    });
    expect(fileCapabilities("synthetic.pdf", true)).toMatchObject({
      parserAvailable: false,
      scannerAvailable: false,
      transformers: [],
      verifierAvailable: false,
    });
  });

  it("advertises only executable processors for delimited tables", () => {
    const csv = fileCapabilities("synthetic.csv");
    expect(csv).toMatchObject({
      fileType: "csv",
      parserAvailable: true,
      scannerAvailable: true,
      verifierAvailable: true,
    });
    expect(processorSupported(csv, "pseudonymize-student-records")).toBe(true);
    expect(processorSupported(csv, "aggregate-student-records")).toBe(true);
    expect(processorSupported(fileCapabilities("synthetic.xlsx"), "aggregate-student-records"))
      .toBe(false);
  });

  it("uses the same extension classification regardless of binary detection", () => {
    expect(fileCapabilities("synthetic.pdf", false).fileType).toBe("pdf");
    expect(fileCapabilities("synthetic.xlsx", false).fileType).toBe("xlsx");
    expect(fileCapabilities("logo.dat", true).fileType).toBe("binary");
  });
});
