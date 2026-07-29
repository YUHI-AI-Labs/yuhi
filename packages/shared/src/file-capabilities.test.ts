import { describe, expect, it } from "vitest";
import { fileCapabilities, processorSupported } from "./file-capabilities.js";

describe("file capability registry", () => {
  it("keeps PDF and XLSX unsupported until verified processors exist", () => {
    for (const name of ["synthetic.pdf", "synthetic.xlsx"]) {
      expect(fileCapabilities(name, true)).toMatchObject({
        parserAvailable: false,
        scannerAvailable: false,
        transformers: [],
        verifierAvailable: false,
      });
    }
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
