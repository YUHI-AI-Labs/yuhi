import { readZipEntriesSafely } from "./safe-unzip.js";

/**
 * PPTX slide-text extraction WITHOUT executing anything.
 *
 * A .pptx file is an OOXML ZIP container. This module reads the container with
 * `readZipEntriesSafely` (which enforces its own zip-bomb / size limits) and then
 * does a purely lexical scan of the slide XML. It never resolves relationships to
 * external targets, never fetches URLs, never touches embedded objects or macros —
 * it only *counts* and *flags* them so a security gate can react.
 *
 * Design constraints (see module task):
 *  - Never throws on bad input: corrupt/unsupported bytes become a status, not an
 *    exception.
 *  - No new dependencies; parsing is done with tolerant regexes over the standard
 *    OOXML `a:`/`p:` namespace prefixes rather than a full XML DOM.
 */

export interface Slide {
  index: number;
  title?: string;
  body: string[];
  tables: string[][][];
  notes: string[];
}

export interface PptxExtraction {
  ok: boolean;
  slides: Slide[];
  hiddenSlideCount: number;
  macroDetected: boolean;
  embeddedObjectCount: number;
  imageCount: number;
  warnings: string[];
  status: "extracted" | "unsupported" | "failed";
}

/** Normalized zip entry, shielded from the exact shape of the safe-unzip result. */
interface NormalizedEntry {
  path: string;
  text: string;
}

const MACRO_ENTRY = "ppt/vbaproject.bin";

function decodeToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (Buffer.isBuffer(value)) return (value as Buffer).toString("utf8");
  if (value && typeof value === "object" && "type" in (value as object) &&
      Array.isArray((value as { data?: unknown }).data)) {
    // e.g. a serialized { type: 'Buffer', data: number[] }
    return Buffer.from((value as { data: number[] }).data).toString("utf8");
  }
  return "";
}

function readField(entry: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in entry && entry[key] != null) return entry[key];
  }
  return undefined;
}

/**
 * Coerce whatever `readZipEntriesSafely` returned into a flat list of entries.
 * Tolerates: an array of entries, or `{ entries: [...] }`; entry path under
 * `path` | `name` | `filename`; entry bytes under `data` | `content` | `bytes` |
 * `buffer` | `text`. Returns undefined when the shape is not recognizable at all
 * (treated as a failure by the caller).
 */
function normalizeEntries(raw: unknown): {
  entries: NormalizedEntry[];
  ok: boolean;
  warnings: string[];
} | undefined {
  if (raw == null || typeof raw !== "object") return undefined;

  const container = raw as Record<string, unknown>;
  let list: unknown = container;
  let ok = true;
  const warnings: string[] = [];

  if (!Array.isArray(raw)) {
    if ("ok" in container && typeof container.ok === "boolean") ok = container.ok;
    // safe-unzip signals unreadable/corrupt input via `aborted:true` (it never throws).
    if (container.aborted === true) {
      ok = false;
      if (typeof container.abortReason === "string") warnings.push(container.abortReason);
    }
    if (Array.isArray(container.warnings)) {
      for (const w of container.warnings) {
        if (typeof w === "string") warnings.push(w);
      }
    }
    list = readField(container, ["entries", "files"]);
  }

  if (!Array.isArray(list)) return undefined;

  const entries: NormalizedEntry[] = [];
  for (const item of list) {
    if (item == null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const rawPath = readField(rec, ["path", "name", "filename", "fileName"]);
    if (typeof rawPath !== "string") continue;
    const rawData = readField(rec, ["data", "content", "bytes", "buffer", "text"]);
    entries.push({ path: rawPath.replace(/\\/g, "/"), text: decodeToText(rawData) });
  }

  return { entries, ok, warnings };
}

const XML_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
};

function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(?:lt|gt|amp|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

/** Concatenate every `<a:t>` run inside a fragment, XML-unescaped. */
function runText(fragment: string): string {
  const runs = fragment.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g);
  if (!runs) return "";
  let out = "";
  for (const run of runs) {
    const inner = run.replace(/^<a:t\b[^>]*>/, "").replace(/<\/a:t>$/, "");
    out += unescapeXml(inner);
  }
  return out;
}

/** Split a fragment into per-paragraph (`<a:p>`) text, dropping empty paragraphs. */
function paragraphTexts(fragment: string): string[] {
  const paras = fragment.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g);
  const source = paras ?? [fragment];
  const out: string[] = [];
  for (const para of source) {
    const text = runText(para).trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

function extractTables(slideXml: string): { tables: string[][][]; without: string } {
  const tables: string[][][] = [];
  const tableBlocks = slideXml.match(/<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>/g) ?? [];
  for (const tbl of tableBlocks) {
    const rows: string[][] = [];
    const rowBlocks = tbl.match(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g) ?? [];
    for (const tr of rowBlocks) {
      const cells: string[] = [];
      const cellBlocks = tr.match(/<a:tc\b[^>]*>[\s\S]*?<\/a:tc>/g) ?? [];
      for (const tc of cellBlocks) {
        cells.push(runText(tc).trim());
      }
      rows.push(cells);
    }
    tables.push(rows);
  }
  const without = tableBlocks.reduce((acc, block) => acc.replace(block, ""), slideXml);
  return { tables, without };
}

function isTitleShape(shape: string): boolean {
  return /<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(shape);
}

function parseSlideXml(slideXml: string): {
  title?: string;
  body: string[];
  tables: string[][][];
  hidden: boolean;
} {
  const hidden = /<p:sld\b[^>]*\bshow="(?:0|false)"/.test(slideXml);
  const { tables, without } = extractTables(slideXml);

  let title: string | undefined;
  const body: string[] = [];
  const shapes = without.match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g) ?? [];

  for (const shape of shapes) {
    const paragraphs = paragraphTexts(shape);
    if (paragraphs.length === 0) continue;
    if (title === undefined && isTitleShape(shape)) {
      title = paragraphs.join(" ");
    } else {
      body.push(...paragraphs);
    }
  }

  const result: {
    title?: string;
    body: string[];
    tables: string[][][];
    hidden: boolean;
  } = { body, tables, hidden };
  if (title !== undefined && title.length > 0) result.title = title;
  return result;
}

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/i;
const NOTES_RE = /^ppt\/notesslides\/notesslide(\d+)\.xml$/i;

