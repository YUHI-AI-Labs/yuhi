import { redactText } from "@yuhi/scanner";

/**
 * Structured input describing already-extracted document text. The extraction
 * itself (PDF/DOCX/PPTX parsing) happens upstream — this module is a pure,
 * local transform that takes plain text/sections and produces a SANITIZED
 * Markdown companion string. It never reads files, never runs macros/embedded
 * objects, and never fetches URLs.
 */
export interface CompanionInput {
  sourceType: "pdf" | "docx" | "pptx";
  /** Human title. Never a filesystem path — path/filename-looking titles are dropped. */
  title?: string;
  sections: {
    heading?: string;
    paragraphs: string[];
    /** tables[t] = rows; rows[r] = cells; cell = string. */
    tables?: string[][][];
  }[];
  meta: {
    pages?: number;
    slides?: number;
    extractionMethod: string;
    macroDetected?: boolean;
    embeddedObjectCount?: number;
    imageCount?: number;
    hiddenContent?: boolean;
  };
}

export interface CompanionResult {
  markdown: string;
  /** Count of SECRET spans redacted here (structured/personal identifiers are masked
   *  downstream — see `sanitizeBlock`'s doc comment — and are not counted here). */
  redactionCount: number;
  /**
   * Always true: this function's own pass only redacts secrets. The real,
   * taxonomy-aware personal-identifier masking (`deidentifyText`, downstream in
   * `wiring.ts`) has a known, DOCUMENTED coverage gap (non-CJK names, single- and
   * 5+-character CJK names) it cannot close, so a residual re-identification risk in
   * free text can never be certified zero at this layer. Unused downstream in the
   * live pipeline today (the real gate is `wiring.ts`'s independent verification
   * pass); kept for callers reading an older manifest shape.
   */
  residualNameRisk: boolean;
  warnings: string[];
}

const DEFAULT_ENTROPY_THRESHOLD = 4.5;

// Absolute path shapes we must never emit (POSIX or Windows).
const ABS_PATH_RE = /(?:[A-Za-z]:\\[^\s]*|\/[^\s]*\/[^\s]*)/g;
// Filename shape (has an extension); used to reject path/file-like titles.
const FILENAME_RE = /[^\s/\\]+\.[A-Za-z0-9]{1,5}$/;

interface SanitizeState {
  count: number;
}

function newState(): SanitizeState {
  return { count: 0 };
}

/**
 * Sanitize a single text block: redact secrets (via @yuhi/scanner). Increments
 * state.count by every replacement made. Returns the redacted string.
 *
 * Structured personal identifiers (emails, phones) and operational identifiers
 * (student/employee/course IDs) are deliberately NOT touched here (0.4.7,
 * `docs/design/0.4.7_document_privacy.md`). This function used to mask them itself,
 * with its own `«EMAIL:N»`/`«ID:N»`/`«PHONE:N»` tokens, unconditionally — including
 * operational IDs, which the taxonomy (`identifier-taxonomy.ts`) requires to be
 * PRESERVED, not masked, and which the identity linkage policy
 * (`entitiesReachableInText`) needs present verbatim to detect a same-document
 * linking key at all. Masking them here, before that detection ever ran, both broke
 * linkage and produced a token format inconsistent with what the SAME email/phone
 * value gets in a CSV (`EMAIL-001` there, `«EMAIL:1»` here) — exactly the
 * inconsistency 0.4.6/0.4.7 exist to eliminate ("SAME taxonomy, SAME registry, SAME
 * verification"). `packages/core/src/background/wiring.ts`'s pseudonymizer
 * (`deidentifyText`) is now the SOLE authority for these, downstream, after this
 * function returns.
 */
function sanitizeBlock(raw: string, state: SanitizeState): string {
  if (!raw) return "";

  // Secrets / high-entropy tokens via the shared redactor. This stays here: it is an
  // orthogonal concern (credentials, not personal-identifier taxonomy) already shared
  // with every other secret-scanning surface in the codebase.
  const secret = redactText(raw, {
    entropyThreshold: DEFAULT_ENTROPY_THRESHOLD,
    keywords: [],
  });
  state.count += secret.count;
  return secret.redacted;
}

