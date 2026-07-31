import { readZipEntriesSafely } from "./safe-unzip.js";

/**
 * Structured, execution-free extraction of a DOCX (Office Open XML) document.
 *
 * A .docx / .docm file is a ZIP container of XML parts. This module reads only the
 * XML parts it needs via {@link readZipEntriesSafely} (which enforces the zip-bomb /
 * traversal limits) and parses them with lightweight, namespace-tolerant string
 * matching. It NEVER executes macros, resolves OLE/embedded objects, follows external
 * references, or fetches URLs — it only reports their presence for the caller's gate.
 */
export interface DocxExtraction {
  ok: boolean;
  title?: string;
  /** Body paragraph texts, excluding text that lives inside tables. */
  paragraphs: string[];
  /** tables -> rows -> cells (cell text; empty cells preserved as ""). */
  tables: string[][][];
  /** Rendered text of every header and footer part. */
  headersFooters: string[];
  /** Rendered text of foot/end notes (structural separator notes dropped). */
  footnotes: string[];
  /** Rendered text of review comments. */
  comments: string[];
  /** True when a VBA macro project (word/vbaProject.bin) is present (a .docm). */
  macroDetected: boolean;
  /** Count of embedded OLE/object parts (word/embeddings/*, oleObject*). */
  embeddedObjectCount: number;
  /** Count of media/image parts (word/media/*). */
  imageCount: number;
  /** True when tracked insertions/deletions (<w:ins>/<w:del>) are present. */
  trackedChangesDetected: boolean;
  warnings: string[];
  status: "extracted" | "unsupported" | "failed";
}

/** Minimal internal view of an unzipped entry, extracted defensively at runtime. */
interface ZipEntry {
  path: string;
  data: Buffer;
}

const MAX_SCAN_BYTES = 64 * 1024 * 1024;

// safe-unzip only decompresses entries for which the predicate returns true, so we
// request exactly the parts we parse. Text-bearing parts (kept small) are fetched
// separately from bulky media, so an oversized image can never evict the document.
function isTextPart(rawPath: string): boolean {
  const p = normPath(rawPath);
  return (
    p === "word/document.xml" ||
    p === "word/footnotes.xml" ||
    p === "word/endnotes.xml" ||
    p === "word/comments.xml" ||
    p === "docprops/core.xml" ||
    p === "word/vbaproject.bin" ||
    /^word\/(header|footer)\d*\.xml$/.test(p)
  );
}

function isMediaPart(rawPath: string): boolean {
  const p = normPath(rawPath);
  return (
    p.startsWith("word/media/") ||
    p.startsWith("word/embeddings/") ||
    /(^|\/)oleobject\d*\.[a-z0-9]+$/.test(p)
  );
}

