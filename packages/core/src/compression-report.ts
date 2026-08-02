/**
 * v0.3.3 Context Compression report formatter — the user-facing "Ready for AI"
 * summary of the optional structure-compression pass.
 *
 * PUBLIC-SAFE by construction: it renders only the aggregate numbers on a
 * {@link CompressionReport} plus the per-file `relpath`s that are already present in
 * the input (and were already shown during review). No source content, secret type,
 * or identity is ever surfaced here.
 *
 * This module deliberately imports NOTHING from the compression engine (`./compression/*`)
 * or the `typescript` parser — it works purely on the already-computed summary, so it
 * stays cheap to load for any CLI / VS Code surface. It uses only the type of
 * {@link CompressionReport}, which is erased at build time.
 */
import type { CompressionReport } from "./prepare-workspace.js";

/**
 * Stable internal `reason` vocabulary → readable display label. The per-file
 * `CompressionFileReport.reason` values come from a small fixed set; this maps each to
 * a human label. A reason NOT in this map is shown verbatim (never crashes) so a new
 * internal reason degrades gracefully instead of throwing.
 */
export const COMPRESSION_REASON_LABELS: Record<string, string> = {
  "user-included": "Included by you",
  "open-or-specified": "Open or specified file",
  "entry-point": "Entry point",
  "package-manifest": "Package manifest",
  "agent-instruction": "Agent instruction file",
  "config": "Configuration file",
  "parse-failed": "Kept full (could not parse)",
  "compressor-unavailable": "Kept full (compressor unavailable)",
  "too-small": "Kept full (too small to compress)",
  "not-compressible": "Kept full (not compressible)",
  "compression-not-smaller": "Kept full (compression not smaller)",
  "structural-compression": "Implementation bodies omitted",
  "token-budget": "Excluded to fit token budget",
  "excluded-upstream": "Excluded earlier in preparation",
  "safety-policy": "Excluded by safety policy",
};

/** Readable label for a per-file compression `reason`; unknown reasons pass through verbatim. */
export function compressionReasonLabel(reason: string): string {
  return COMPRESSION_REASON_LABELS[reason] ?? reason;
}

/** Thousands separator without locale surprises (Date/Intl-free environment safe). */
function group(n: number): string {
  const sign = n < 0 ? "-" : "";
  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Signed thousands-grouped difference: "+18,420" / "-2,000" / "0". */
function signed(n: number): string {
  if (n > 0) return `+${group(n)}`;
  if (n < 0) return `-${group(-n)}`;
  return "0";
}

/** Percentage with the value's own precision (already a percentage, e.g. 85.6). */
function percent(n: number): string {
  return `${n}%`;
}

const STATUS_LABELS: Record<CompressionReport["status"], string> = {
  "within-budget": "Within budget",
  "best-effort": "Best effort",
  "no-budget": "No budget",
};

interface Row {
  label: string;
  value: string;
  /** true → right-aligned in the numeric value column; false → free text after the label. */
  numeric: boolean;
}

function terminal(c: CompressionReport): string {
  const sections: Row[][] = [];

  sections.push([
    { label: "Original tokens", value: group(c.originalTokens), numeric: true },
    { label: "Prepared tokens", value: group(c.preparedTokens), numeric: true },
    { label: "Context reduction", value: percent(c.reductionPercent), numeric: true },
  ]);

  sections.push([
    { label: "Files compressed", value: group(c.compressedFiles), numeric: true },
    { label: "Files excluded", value: group(c.excludedFiles), numeric: true },
    { label: "Files kept full", value: group(c.fullFiles), numeric: true },
  ]);

  sections.push([
    { label: "Reduction from compression", value: group(c.compressionReductionTokens), numeric: true },
    { label: "Reduction from exclusion", value: group(c.exclusionReductionTokens), numeric: true },
  ]);

  // Budget block: shown when the run was best-effort OR any token budget was set.
  const showBudget = c.status === "best-effort" || c.targetBudget !== null;
  if (showBudget) {
    const budget: Row[] = [
      {
        label: "Target budget",
        value: c.targetBudget !== null ? group(c.targetBudget) : "None",
        numeric: true,
      },
      { label: "Actual tokens", value: group(c.actualTokens), numeric: true },
    ];
    if (c.targetBudget !== null) {
      budget.push({
        label: "Difference",
        value: signed(c.actualTokens - c.targetBudget),
        numeric: true,
      });
    }
    budget.push({ label: "Status", value: STATUS_LABELS[c.status], numeric: false });
    if (c.budgetReason) {
      budget.push({ label: "Reason", value: c.budgetReason, numeric: false });
    }
    sections.push(budget);
  }

  const allRows = sections.flat();
  const labelW = Math.max(...allRows.map((r) => r.label.length));
  const valW = Math.max(...allRows.filter((r) => r.numeric).map((r) => r.value.length));

  const lines: string[] = ["Context Compression"];
  for (const section of sections) {
    lines.push("");
    for (const r of section) {
      lines.push(
        r.numeric
          ? `  ${r.label.padEnd(labelW)}  ${r.value.padStart(valW)}`
          : `  ${r.label.padEnd(labelW)}  ${r.value}`,
      );
    }
  }

  if (c.warnings.length > 0) {
    lines.push("");
    for (const w of c.warnings) lines.push(`  ! ${w}`);
  }

  return lines.join("\n");
}

/**
 * Render the compression summary. `terminal` is the user-facing "Ready for AI" block;
 * `json` is the raw {@link CompressionReport} pretty-printed (round-trips exactly).
 * Both are public-safe: only aggregate numbers and the input's own relpaths appear.
 */
export function formatCompressionReport(
  c: CompressionReport,
  format: "terminal" | "json",
): string {
  return format === "json" ? JSON.stringify(c, null, 2) : terminal(c);
}