/**
 * Extract slide text, tables and speaker notes from a PPTX buffer.
 *
 * Speaker notes are associated to slides by matching notesSlideN.xml to slideN.xml
 * (the common authoring convention). Relationship (.rels) targets are intentionally
 * NOT resolved, so an unusually-numbered notes part may be missed — see limitations.
 */
export async function extractPptx(buf: Buffer): Promise<PptxExtraction> {
  const warnings: string[] = [];

  let raw: unknown;
  try {
    // safe-unzip requires a `wanted` predicate — decompress only the ppt/ XML parts,
    // notes, and the macro marker (never media/embeddings by content).
    const wanted = (p: string): boolean => {
      const lower = p.toLowerCase();
      return (
        lower.startsWith("ppt/slides/") ||
        lower.startsWith("ppt/notesslides/") ||
        lower === "ppt/presentation.xml" ||
        lower === "ppt/vbaproject.bin" ||
        lower.startsWith("ppt/media/") ||
        lower.startsWith("ppt/embeddings/") ||
        lower.startsWith("docprops/")
      );
    };
    raw = (
      readZipEntriesSafely as unknown as (
        b: Buffer,
        w: (p: string) => boolean,
      ) => unknown
    )(buf, wanted);
  } catch {
    return failed(["Failed to read PPTX container (unreadable or corrupt zip)."]);
  }

  const normalized = normalizeEntries(raw);
  if (!normalized || !normalized.ok) {
    return failed([
      ...(normalized?.warnings ?? []),
      "Failed to read PPTX container (unreadable or corrupt zip).",
    ]);
  }
  warnings.push(...normalized.warnings);

  const entries = normalized.entries;
  const byLowerPath = new Map<string, NormalizedEntry>();
  for (const entry of entries) byLowerPath.set(entry.path.toLowerCase(), entry);

  const looksLikePptx =
    byLowerPath.has("[content_types].xml") ||
    entries.some((e) => e.path.toLowerCase().startsWith("ppt/"));
  if (!looksLikePptx) {
    return {
      ok: false,
      slides: [],
      hiddenSlideCount: 0,
      macroDetected: false,
      embeddedObjectCount: 0,
      imageCount: 0,
      warnings: [...warnings, "Not a recognizable PPTX package."],
      status: "unsupported",
    };
  }

  const macroDetected = byLowerPath.has(MACRO_ENTRY);
  if (macroDetected) {
    warnings.push("Macro project (vbaProject.bin) detected; not executed.");
  }

  let embeddedObjectCount = 0;
  let imageCount = 0;
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    if (lower.startsWith("ppt/embeddings/")) embeddedObjectCount += 1;
    else if (lower.startsWith("ppt/media/")) imageCount += 1;
  }
  if (embeddedObjectCount > 0) {
    warnings.push(
      `${embeddedObjectCount} embedded object(s) detected; not opened.`,
    );
  }

  // Speaker notes indexed by slide number.
  const notesByNumber = new Map<number, string[]>();
  for (const entry of entries) {
    const m = NOTES_RE.exec(entry.path);
    if (!m) continue;
    const num = Number(m[1]);
    notesByNumber.set(num, paragraphTexts(entry.text));
  }

  const slideEntries: Array<{ num: number; entry: NormalizedEntry }> = [];
  for (const entry of entries) {
    const m = SLIDE_RE.exec(entry.path);
    if (m) slideEntries.push({ num: Number(m[1]), entry });
  }
  slideEntries.sort((a, b) => a.num - b.num);

  const slides: Slide[] = [];
  let hiddenSlideCount = 0;
  slideEntries.forEach(({ num, entry }, position) => {
    const parsed = parseSlideXml(entry.text);
    if (parsed.hidden) hiddenSlideCount += 1;
    const slide: Slide = {
      index: position,
      body: parsed.body,
      tables: parsed.tables,
      notes: notesByNumber.get(num) ?? [],
    };
    if (parsed.title !== undefined) slide.title = parsed.title;
    slides.push(slide);
  });

  return {
    ok: true,
    slides,
    hiddenSlideCount,
    macroDetected,
    embeddedObjectCount,
    imageCount,
    warnings,
    status: "extracted",
  };
}

function failed(warnings: string[]): PptxExtraction {
  return {
    ok: false,
    slides: [],
    hiddenSlideCount: 0,
    macroDetected: false,
    embeddedObjectCount: 0,
    imageCount: 0,
    warnings,
    status: "failed",
  };
}
