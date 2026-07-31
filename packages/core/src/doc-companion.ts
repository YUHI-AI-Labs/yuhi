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
  /** Count of secret + structured-identifier spans replaced across all text. */
  redactionCount: number;
  /**
   * Always true: free-text personal names cannot be reliably removed by regex,
   * so a residual re-identification risk always remains.
   */
  residualNameRisk: boolean;
  warnings: string[];
}

const DEFAULT_ENTROPY_THRESHOLD = 4.5;

// Structured-identifier patterns. Applied emails -> code IDs -> phones so an
// alpha-prefixed ID is not partially consumed by the digit-run phone pattern.
const EMAIL_RE = /[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
// Phone-ish runs of digits with common separators; validated by digit count.
const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/g;
// Code-like IDs: a short alpha prefix followed by 3+ digits (e.g. STU2024001).
const CODE_ID_RE = /[A-Za-z]{1,6}\d{3,}[A-Za-z0-9]*/g;
// Absolute path shapes we must never emit (POSIX or Windows).
const ABS_PATH_RE = /(?:[A-Za-z]:\\[^\s]*|\/[^\s]*\/[^\s]*)/g;
// Filename shape (has an extension); used to reject path/file-like titles.
const FILENAME_RE = /[^\s/\\]+\.[A-Za-z0-9]{1,5}$/;

interface SanitizeState {
  count: number;
  // Stable token maps so a repeated identifier gets the same token.
  email: Map<string, string>;
  phone: Map<string, string>;
  id: Map<string, string>;
}

function newState(): SanitizeState {
  return { count: 0, email: new Map(), phone: new Map(), id: new Map() };
}

function token(map: Map<string, string>, key: string, prefix: string): string {
  const existing = map.get(key);
  if (existing) return existing;
  const t = `«${prefix}:${map.size + 1}»`;
  map.set(key, t);
  return t;
}

/**
 * Sanitize a single text block: redact secrets (via @yuhi/scanner) then
 * structured identifiers (emails, phones, code IDs). Increments state.count by
 * every replacement made. Returns the redacted string.
 */
function sanitizeBlock(raw: string, state: SanitizeState): string {
  if (!raw) return "";

  // 1) Secrets / high-entropy tokens via the shared redactor.
  const secret = redactText(raw, {
    entropyThreshold: DEFAULT_ENTROPY_THRESHOLD,
    keywords: [],
  });
  state.count += secret.count;
  let out = secret.redacted;

  // 2) Emails.
  out = out.replace(EMAIL_RE, (m) => {
    const t = token(state.email, m, "EMAIL");
    state.count += 1;
    return t;
  });

  // 3) Code-like IDs (before phones so an alpha-prefixed ID like STU2024001 is
  //    not partially consumed by the digit-run phone pattern).
  out = out.replace(CODE_ID_RE, (m) => {
    const t = token(state.id, m, "ID");
    state.count += 1;
    return t;
  });

  // 4) Phone numbers (require 7..15 digits to avoid eating plain numbers).
  out = out.replace(PHONE_RE, (m) => {
    const digits = (m.match(/\d/g) ?? []).length;
    if (digits < 7 || digits > 15) return m;
    const t = token(state.phone, m.trim(), "PHONE");
    state.count += 1;
    return t;
  });

  return out;
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
    "This companion is a redacted copy. Secrets and structured identifiers " +
      "(emails, phone numbers, code-like IDs) were replaced with stable tokens.",
  );
  lines.push(
    "Residual risk: arbitrary personal names in free text may remain. " +
      "This document is NOT fully anonymized — free-text names cannot be reliably removed.",
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
    "Residual risk: arbitrary personal names in free text may remain (not fully anonymized).",
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