function failed(warnings: string[]): DocxExtraction {
  return {
    ok: false,
    paragraphs: [],
    tables: [],
    headersFooters: [],
    footnotes: [],
    comments: [],
    macroDetected: false,
    embeddedObjectCount: 0,
    imageCount: 0,
    trackedChangesDetected: false,
    warnings,
    status: "failed",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asBuffer(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return undefined;
}

/**
 * Normalize the (intentionally untyped) result of readZipEntriesSafely into a flat
 * list of {path,data} entries plus its warnings. The safe-unzip module is authored
 * independently, so we introspect its result structurally rather than binding to an
 * exact type — accepting entries as an array, a Map, or a plain object of buffers,
 * with common field aliases (path/name, data/buffer/content).
 */
function normalizeZipResult(raw: unknown): {
  ok: boolean;
  entries: ZipEntry[];
  warnings: string[];
} {
  const warnings: string[] = [];
  let ok = true;
  let container: unknown = raw;

  if (isRecord(raw)) {
    if (Array.isArray(raw.warnings)) {
      for (const w of raw.warnings) if (typeof w === "string") warnings.push(w);
    }
    if (typeof raw.ok === "boolean") ok = raw.ok;
    if (typeof raw.status === "string" && raw.status !== "ok" && raw.status !== "extracted") {
      ok = false;
    }
    // safe-unzip signals a hit limit / malformed archive via `aborted`.
    if (raw.aborted === true) ok = false;
    if (typeof raw.abortReason === "string" && raw.abortReason.length > 0) {
      warnings.push(raw.abortReason);
    }
    if ("entries" in raw && raw.entries !== undefined) container = raw.entries;
    else if ("files" in raw && raw.files !== undefined) container = raw.files;
  }

  const entries: ZipEntry[] = [];
  const push = (path: unknown, data: unknown): void => {
    if (typeof path !== "string") return;
    const buf = asBuffer(data);
    if (!buf) return;
    entries.push({ path, data: buf });
  };
  const pushItem = (item: unknown, keyHint?: string): void => {
    const direct = asBuffer(item);
    if (direct && keyHint !== undefined) {
      push(keyHint, direct);
      return;
    }
    if (isRecord(item)) {
      const path = item.path ?? item.name ?? item.filename ?? item.entryName ?? keyHint;
      const data = item.data ?? item.buffer ?? item.content ?? item.contents;
      push(path, data);
    }
  };

  if (container instanceof Map) {
    for (const [key, value] of container.entries()) {
      pushItem(value, typeof key === "string" ? key : undefined);
    }
  } else if (Array.isArray(container)) {
    for (const item of container) pushItem(item);
  } else if (isRecord(container)) {
    for (const [key, value] of Object.entries(container)) pushItem(value, key);
  }

  return { ok, entries, warnings };
}

function normPath(p: string): string {
  return p.replace(/^\.?[/\\]+/, "").replace(/\\/g, "/").toLowerCase();
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Namespace-tolerant matchers. The local element name is fixed by the OOXML schema
// (t, p, tbl, tr, tc, ...) while the prefix (default "w:") may vary, so we allow an
// optional "<prefix>:" and require the local name be delimited by a space or ">".
function localTagOpenClose(local: string): RegExp {
  return new RegExp(`<(?:[\\w.-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${local}>`, "g");
}

const RE_TEXT = localTagOpenClose("t");
const RE_PARA = localTagOpenClose("p");
const RE_TABLE = localTagOpenClose("tbl");
const RE_ROW = localTagOpenClose("tr");
const RE_CELL = localTagOpenClose("tc");
const RE_TAB = /<(?:[\w.-]+:)?tab(?:\s[^>]*)?\/?>/g;
const RE_BREAK = /<(?:[\w.-]+:)?(?:br|cr)(?:\s[^>]*)?\/?>/g;

/**
 * Concatenate the decoded text of every <w:t> run in a fragment. Structural tab and
 * break elements (<w:tab/>, <w:br/>) live between runs rather than inside them, so we
 * turn them into a single boundary space to avoid fusing adjacent words.
 */
function runsText(fragment: string): string {
  const spaced = fragment.replace(RE_TAB, " <w:t> </w:t>").replace(RE_BREAK, " <w:t> </w:t>");
  let out = "";
  RE_TEXT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_TEXT.exec(spaced)) !== null) {
    out += decodeEntities(m[1] ?? "");
  }
  return out.replace(/[ \t]{2,}/g, " ");
}

function paragraphsOf(xml: string): string[] {
  const result: string[] = [];
  RE_PARA.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_PARA.exec(xml)) !== null) {
    const text = runsText(m[1] ?? "").trim();
    if (text.length > 0) result.push(text);
  }
  return result;
}

function cellText(cellXml: string): string {
  const paras = paragraphsOf(cellXml);
  if (paras.length > 0) return paras.join("\n");
  // Fallback: some cells hold runs not wrapped in a <w:p> we matched.
  return runsText(cellXml).trim();
}

function parseTables(bodyXml: string): { tables: string[][][]; withoutTables: string } {
  const tables: string[][][] = [];
  RE_TABLE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const tableSpans: string[] = [];
  while ((m = RE_TABLE.exec(bodyXml)) !== null) {
    tableSpans.push(m[0] ?? "");
    const tableXml = m[1] ?? "";
    const rows: string[][] = [];
    RE_ROW.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = RE_ROW.exec(tableXml)) !== null) {
      const rowXml = rm[1] ?? "";
      const cells: string[] = [];
      RE_CELL.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = RE_CELL.exec(rowXml)) !== null) {
        cells.push(cellText(cm[1] ?? ""));
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  let withoutTables = bodyXml;
  for (const span of tableSpans) withoutTables = withoutTables.replace(span, " ");
  return { tables, withoutTables };
}

function bodyOf(documentXml: string): string {
  const m = /<(?:[\w.-]+:)?body(?:\s[^>]*)?>([\s\S]*)<\/(?:[\w.-]+:)?body>/.exec(documentXml);
  return m ? (m[1] ?? "") : documentXml;
}

function firstTagText(xml: string, local: string): string | undefined {
  const re = new RegExp(`<(?:[\\w.-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${local}>`);
  const m = re.exec(xml);
  if (!m) return undefined;
  const text = decodeEntities(m[1] ?? "").trim();
  return text.length > 0 ? text : undefined;
}

function utf8(entry: ZipEntry | undefined): string {
  if (!entry) return "";
  if (entry.data.length > MAX_SCAN_BYTES) {
    return entry.data.subarray(0, MAX_SCAN_BYTES).toString("utf8");
  }
  return entry.data.toString("utf8");
}

/**
 * Extract text and structure from a DOCX buffer without executing anything.
 * Never throws for expected-bad input: corrupt archives yield status "failed",
 * non-DOCX zips yield status "unsupported"; both carry explanatory warnings.
 */
