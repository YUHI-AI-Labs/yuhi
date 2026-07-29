import * as path from "node:path";
import type { ProcessorSpec } from "./processors.js";

export type SupportedFileType = "text" | "csv" | "tsv" | "pdf" | "xlsx" | "binary";

export interface FileCapabilities {
  fileType: SupportedFileType;
  parserAvailable: boolean;
  scannerAvailable: boolean;
  transformers: readonly ProcessorSpec[];
  verifierAvailable: boolean;
}

const TEXT_TRANSFORMERS: readonly ProcessorSpec[] = [
  "pseudonymize",
  "summarize-local",
  "safety-check",
];
const TABLE_TRANSFORMERS: readonly ProcessorSpec[] = [
  "pseudonymize",
  "pseudonymize-student-records",
  "aggregate-student-records",
  "summarize-local",
  "safety-check",
];

/** The single authoritative registry used by scanning, policy, and preparation. */
export function fileCapabilities(relpath: string, binary = false): FileCapabilities {
  const extension = path.extname(relpath).toLowerCase();
  if (extension === ".pdf") {
    return {
      fileType: "pdf",
      parserAvailable: false,
      scannerAvailable: false,
      transformers: [],
      verifierAvailable: false,
    };
  }
  if (extension === ".xlsx") {
    return {
      fileType: "xlsx",
      parserAvailable: false,
      scannerAvailable: false,
      transformers: [],
      verifierAvailable: false,
    };
  }
  if (extension === ".csv" || extension === ".tsv") {
    return {
      fileType: extension === ".csv" ? "csv" : "tsv",
      parserAvailable: true,
      scannerAvailable: true,
      transformers: TABLE_TRANSFORMERS,
      verifierAvailable: true,
    };
  }
  if (binary) {
    return {
      fileType: "binary",
      parserAvailable: false,
      scannerAvailable: false,
      transformers: [],
      verifierAvailable: false,
    };
  }
  return {
    fileType: "text",
    parserAvailable: true,
    scannerAvailable: true,
    transformers: TEXT_TRANSFORMERS,
    verifierAvailable: true,
  };
}

export function processorSupported(
  capabilities: FileCapabilities,
  processor: ProcessorSpec,
): boolean {
  return capabilities.transformers.some((candidate) => candidate === processor);
}