/** Escape a cell for GitHub markdown table rendering. */
function escapeCell(cell: string): string {
  return cell.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/**
 * Produce a title safe to embed: drop absolute-path / filename-looking titles
 * (we must never leak a source path or filename), then sanitize residual PII.
 */
function safeTitle(title: string | undefined, state: SanitizeState): string {
  if (!title) return "Untitled document";
  const trimmed = title.trim();
  if (!trimmed) return "Untitled document";
  if (trimmed.includes("/") || trimmed.includes("\\") || FILENAME_RE.test(trimmed)) {
    return "Untitled document";
  }
  const cleaned = sanitizeBlock(trimmed, state).replace(ABS_PATH_RE, "«PATH»");
  return cleaned || "Untitled document";
}

function renderTable(table: string[][], state: SanitizeState): string[] {
  const rows = table.filter((r) => r.length > 0);
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const cells = [];
    for (let i = 0; i < width; i++) {
      cells.push(escapeCell(sanitizeBlock(r[i] ?? "", state)));
    }
    return cells;
  });
  const header = norm[0] ?? [];
  const body = norm.slice(1);
  const lines: string[] = [];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const r of body) {
    lines.push(`| ${r.join(" | ")} |`);
  }
  return lines;
}

/**
 * Turn extracted document text into a sanitized Markdown companion. Pure and
 * local: no file reads, no network, no macro/embedded-object execution.
 */
export function buildDocumentCompanion(input: CompanionInput): CompanionResult {
  const state = newState();
  const warnings: string[] = [];
  const { meta } = input;

  const title = safeTitle(input.title, state);

  const lines: string[] = [];

  // ---- Header / meta block ----
  lines.push(`# ${title}`);
  lines.push("");
  lines.push("<!-- Yuhi document companion (sanitized copy — source file not referenced) -->");
  lines.push("");
  lines.push("## Document metadata");
  lines.push("");
  lines.push(`- Source type: ${input.sourceType}`);
  lines.push(`- Extraction method: ${escapeCell(sanitizeBlock(meta.extractionMethod, state))}`);
  if (typeof meta.pages === "number") lines.push(`- Pages: ${meta.pages}`);
  if (typeof meta.slides === "number") lines.push(`- Slides: ${meta.slides}`);
  if (typeof meta.imageCount === "number") lines.push(`- Images: ${meta.imageCount}`);
  if (typeof meta.embeddedObjectCount === "number") {
    lines.push(`- Embedded objects: ${meta.embeddedObjectCount} (not executed or expanded)`);
  }
  lines.push(`- Macro detected: ${meta.macroDetected ? "yes (NOT executed)" : "no"}`);
  lines.push(`- Hidden content flagged: ${meta.hiddenContent ? "yes" : "no"}`);
  lines.push("");

  // ---- Safety / residual-risk block ----
  lines.push("## Sanitization notice");
  lines.push("");
  lines.push(
    "This companion is a sanitized copy. Secrets are redacted here; personal names " +
      "and structured identifiers (emails, phone numbers, and other identifiers that " +
      "directly identify a person) are masked before delivery. Business/operational " +
      "identifiers (student id, course code, …) are preserved for analysis.",
  );
  lines.push(
    "Residual risk: a personal name in free text is masked when the detector " +
      "recognizes it (2-4 character CJK name-shaped sequences). A single-character, " +
      "5+ character, or non-CJK (e.g. Latin-script) personal name may not be " +
      "detected. This document is NOT guaranteed fully anonymized.",
  );
  lines.push("");

  // ---- Body sections ----
  for (const section of input.sections) {
    if (section.heading) {
      lines.push(`## ${escapeCell(sanitizeBlock(section.heading, state))}`);
      lines.push("");
    }
    for (const para of section.paragraphs) {
      const clean = sanitizeBlock(para, state);
      if (clean.trim()) {
        lines.push(clean);
        lines.push("");
      }
    }
    for (const table of section.tables ?? []) {
      const rendered = renderTable(table, state);
      if (rendered.length > 0) {
        lines.push(...rendered);
        lines.push("");
      }
    }
  }

  // ---- Warnings ----
  if (meta.macroDetected) {
    warnings.push("Macro detected in source; it was NOT executed.");
  }
  if ((meta.embeddedObjectCount ?? 0) > 0) {
    warnings.push(
      `${meta.embeddedObjectCount} embedded object(s) present; not executed or expanded.`,
    );
  }
  if (meta.hiddenContent) {
    warnings.push("Source contains hidden content; review before sharing.");
  }
  warnings.push(
    "Residual risk: a personal name outside the CJK 2-4 character detector (e.g. " +
      "single-character, 5+ character, or non-CJK) may not be masked.",
  );

  // Final guard: strip any absolute path that slipped through, then trim.
  const markdown = lines.join("\n").replace(ABS_PATH_RE, "«PATH»").replace(/\n{3,}/g, "\n\n").trim() + "\n";

  return {
    markdown,
    redactionCount: state.count,
    residualNameRisk: true,
    warnings,
  };
}