export async function extractDocx(buf: Buffer): Promise<DocxExtraction> {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return failed(["input is not a non-empty Buffer"]);
  }

  // Pass 1: the small, text-bearing parts (+ vbaProject.bin). Kept separate from
  // bulky media so an oversized image can never evict the document from the result.
  let textRaw: unknown;
  try {
    textRaw = readZipEntriesSafely(buf, isTextPart);
  } catch {
    return failed(["archive could not be read (corrupt or unsupported container)"]);
  }

  const { ok: unzipOk, entries, warnings: unzipWarnings } = normalizeZipResult(textRaw);
  const warnings: string[] = [...unzipWarnings];

  // Empty AND aborted means the container itself was unreadable (corrupt/malformed);
  // empty but not aborted means a valid zip that simply holds no Word parts.
  if (entries.length === 0 && !unzipOk) {
    warnings.push("archive could not be read (corrupt or unsupported container)");
    return failed(warnings);
  }

  const byPath = new Map<string, ZipEntry>();
  for (const e of entries) byPath.set(normPath(e.path), e);

  const macroDetected = byPath.has("word/vbaproject.bin");

  // Pass 2: bulky media/embeddings, only to inventory them. This pass is strictly
  // best-effort — if it aborts (e.g. a zip bomb in an image) it must never fail the
  // whole extraction; we simply report what we could count with a warning.
  let imageCount = 0;
  let embeddedObjectCount = 0;
  try {
    const mediaRaw: unknown = readZipEntriesSafely(buf, isMediaPart);
    const { entries: mediaEntries, warnings: mediaWarnings } = normalizeZipResult(mediaRaw);
    for (const w of mediaWarnings) warnings.push(w);
    for (const e of mediaEntries) {
      const key = normPath(e.path);
      if (key.startsWith("word/media/")) imageCount += 1;
      else embeddedObjectCount += 1;
    }
  } catch {
    warnings.push("embedded-object inventory could not be completed");
  }

  const docEntry = byPath.get("word/document.xml");
  if (!docEntry) {
    warnings.push("no word/document.xml part found; not a Word document");
    return {
      ...failed(warnings),
      macroDetected,
      imageCount,
      embeddedObjectCount,
      status: "unsupported",
    };
  }

  const documentXml = utf8(docEntry);
  const body = bodyOf(documentXml);
  const trackedChangesDetected =
    /<(?:[\w.-]+:)?ins(?:\s[^>]*)?>/.test(documentXml) ||
    /<(?:[\w.-]+:)?del(?:\s[^>]*)?>/.test(documentXml);

  const { tables, withoutTables } = parseTables(body);
  const paragraphs = paragraphsOf(withoutTables);

  const headersFooters: string[] = [];
  for (const key of [...byPath.keys()].sort()) {
    if (/^word\/(header|footer)\d*\.xml$/.test(key)) {
      const text = paragraphsOf(utf8(byPath.get(key))).join("\n").trim();
      if (text.length > 0) headersFooters.push(text);
    }
  }

  const footnotes: string[] = [];
  for (const part of ["word/footnotes.xml", "word/endnotes.xml"]) {
    const entry = byPath.get(part);
    if (!entry) continue;
    const xml = utf8(entry);
    const noteRe =
      /<(?:[\w.-]+:)?(?:footnote|endnote)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?(?:footnote|endnote)>/g;
    let nm: RegExpExecArray | null;
    while ((nm = noteRe.exec(xml)) !== null) {
      const text = paragraphsOf(nm[1] ?? "").join("\n").trim();
      if (text.length > 0) footnotes.push(text);
    }
  }

  const comments: string[] = [];
  const commentsEntry = byPath.get("word/comments.xml");
  if (commentsEntry) {
    const xml = utf8(commentsEntry);
    const commentRe = /<(?:[\w.-]+:)?comment(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?comment>/g;
    let cm: RegExpExecArray | null;
    while ((cm = commentRe.exec(xml)) !== null) {
      const text = paragraphsOf(cm[1] ?? "").join("\n").trim();
      if (text.length > 0) comments.push(text);
    }
  }

  const coreEntry = byPath.get("docprops/core.xml");
  const title = coreEntry ? firstTagText(utf8(coreEntry), "title") : undefined;

  if (macroDetected) {
    warnings.push("VBA macro project present (word/vbaProject.bin); macros were NOT executed");
  }
  if (embeddedObjectCount > 0) {
    warnings.push(`${embeddedObjectCount} embedded object(s) present; not opened or resolved`);
  }
  if (imageCount > 0) {
    warnings.push(`${imageCount} embedded image(s) present`);
  }
  if (trackedChangesDetected) {
    warnings.push("tracked changes present; extracted text reflects the stored markup");
  }
  if (!unzipOk) {
    warnings.push("underlying unzip reported a non-clean status");
  }

  const result: DocxExtraction = {
    ok: true,
    paragraphs,
    tables,
    headersFooters,
    footnotes,
    comments,
    macroDetected,
    embeddedObjectCount,
    imageCount,
    trackedChangesDetected,
    warnings,
    status: "extracted",
  };
  if (title !== undefined) result.title = title;
  return result;
}
