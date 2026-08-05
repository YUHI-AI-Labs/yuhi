/**
 * Direct-personal-identifier transformation for the LIVE delivery pipeline (v0.4.8
 * Phase 3A). Reuses the SAME taxonomy, run registry and verification 0.4.6/0.4.7 built
 * for Static Prepare (`@yuhi/shared`) — this module adds only the routing a live
 * gateway needs and does not, does not reimplement, does not add a second registry.
 *
 * Content routing exists because a Dynamic Context tool result is NOT a student-record
 * spreadsheet: it is arbitrary tool output from an arbitrary repository. Scanning
 * source code or command output for CJK name-shaped substrings the way a document's
 * free prose is scanned would over-mask ordinary identifiers, comments and log lines —
 * the precision the identity-linkage policy requires. See `DeidentifyTextOptions` in
 * `text-deidentify.ts` for the same reasoning at the primitive layer.
 */
import type { ContentKind } from "@yuhi/context-store";
import {
  createStudentAliasContext,
  deidentifyJsonFields,
  deidentifyText,
  modeTransformsDirectIdentifiers,
  pseudonymizeStudentRecords,
  type PrivacyMode,
  type StudentAliasContext,
} from "@yuhi/shared";

export type DeliveryContentType =
  | "structured-table"
  | "structured-json"
  | "prose"
  | "source-code"
  | "command-output"
  | "configuration";

const ASSIGNMENT_LINE = /^\s*[A-Za-z_][A-Za-z0-9_.]*\s*[:=]\s*\S/;

/** `KEY=value` / `key: value` dense text — a `.env`, a YAML/TOML/ini-shaped file. */
function looksLikeConfiguration(content: string): boolean {
  const lines = content.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
  if (lines.length < 2) return false;
  const assignmentLines = lines.filter((l) => ASSIGNMENT_LINE.test(l));
  return assignmentLines.length / lines.length > 0.6;
}

/** A consistent-width comma/tab-delimited block — a CSV/TSV `cat`/`Read` result. */
function looksLikeDelimitedTable(content: string): boolean {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;
  const first = lines[0]!;
  const commas = first.split(",").length;
  const tabs = first.split("\t").length;
  if (commas < 3 && tabs < 3) return false;
  const delimiter = tabs > commas ? "\t" : ",";
  const width = first.split(delimiter).length;
  return lines.slice(0, Math.min(5, lines.length)).every((l) => l.split(delimiter).length === width);
}

/**
 * Classify a tool result for de-identification routing. `kind` (the store's own
 * content classification) decides almost everything; `content` only disambiguates the
 * two kinds (`"text"`, `"source"`) that carry no shape signal of their own.
 */
export function classifyDeliveryContent(kind: ContentKind, content: string): DeliveryContentType {
  switch (kind) {
    case "csv":
    case "tsv":
      return "structured-table";
    case "json":
      return "structured-json";
    case "markdown":
    case "pdf-companion":
      return "prose";
    case "log":
    case "test-output":
    case "shell-output":
    case "git-diff":
      return "command-output";
    case "html":
    case "xml":
      return "source-code";
    case "source":
      return looksLikeConfiguration(content) ? "configuration" : "source-code";
    case "text":
      if (looksLikeConfiguration(content)) return "configuration";
      if (looksLikeDelimitedTable(content)) return "structured-table";
      return "prose";
    default:
      // Fail toward MORE protection, never less: an unrecognized kind is treated as
      // free prose rather than skipped.
      return "prose";
  }
}

export interface PrivacyTransformOutcome {
  readonly text: string;
  /** The content type actually used — may differ from the input classification when
   *  the content did not match its detected shape (e.g. a mis-detected table falls
   *  through to prose, which is a strictly safer default than delivering it untransformed). */
  readonly contentType: DeliveryContentType;
  readonly detected: number;
  readonly transformed: number;
}

const TABULAR_SENTINELS = new Set(["NO_DIRECT_PERSONAL_IDENTIFIERS", "TRUSTED_LOCAL_NO_TRANSFORM"]);

/**
 * Route a live tool result through the SAME de-identification taxonomy Static Prepare
 * uses, chosen by content shape (spec §5): tabular taxonomy for delimited tables, JSON
 * field-value transformation for JSON, full prose de-identification (including the CJK
 * name heuristic) only for prose/documents, and precision-only shape-pattern masking
 * (no name heuristic) for source code, command output and configuration.
 *
 * Synchronous and pure aside from mutating `context` (the run-scoped registry) — same
 * contract as `deidentifyText`/`pseudonymizeStudentRecords`, so a caller may run this
 * inline inside an otherwise-async pipeline without awaiting anything.
 */
export function transformDirectPersonalIdentifiers(
  content: string,
  contentType: DeliveryContentType,
  context: StudentAliasContext,
  mode: PrivacyMode,
): PrivacyTransformOutcome {
  if (!modeTransformsDirectIdentifiers(mode)) {
    return { text: content, contentType, detected: 0, transformed: 0 };
  }

  if (contentType === "structured-table") {
    try {
      const result = pseudonymizeStudentRecords(content, context, mode);
      return {
        text: result.output,
        contentType,
        detected: result.valuesReplaced,
        transformed: result.valuesReplaced,
      };
    } catch (err) {
      if (err instanceof Error && TABULAR_SENTINELS.has(err.message)) {
        return { text: content, contentType, detected: 0, transformed: 0 };
      }
      // Not actually a well-formed table (misdetected) — prose is a strictly safer
      // fallback than delivering the content untransformed.
      const fallback = deidentifyText(content, context, mode);
      return {
        text: fallback.text,
        contentType: "prose",
        detected: fallback.replacedTotal,
        transformed: fallback.replacedTotal,
      };
    }
  }

  if (contentType === "structured-json") {
    const result = deidentifyJsonFields(content, context, mode);
    if (result) {
      return {
        text: result.text,
        contentType,
        detected: result.replacedFields,
        transformed: result.replacedFields,
      };
    }
    // Not actually valid JSON — fall through to prose.
    const fallback = deidentifyText(content, context, mode);
    return {
      text: fallback.text,
      contentType: "prose",
      detected: fallback.replacedTotal,
      transformed: fallback.replacedTotal,
    };
  }

  const includeNameHeuristic = contentType === "prose";
  const result = deidentifyText(content, context, mode, { includeNameHeuristic });
  return {
    text: result.text,
    contentType,
    detected: result.replacedTotal,
    transformed: result.replacedTotal,
  };
}

export function createRuntimeAliasContext(): StudentAliasContext {
  return createStudentAliasContext();
}
