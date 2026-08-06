/**
 * Deterministic intent/role classification (planner_contract.md §2). No model call,
 * ever — every signal here is a structural pattern already available at the
 * gateway's request-handling layer. Ambiguous input classifies to `"unknown"`,
 * never guessed toward a specific value: `role: "unknown"` never routes to
 * `withhold`, only a real privacy/security failure does (Rule 1).
 */

import type { ContentKind } from "@yuhi/context-store";
import type { ToolName } from "../event.js";
import type { ContextIntent, ContextRole } from "./types.js";

export interface ClassifyIntentInput {
  readonly tool: ToolName;
  readonly toolInput?: string;
  readonly kind: ContentKind;
  readonly recentUserMessage?: string;
  readonly hasFailureMarkers?: boolean;
}

const DEBUG_PATTERN = /\b(fix|why does|why is|debug|broken|error|bug|crash|failing)\b/i;
const REFACTOR_PATTERN = /\b(refactor|rename|extract|reorgani[sz]e|clean up|restructure)\b/i;
const DATA_EXTENSIONS = /\.(csv|tsv|json|jsonl|ndjson|parquet)$/i;

/**
 * A coarse routing signal only — NOT the real failure detector. The actual
 * test-output compressor (`@yuhi/context-compression`'s `test-output.ts`) has its
 * own, load-bearing failure/anchor detection that this must never duplicate or
 * substitute for; this only decides which Planner rule a block routes through.
 */
const FAILURE_MARKER_PATTERN = /\bfail(?:ed|ure)?\b|\berror\b|✗|\bassertionerror\b|\btraceback\b/i;

export function hasTestFailureMarkers(kind: ContentKind, content: string): boolean | undefined {
  if (kind !== "test-output" && kind !== "shell-output") return undefined;
  return FAILURE_MARKER_PATTERN.test(content);
}

export function classifyIntent(input: ClassifyIntentInput): ContextIntent {
  if (input.kind === "test-output" || (input.tool === "test" && input.hasFailureMarkers)) {
    return "test-failure";
  }
  if (input.kind === "pdf-companion") return "document-analysis";
  if (input.tool === "grep" || input.tool === "glob") return "search";
  if (input.toolInput && DATA_EXTENSIONS.test(input.toolInput)) return "data-analysis";
  if (
    input.kind === "csv" ||
    input.kind === "tsv" ||
    (input.kind === "json" && input.tool !== "mcp")
  ) {
    return "data-analysis";
  }
  const message = input.recentUserMessage ?? "";
  if (REFACTOR_PATTERN.test(message)) return "refactor";
  if (DEBUG_PATTERN.test(message)) return "debug";
  if (input.tool === "bash" || input.tool === "read") return "implement";
  return "unknown";
}

export interface ClassifyRoleInput {
  readonly tool: ToolName;
  readonly toolInput?: string;
  readonly kind: ContentKind;
  readonly hasFailureMarkers?: boolean;
  readonly activeEditTargets: readonly string[];
  readonly isRepeatedContent: boolean;
  readonly confidenceHint: "high" | "low";
}

const GENERATED_NOISE_PATH = /(?:^|\/)(?:node_modules|dist|build|coverage|\.venv|out)\//i;
const LOCKFILE_PATH = /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/i;
const MINIFIED_PATH = /\.min\.(js|css)$/i;
const REFERENCE_PATH = /(?:^|\/)(?:README|CHANGELOG|docs?\/)/i;

export function classifyRole(input: ClassifyRoleInput): ContextRole {
  if (input.isRepeatedContent) return "repeated";

  if (input.toolInput) {
    if (
      GENERATED_NOISE_PATH.test(input.toolInput) ||
      LOCKFILE_PATH.test(input.toolInput) ||
      MINIFIED_PATH.test(input.toolInput)
    ) {
      return "generated-noise";
    }
    if (input.activeEditTargets.includes(input.toolInput)) return "load-bearing";
  }

  if (input.kind === "test-output" && input.hasFailureMarkers) return "load-bearing";
  if (input.kind === "test-output" && input.hasFailureMarkers === false) return "generated-noise";

  if (input.toolInput && REFERENCE_PATH.test(input.toolInput)) return "reference";

  // Conservative: low-confidence signals never resolve toward generated-noise or
  // load-bearing — those are consequential in opposite directions (drop vs. keep
  // unconditionally), so an uncertain read must fall through to `unknown`.
  if (input.confidenceHint === "low") return "unknown";

  if (input.tool === "bash" && input.kind === "shell-output") return "supporting";

  return "unknown";
}
