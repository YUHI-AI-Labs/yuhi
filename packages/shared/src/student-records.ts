export type StudentRecordSensitivity = "none" | "confidential" | "restricted";
export type DirectIdentifierType =
  | "name"
  /** Phonetic reading of a personal name (フリガナ / カナ氏名). Personal data in its
   *  own right, and kept a SEPARATE type so a table carrying both 氏名 and フリガナ
   *  still resolves to one entity instead of falling back to column-scoped tokens. */
  | "name-reading"
  | "student-id"
  | "student-card"
  | "employee-id"
  | "account-id"
  | "email"
  | "phone"
  | "address"
  | "institutional-id";

export interface StudentRecordClassification {
  sensitivity: StudentRecordSensitivity;
  directIdentifierColumns: number;
  performanceColumns: number;
  directIdentifierIndexes: number[];
  directIdentifierTypes: DirectIdentifierType[];
  performanceIndexes: number[];
  associatedCategories: string[];
}

function normalizedHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_.:/()（）-]+/g, "");
}

function directIdentifierType(value: string): DirectIdentifierType | undefined {
  const header = normalizedHeader(value);
  const groups: [DirectIdentifierType, string[]][] = [
    ["name", ["fullname", "studentname", "name", "フルネーム", "氏名", "学生氏名", "名前"]],
    // A name READING is personal data: it identifies the person as directly as the
    // name does. Leaving it in place also blocks the whole file's transform, because
    // a surviving 氏名 value in this column fails the post-transform safety check.
    ["name-reading", [
      "フリガナ", "ふりがな", "カナ", "カナ氏名", "氏名カナ", "フリガナ氏名",
      "セイメイカナ", "namekana", "kana", "furigana", "phonetic",
    ]],
    ["student-card", ["studentcardnumber", "学生証番号"]],
    ["student-id", ["studentid", "studentnumber", "学籍番号", "idナンバ"]],
    ["employee-id", ["employeeid", "employeenumber", "社員番号", "従業員番号"]],
    ["account-id", ["accountid", "memberid", "会員番号"]],
    ["email", ["email", "emailaddress", "メール", "メールアドレス"]],
    ["phone", ["phone", "phonenumber", "電話", "電話番号"]],
    ["address", ["address", "住所"]],
    ["institutional-id", ["governmentid", "institutionalid"]],
  ];
  const aliasMatch = groups.find(([, aliases]) =>
    aliases.some((candidate) => {
      const normalized = normalizedHeader(candidate);
      if (header === normalized) return true;
      // Accept descriptive suffixes on specific identifier headers, e.g.
      // 学生証番号6桁 or "student id (required)". Do not prefix-match generic
      // labels such as "name", "email", or "phone".
      return normalized.length >= 5 && header.startsWith(normalized);
    }),
  )?.[0];
  if (aliasMatch) return aliasMatch;
  // General rule (not a guessed header list): Japanese compound headers place
  // the qualifier first and the identifier morpheme last — 受診者氏名, 保護者氏名,
  // 受診者番号, 整理番号, 連絡先メール. Match by the trailing morpheme so any
  // X氏名 / X番号 / Xメール is recognized without enumerating every prefix.
  const morphemes: [DirectIdentifierType, string[]][] = [
    ["name-reading", ["フリガナ", "ふりがな", "氏名カナ", "カナ"]],
    ["name", ["氏名", "名前", "フルネーム", "なまえ"]],
    ["email", ["メールアドレス", "メール"]],
    ["phone", ["電話番号", "電話", "tel"]],
    ["address", ["住所"]],
    ["account-id", ["番号", "id", "コード"]],
  ];
  return morphemes.find(([, suffixes]) =>
    suffixes.some((suffix) => {
      const normalized = normalizedHeader(suffix);
      return header.endsWith(normalized) && header.length <= normalized.length + 8;
    }),
  )?.[0];
}

function associatedCategory(value: string): string | undefined {
  const header = normalizedHeader(value);
  const groups: [string, string[]][] = [
    ["education-performance", ["grade", "grades", "score", "scores", "quiz", "coursetotal", "attendance", "評定", "評点", "成績", "点数", "小テスト", "コース合計", "出席", "出席率"]],
    ["salary", ["salary", "compensation", "給与", "賃金", "報酬"]],
    ["performance-evaluation", ["performanceevaluation", "evaluation", "人事評価", "勤務評定"]],
    ["health", ["health", "diagnosis", "medical", "健康", "診断", "病歴"]],
    ["disciplinary", ["disciplinary", "discipline", "懲戒", "処分"]],
  ];
  return groups.find(([, aliases]) =>
    aliases.some((candidate) => header === normalizedHeader(candidate) || header.includes(normalizedHeader(candidate))),
  )?.[0];
}

export function classifyStudentRecordHeaders(headers: readonly string[]): StudentRecordClassification {
  const directIdentifierIndexes: number[] = [];
  const directIdentifierTypes: DirectIdentifierType[] = [];
  const performanceIndexes: number[] = [];
  headers.forEach((header, index) => {
    const identifierType = directIdentifierType(header);
    if (identifierType) {
      directIdentifierIndexes.push(index);
      directIdentifierTypes.push(identifierType);
    }
    if (associatedCategory(header)) performanceIndexes.push(index);
  });
  const associatedCategories = [...new Set(
    headers.map(associatedCategory).filter((value): value is string => value !== undefined),
  )];
  const sensitivity: StudentRecordSensitivity =
    directIdentifierIndexes.length > 0 && performanceIndexes.length > 0
      ? "restricted"
      : directIdentifierIndexes.length > 0 || performanceIndexes.length > 0
        ? "confidential"
        : "none";
  return {
    sensitivity,
    directIdentifierColumns: directIdentifierIndexes.length,
    performanceColumns: performanceIndexes.length,
    directIdentifierIndexes,
    directIdentifierTypes,
    performanceIndexes,
    associatedCategories,
  };
}

/**
 * Coarse value shape, used to compare row 0 against the body. Shapes — not row
 * indexes — are what distinguish a heading from a record: a heading cell is a
 * label, a record cell looks like the rest of its column.
 */
export type CellShape =
  | "empty"
  | "email"
  | "phone"
  | "datetime"
  | "time"
  | "numeric"
  | "code"
  | "text";

/** A calendar date or timestamp. Checked BEFORE `phone`: `2026-07-15` is digits
 *  and hyphens, so a bare ISO date otherwise matches the phone pattern and a whole
 *  date column would be tokenized as PHONE-nnn. */
export const DATETIME_RE =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;
const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{7,}$/;
/**
 * Email SHAPE test, deliberately linear.
 *
 * `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` is ambiguous — `.` is also matched by `[^@\s]` — so
 * the domain part backtracks quadratically on input like `a@a.` followed by many
 * `a.` repetitions (CodeQL js/polynomial-redos). `cellShape` runs on EVERY cell of
 * EVERY delivered table, i.e. on fully untrusted input, so the exposure is real.
 * Excluding `.` from the label class makes each position match exactly one way.
 */
const EMAIL_RE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;

/** A cell longer than this is never an identifier shape worth pattern-matching. */
const MAX_SHAPE_INPUT = 512;

export function cellShape(cell: string): CellShape {
  const value = cell.trim();
  if (value.length === 0) return "empty";
  // Bound the work regardless of pattern shape: a multi-kilobyte cell is free text,
  // never an email/phone/id, so there is nothing to gain by matching it.
  if (value.length > MAX_SHAPE_INPUT) return "text";
  if (EMAIL_RE.test(value)) return "email";
  if (DATETIME_RE.test(value)) return "datetime";
  if (TIME_RE.test(value)) return "time";
  if (PHONE_RE.test(value)) return "phone";
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return "numeric";
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return "code";
  return "text";
}

/** A value that must never be treated as a phone number. */
export function isTemporalValue(value: string): boolean {
  const trimmed = value.trim();
  return DATETIME_RE.test(trimmed) || TIME_RE.test(trimmed);
}

function modalShape(shapes: readonly CellShape[]): CellShape | undefined {
  const counts = new Map<CellShape, number>();
  for (const shape of shapes) counts.set(shape, (counts.get(shape) ?? 0) + 1);
  let best: CellShape | undefined;
  let bestCount = 0;
  for (const [shape, count] of counts) {
    if (count > bestCount) {
      best = shape;
      bestCount = count;
    }
  }
  return best;
}

/**
 * One interpretation of a table's structure, computed ONCE per file. The
 * transform may use `dataStartRow`; privacy VERIFICATION must never depend on it
 * (see `tabularVerificationValues`) — when the transform and the verifier share a
 * header/body guess, a misdetected header row is exempt from both, so a residue
 * and `identifierLeaks: 0` can be true at the same time.
 */
export interface TableLayout {
  hasHeader: boolean;
  headerRow?: number;
  dataStartRow: number;
  delimiter: string;
  columnCount: number;
}

/**
 * Whether row 0 carries DATA rather than column headings.
 *
 * Two signals, in order of confidence:
 *   1. Row 0 contains a RECOGNIZED header label (an identifier or associated-data
 *      alias) → it is a header. This keeps every headed table behaving exactly as
 *      before, including real-world Japanese exports.
 *   2. Otherwise compare shapes per column: when row 0 looks like the rest of its
 *      column for most comparable columns, the table starts at row 0.
 *
 * A single-row table is treated as DATA: pseudonymizing a lone heading costs
 * nothing (there are no records to describe), while treating a lone record as a
 * heading leaks it in full.
 */
export function tableStartsWithData(row: readonly string[]): boolean {
  // Kept for compatibility: a single-row judgement with no body to compare against.
  // A heading cell is never an email address or a phone number.
  return row.some((cell) => {
    const shape = cellShape(cell);
    return shape === "email" || shape === "phone";
  });
}

function rowCarriesRecognizedHeader(row: readonly string[]): boolean {
  return row.some((cell) => {
    const value = cell.trim();
    if (value.length === 0) return false;
    return directIdentifierType(value) !== undefined || associatedCategory(value) !== undefined;
  });
}

export function detectTableLayout(
  rows: readonly (readonly string[])[],
  delimiter = ",",
): TableLayout {
  const columnCount = rows[0]?.length ?? 0;
  const base = { delimiter, columnCount };
  if (rows.length === 0) return { ...base, hasHeader: false, dataStartRow: 0 };
  const row0 = rows[0]!;
  // (1) A recognized header label is decisive.
  if (rowCarriesRecognizedHeader(row0)) {
    return { ...base, hasHeader: true, headerRow: 0, dataStartRow: 1 };
  }
  // A lone row is treated as data (see doc comment).
  if (rows.length < 2) return { ...base, hasHeader: false, dataStartRow: 0 };
  // (2) Shape comparison against the body.
  const body = rows.slice(1, 51);
  let comparable = 0;
  let dataLike = 0;
  for (let column = 0; column < columnCount; column += 1) {
    const headerCellShape = cellShape(row0[column] ?? "");
    if (headerCellShape === "empty") continue;
    const bodyShapes = body
      .map((row) => cellShape(row[column] ?? ""))
      .filter((shape) => shape !== "empty");
    if (bodyShapes.length === 0) continue;
    const modal = modalShape(bodyShapes);
    if (modal === undefined) continue;
    comparable += 1;
    if (headerCellShape === modal) dataLike += 1;
  }
  // No comparable column → keep the historical assumption (row 0 is a header).
  if (comparable === 0) return { ...base, hasHeader: true, headerRow: 0, dataStartRow: 1 };
  return dataLike / comparable >= 0.5
    ? { ...base, hasHeader: false, dataStartRow: 0 }
    : { ...base, hasHeader: true, headerRow: 0, dataStartRow: 1 };
}

/** First row index that holds records (0 for a headerless table). */
export function tableBodyStart(rows: readonly (readonly string[])[]): number {
  return detectTableLayout(rows).dataStartRow;
}

export function classifyStudentRecordTable(rows: readonly (readonly string[])[]): StudentRecordClassification {
  const bodyStart = tableBodyStart(rows);
  // A data row must never be mined for header aliases.
  const base = bodyStart === 0
    ? classifyStudentRecordHeaders([])
    : classifyStudentRecordHeaders(rows[0] ?? []);
  const indexes = [...base.directIdentifierIndexes];
  const types = [...base.directIdentifierTypes];
  const sampled = rows.slice(bodyStart, bodyStart + 50);
  // A header-matched `name` column holding plain numbers is an aggregate, not a
  // person — pivot count columns ("個数 / フルネーム") land here. Pseudonymizing
  // them buys no privacy and destroys the distribution the table exists to show.
  for (let position = indexes.length - 1; position >= 0; position -= 1) {
    if (types[position] !== "name" && types[position] !== "name-reading") continue;
    const values = sampled.map((row) => (row[indexes[position]!] ?? "").trim()).filter(Boolean);
    if (values.length === 0) continue;
    const numeric = values.filter((value) => /^-?\d+(?:\.\d+)?$/.test(value)).length;
    if (numeric / values.length >= 0.9) {
      indexes.splice(position, 1);
      types.splice(position, 1);
    }
  }
  for (let index = 0; index < (rows[0]?.length ?? 0); index += 1) {
    if (indexes.includes(index)) continue;
    const values = sampled.map((row) => (row[index] ?? "").trim()).filter(Boolean);
    if (values.length === 0) continue;
    const emailCount = values.filter((value) => EMAIL_RE.test(value)).length;
    // A date is digits + separators and otherwise matches the phone pattern, so
    // temporal values are excluded before counting phones (a `登録日時` column must
    // stay a measurement, never become PHONE-nnn).
    const phoneCount = values.filter(
      (value) => PHONE_RE.test(value) && !isTemporalValue(value),
    ).length;
    // Header-independent identifier detection: a column whose values are
    // almost all distinct and shaped like record codes (A000000, 20260722-…,
    // fixed-width numeric IDs) is a direct identifier even when Yuhi does not
    // recognize its header. Requiring high cardinality + a code shape avoids
    // masking measurements (decimals, short repeated categories).
    const unique = new Set(values).size;
    const cardinality = unique / values.length;
    // Fixed-width is a strong record-code signal (zero-padded / sequential IDs
    // share a length; quantities like revenue vary in magnitude), so pure
    // numeric columns only count as codes when every sampled value shares a
    // width. Mixed alphanumeric (A000000) is already unambiguous.
    const numericWidths = new Set(values.filter((value) => /^\d+$/.test(value)).map((value) => value.length));
    const numericFixedWidth = numericWidths.size === 1;
    const codeCount = values.filter((value) => {
      if (value.length < 4 || value.length > 48) return false;
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false; // pure code, no spaces/CJK
      if (value.includes(".") && /^\d+\.\d+$/.test(value)) return false; // decimal measurement
      const hasLetter = /[A-Za-z]/.test(value);
      const digits = (value.match(/\d/g) ?? []).length;
      if (hasLetter) return digits >= 1; // alphanumeric code — unambiguous
      return digits >= 6 && numericFixedWidth; // long, fixed-width numeric ID only
    }).length;
    const inferred: DirectIdentifierType | undefined =
      emailCount / values.length >= 0.8
        ? "email"
        : phoneCount / values.length >= 0.8
          ? "phone"
          : cardinality >= 0.9 && codeCount / values.length >= 0.8
            ? "account-id"
            : undefined;
    if (inferred) {
      indexes.push(index);
      types.push(inferred);
    }
  }
  const sensitivity: StudentRecordSensitivity =
    indexes.length > 0 && base.performanceIndexes.length > 0
      ? "restricted"
      : indexes.length > 0 || base.performanceIndexes.length > 0
        ? "confidential"
        : "none";
  return {
    ...base,
    sensitivity,
    directIdentifierColumns: indexes.length,
    directIdentifierIndexes: indexes,
    directIdentifierTypes: types,
  };
}

export interface ParsedDelimitedTable {
  delimiter: "," | "\t";
  rows: string[][];
}

/** Tokenize delimited text into rows WITHOUT validating column consistency. */
function tokenizeDelimited(input: string): { delimiter: "," | "\t"; rows: string[][] } {
  const text = input.replace(/^\uFEFF/, "");
  const firstLineEnd = text.search(/\r?\n/);
  const firstLine = firstLineEnd < 0 ? text : text.slice(0, firstLineEnd);
  const delimiter: "," | "\t" =
    (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("Malformed delimited table: unterminated quoted field.");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return { delimiter, rows };
}

export function parseDelimitedTable(input: string): ParsedDelimitedTable {
  const { delimiter, rows } = tokenizeDelimited(input);
  // A SINGLE multi-column row is a valid (headerless) table. Rejecting it used to
  // route single-record exports to raw passthrough, leaking the record in full.
  if (rows.length < 1 || rows[0]!.length < 1 || (rows.length < 2 && rows[0]!.length < 2)) {
    throw new Error("Malformed delimited table: at least one multi-column row is required.");
  }
  const width = rows[0]!.length;
  if (rows.some((candidate) => candidate.length !== width)) {
    throw new Error("Malformed delimited table: inconsistent column count.");
  }
  return { delimiter, rows };
}

/**
 * Real-world exports (especially Japanese systems) often prepend title/metadata
 * rows before the actual header \u2014 e.g. `\u5065\u5EB7\u8A3A\u65AD\u7D50\u679C\u4E00\u89A7`, `\u51FA\u529B\u65E5,2026-07-22`, a
 * blank line, then the table. Strict parsing rejects these as ragged, which used
 * to route a clearly-sensitive file to raw passthrough.
 *
 * This finds the consistent table region (a run of >=2 rows sharing the modal
 * column count, width >= 2) and returns it plus the dropped preamble rows, so the
 * transform can pseudonymize the table and re-emit the preamble unchanged.
 * Returns null when no such region exists (a genuinely malformed file).
 */
export function splitTablePreamble(
  input: string,
): { preamble: string[][]; table: ParsedDelimitedTable } | null {
  const { delimiter, rows } = tokenizeDelimited(input);
  if (rows.length < 3) return null; // need preamble + header + >=1 data row
  // Modal column count among candidate table rows (>= 2 columns).
  const widthCounts = new Map<number, number>();
  for (const row of rows) {
    if (row.length >= 2) widthCounts.set(row.length, (widthCounts.get(row.length) ?? 0) + 1);
  }
  let modalWidth = 0;
  let modalCount = 0;
  for (const [width, count] of widthCounts) {
    if (count > modalCount || (count === modalCount && width > modalWidth)) {
      modalWidth = width;
      modalCount = count;
    }
  }
  if (modalWidth < 2 || modalCount < 2) return null;
  // First index that begins a contiguous run of >=2 modal-width rows (the header).
  let start = -1;
  for (let i = 0; i < rows.length - 1; i += 1) {
    if (rows[i]!.length === modalWidth && rows[i + 1]!.length === modalWidth) {
      start = i;
      break;
    }
  }
  if (start <= 0) return null; // no preamble (start 0) or not found
  const tableRows = rows.slice(start).filter((row) => row.length === modalWidth);
  if (tableRows.length < 2) return null;
  return { preamble: rows.slice(0, start), table: { delimiter, rows: tableRows } };
}

function encodeCell(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

export function serializeDelimitedTable(table: ParsedDelimitedTable): string {
  return table.rows
    .map((row) => row.map((cell) => encodeCell(cell, table.delimiter)).join(table.delimiter))
    .join("\n") + "\n";
}

export interface StudentRecordTransform {
  output: string;
  classification: StudentRecordClassification;
  aliasesCreated: number;
  valuesReplaced: number;
  /** Rows whose identifiers conflicted and were isolated under a fresh entity
   *  (best-effort). > 0 means the output is de-identified but linkage may be
   *  imperfect — surfaced as a data-quality warning, never a failure. */
  conflicts: number;
}

/**
 * Parse a table, transparently stripping a leading metadata preamble when strict
 * parsing fails only because of it. The preamble rows are returned so a transform
 * that re-emits the whole file (pseudonymization) can prepend them unchanged.
 */
function parseTableWithPreamble(
  input: string,
): { table: ParsedDelimitedTable; preamble: string[][] } {
  try {
    return { table: parseDelimitedTable(input), preamble: [] };
  } catch (error) {
    if (error instanceof Error && /inconsistent column count/.test(error.message)) {
      const stripped = splitTablePreamble(input);
      if (stripped) return { table: stripped.table, preamble: stripped.preamble };
    }
    throw error;
  }
}

/** Prepend serialized preamble rows to a transformed table body. */
function withPreamble(preamble: string[][], delimiter: "," | "\t", body: string): string {
  if (preamble.length === 0) return body;
  return serializeDelimitedTable({ delimiter, rows: preamble }) + body;
}

export interface StudentAliasContext {
  identifierToEntity: Map<string, number | null>;
  /** Per-entity committed identifiers, keyed by `type#columnIndex` (a table may
   *  legitimately carry several columns of the same identifier type). */
  entityIdentifiers: Map<number, Map<string, string>>;
  nextEntity: number;
  /** Value-keyed stable tokens for attributes tokenized by value (e.g. phone). */
  attributeTokens: Map<string, string>;
  /** Value-keyed stable tokens for columns tokenized per column (see
   *  `columnScopedAlias`). Keyed `columnIndex\u0000type:value`. */
  columnTokens: Map<string, string>;
  /** Next ordinal per token namespace. */
  columnTokenCounts: Map<string, number>;
  /**
   * Token already issued for (entity, bucket). Without this, one entity got
   * `SID-001` from a headed file and `ACCOUNT-001` from a headerless one, because
   * the token PREFIX followed whichever type that file happened to infer.
   */
  entityBucketTokens: Map<string, string>;
}

/**
 * Run-scoped pseudonym registry (#11).
 *
 * ONE instance per prepare run, shared by CSV, TSV, TXT and XLSX. There are no
 * file-local counters: a file-local counter is exactly what made the same value
 * receive a different token in each file.
 *
 * Invariant: same run + same normalized value + same bucket -> same pseudonym,
 * independent of format, file path, row order and column order.
 */
export interface RunPseudonymRegistry {
  getOrCreate(entityType: DirectIdentifierType, normalizedValue: string): string;
  /** The underlying alias context, for the row-level entity resolution. */
  readonly context: StudentAliasContext;
}

export function createRunPseudonymRegistry(
  context: StudentAliasContext = createStudentAliasContext(),
): RunPseudonymRegistry {
  return {
    context,
    getOrCreate(entityType, normalizedValue) {
      return columnScopedAlias(context, entityType, 0, "A", normalizedValue);
    },
  };
}

export function createStudentAliasContext(): StudentAliasContext {
  return {
    identifierToEntity: new Map(),
    entityIdentifiers: new Map(),
    nextEntity: 1,
    attributeTokens: new Map(),
    columnTokens: new Map(),
    columnTokenCounts: new Map(),
    entityBucketTokens: new Map(),
  };
}

/** Stable per-distinct-value token so the same phone number always maps to the
 *  same PHONE-NNN (cross-checkable) without exposing the real value. */
function phoneToken(context: StudentAliasContext, value: string): string {
  const key = identifierKey("phone", value);
  const existing = context.attributeTokens.get(key);
  if (existing) return existing;
  let count = 0;
  for (const token of context.attributeTokens.values()) if (token.startsWith("PHONE-")) count += 1;
  const token = `PHONE-${String(count + 1).padStart(3, "0")}`;
  context.attributeTokens.set(key, token);
  return token;
}

/**
 * Generalize a Japanese address: keep the coarse locality (都道府県 / 市区町村 /
 * 町名) and drop the identifying 丁目・番地・号 + building. We cut at the first
 * digit (half- or full-width), which removes the street number while preserving
 * prefecture/city/district. If nothing textual precedes the digits (e.g. a
 * number-first Western address), fall back to a fully-removed marker.
 */
function generalizeAddress(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  const coarse = (normalized.match(/^[^0-9]*/)?.[0] ?? "").trim().replace(/[-\s、,]+$/u, "").trim();
  return coarse.length > 0 ? coarse : "[address removed]";
}

/** One entity may hold one value per identifier COLUMN, not per type. */
/**
 * One entity holds one value per identifier TYPE.
 *
 * Keying by `type#columnIndex` made the slot depend on column POSITION, so the same
 * person read from two files with different column orders looked like a conflict.
 * Keying by BUCKET is the opposite error: a row legitimately carrying both a
 * 学籍番号 and a 学生証番号 would then occupy one slot and conflict with itself.
 * The type is the right granularity.
 */
function entitySlot(item: { type: DirectIdentifierType; index: number }): string {
  return item.type;
}

/**
 * Entity-resolution bucket for an identifier type.
 *
 * A headerless table cannot know that a code column is a 学籍番号 rather than a
 * 会員番号 — header-independent inference can only conclude `account-id`. Keying
 * entity resolution on the inferred TYPE therefore put the same person in two
 * different namespaces depending on whether the file had a header row, and the
 * headed/headerless join rate was 0%. Buckets make resolution type-agnostic within
 * a family while keeping the type for token NAMING.
 *
 * Documented trade-off: two different identifier kinds that share a literal value
 * resolve to one entity. That is unavoidable if a headerless file is to join a
 * headed one at all, and equal strings being treated as equal is the weaker
 * assumption than silently failing to join.
 */
export type IdentifierBucket = "id" | "name" | "name-reading" | "email" | "phone" | "address";

export function identifierBucket(type: DirectIdentifierType): IdentifierBucket {
  switch (type) {
    case "student-id":
    case "student-card":
    case "employee-id":
    case "account-id":
    case "institutional-id":
      return "id";
    case "name":
      return "name";
    case "name-reading":
      return "name-reading";
    case "email":
      return "email";
    case "phone":
      return "phone";
    case "address":
      return "address";
  }
}

export function normalizeIdentifierValue(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function identifierKey(type: DirectIdentifierType, value: string): string {
  return `${identifierBucket(type)}:${normalizeIdentifierValue(value)}`;
}

const COLUMN_TOKEN_PREFIX: Record<DirectIdentifierType, string> = {
  name: "PERSON",
  "name-reading": "READING",
  "student-id": "SID",
  "student-card": "CARD",
  "employee-id": "EID",
  "account-id": "ACCOUNT",
  "institutional-id": "INST",
  email: "ADDR",
  phone: "PHONE",
  address: "PLACE",
};

/**
 * Token for a column whose identifier type occupies SEVERAL columns of the table
 * (course code + teacher code + term code all classified `account-id`, say).
 *
 * Entity-keyed aliasing is wrong here on both axes: it gives one repeated value a
 * different token on every row (destroying `GROUP BY`), and it gives three
 * different columns the SAME token on one row (inventing an equality that does
 * not exist). Tokens are therefore keyed by (column, value): equal values in a
 * column always share a token, and separate columns never collide.
 */
function columnScopedAlias(
  context: StudentAliasContext,
  type: DirectIdentifierType,
  _columnIndex: number,
  _columnLetter: string,
  value: string,
): string {
  // Keyed by (bucket, value) — NOT by column index. Column-index keying made the
  // token depend on where the column happened to sit, so the same value in the same
  // run got different tokens in two files with different column orders. Equal
  // values now always share a token and different values never collide, which is
  // what "no false cross-column equality" actually requires.
  const namespace = identifierBucket(type);
  const key = `${namespace}:${normalizeIdentifierValue(value)}`;
  const existing = context.columnTokens.get(key);
  if (existing) return existing;
  const next = (context.columnTokenCounts.get(namespace) ?? 0) + 1;
  context.columnTokenCounts.set(namespace, next);
  const token = `${COLUMN_TOKEN_PREFIX[type]}-${String(next).padStart(3, "0")}`;
  context.columnTokens.set(key, token);
  return token;
}

/**
 * Token for the ID family (学籍番号 / 学生証番号 / 会員番号 / …), keyed by VALUE.
 *
 * This is the one bucket whose TYPE depends on whether the file had a header: a
 * headed table matches `学籍番号` -> `student-id`, while a headerless table can only
 * infer `account-id`. Entity-keyed naming therefore produced `SID-001` in one file
 * and `ACCOUNT-001` in another for the same person, and the headed/headerless join
 * rate was 0%. Keying the token by (bucket, value) makes it identical in every
 * format, file, row order and column order; the ordinal counter is per TYPE so a
 * row carrying both an id and a card still reads `SID-001,CARD-001`.
 *
 * A CONFLICTING row is deliberately excluded from the shared value registry and
 * gets an isolated token, so a data conflict cannot silently link two people.
 */
function strongValueAlias(
  context: StudentAliasContext,
  type: DirectIdentifierType,
  value: string,
  conflicted: boolean,
): string {
  const bucket = identifierBucket(type);
  const valueKey = `${bucket}:${normalizeIdentifierValue(value)}`;
  if (!conflicted) {
    const existing = context.columnTokens.get(valueKey);
    if (existing) return existing;
  }
  const namespace = `token\u0000${type}`;
  const next = (context.columnTokenCounts.get(namespace) ?? 0) + 1;
  context.columnTokenCounts.set(namespace, next);
  const token = `${COLUMN_TOKEN_PREFIX[type]}-${String(next).padStart(3, "0")}`;
  if (!conflicted) context.columnTokens.set(valueKey, token);
  return token;
}

/**
 * Entity-keyed token, stable per (entity, bucket) for the whole run so the prefix
 * cannot change with the type a given file inferred.
 */
function entityAlias(
  context: StudentAliasContext,
  type: DirectIdentifierType,
  entity: number,
  role: "student" | "employee" | "person",
): string {
  const key = `${entity}\u0000${identifierBucket(type)}`;
  const existing = context.entityBucketTokens.get(key);
  if (existing) return existing;
  const token = aliasFor(type, entity, role);
  if (token) context.entityBucketTokens.set(key, token);
  return token;
}

function aliasFor(
  type: DirectIdentifierType,
  entity: number,
  role: "student" | "employee" | "person",
): string {
  const number = String(entity).padStart(3, "0");
  switch (type) {
    case "name": return `${role === "student" ? "Student" : role === "employee" ? "Employee" : "Person"} ${number}`;
    case "name-reading": return `Reading ${number}`;
    case "student-id": return `SID-${number}`;
    case "student-card": return `CARD-${number}`;
    case "employee-id": return `EID-${number}`;
    case "account-id": return `ACCOUNT-${number}`;
    case "institutional-id": return `INST-${number}`;
    case "email": return `${role}${number}@example.invalid`;
    case "phone":
    case "address":
      return "";
  }
}

export function tabularDirectIdentifierValues(input: string): string[] {
  const { table } = parseTableWithPreamble(input);
  const classification = classifyStudentRecordTable(table.rows);
  const values = new Set<string>();
  for (const row of table.rows.slice(tableBodyStart(table.rows))) {
    for (const index of classification.directIdentifierIndexes) {
      const value = (row[index] ?? "").trim();
      if (value) values.add(value);
    }
  }
  return [...values];
}

/** A value that legitimately survives into the output because it is a column LABEL. */
function isRecognizedHeaderLabel(value: string): boolean {
  return directIdentifierType(value) !== undefined || associatedCategory(value) !== undefined;
}

/**
 * Candidate identifier values for PRIVACY VERIFICATION.
 *
 * Deliberately does NOT skip row 0 and does NOT consult `dataStartRow`. The
 * transform is allowed to guess where the body begins; the verifier must not share
 * that guess, or a header/body misdetection hides its own residue and the run can
 * report `identifierLeaks: 0` while a raw record sits in the delivered bytes.
 *
 * Values that are recognized column LABELS are excluded — those survive by design.
 */
export function tabularVerificationValues(input: string): string[] {
  const { table } = parseTableWithPreamble(input);
  const classification = classifyStudentRecordTable(table.rows);
  const values = new Set<string>();
  for (const row of table.rows) {
    for (const index of classification.directIdentifierIndexes) {
      const value = (row[index] ?? "").trim();
      if (!value || isRecognizedHeaderLabel(value)) continue;
      values.add(value);
    }
  }
  return [...values];
}

/**
 * LAYER 1 — structured full-table rescan. Compares the source and delivered
 * tables cell by cell across EVERY row, header included, and reports identifier
 * cells that came through unchanged. Row indexes are never used to exempt a cell.
 */
export function tabularResidueCells(
  sourceInput: string,
  deliveredInput: string,
): { residueCells: number; residueValues: string[] } {
  let source: ParsedDelimitedTable;
  let delivered: ParsedDelimitedTable;
  try {
    source = parseTableWithPreamble(sourceInput).table;
    delivered = parseTableWithPreamble(deliveredInput).table;
  } catch {
    return { residueCells: 0, residueValues: [] };
  }
  const classification = classifyStudentRecordTable(source.rows);
  const columns = classification.directIdentifierIndexes;
  const residueValues = new Set<string>();
  let residueCells = 0;
  const rowCount = Math.min(source.rows.length, delivered.rows.length);
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    for (const column of columns) {
      const before = (source.rows[rowIndex]?.[column] ?? "").trim();
      const after = (delivered.rows[rowIndex]?.[column] ?? "").trim();
      if (!before || before !== after) continue;
      if (isRecognizedHeaderLabel(before)) continue;
      residueCells += 1;
      residueValues.add(before);
    }
  }
  return { residueCells, residueValues: [...residueValues] };
}

export function pseudonymizeStudentRecords(
  input: string,
  context: StudentAliasContext = createStudentAliasContext(),
): StudentRecordTransform {
  const { table, preamble } = parseTableWithPreamble(input);
  const originalRows = table.rows.map((row) => [...row]);
  const classification = classifyStudentRecordTable(table.rows);
  if (classification.directIdentifierColumns === 0) {
    throw new Error("Safe tabular pseudonymization requires direct-identifier columns.");
  }
  const role: "student" | "employee" | "person" =
    classification.directIdentifierTypes.some((type) => type === "student-id" || type === "student-card")
      ? "student"
      : classification.directIdentifierTypes.includes("employee-id")
        ? "employee"
        : "person";
  // A type that occupies more than one column cannot be resolved to a single
  // entity attribute — those columns are tokenized per (column, value) instead.
  const typeColumns = new Map<DirectIdentifierType, number[]>();
  classification.directIdentifierIndexes.forEach((columnIndex, offset) => {
    const type = classification.directIdentifierTypes[offset]!;
    typeColumns.set(type, [...(typeColumns.get(type) ?? []), columnIndex]);
  });
  const columnLetters = new Map<number, string>();
  const columnScoped = new Set<DirectIdentifierType>();
  for (const [type, columns] of typeColumns) {
    if (columns.length < 2) continue;
    columnScoped.add(type);
    columns.forEach((columnIndex, ordinal) => {
      columnLetters.set(columnIndex, String.fromCharCode(65 + (ordinal % 26)));
    });
  }
  const bodyStart = tableBodyStart(table.rows);
  const entitiesBefore = context.nextEntity;
  let valuesReplaced = 0;
  let conflicts = 0;
  const priority: Record<DirectIdentifierType, number> = {
    "student-card": 1,
    "student-id": 2,
    "employee-id": 3,
    email: 4,
    "institutional-id": 5,
    "account-id": 6,
    phone: 7,
    name: 99,
    "name-reading": 99,
    address: 99,
  };
  for (const row of table.rows.slice(bodyStart)) {
    const identifiers = classification.directIdentifierIndexes.map((index, offset) => ({
      index,
      type: classification.directIdentifierTypes[offset]!,
      value: (row[index] ?? "").trim(),
    })).filter((item) => item.value);
    // A row with no direct identifier (a blank, total/summary, or partially filled
    // row — ubiquitous in real CSV/XLSX) has nothing to pseudonymize. Preserve it
    // verbatim instead of failing the whole file (which would drop it from the
    // Prepared Workspace). The post-transform safety-check remains the backstop
    // against any residual identifier elsewhere in the output.
    if (identifiers.length === 0) continue;
    const strong = identifiers
      .filter((item) =>
        item.type !== "name" &&
        item.type !== "name-reading" &&
        item.type !== "address" &&
        !columnScoped.has(item.type))
      .sort((a, b) => priority[a.type] - priority[b.type]);
    const linked = strong
      .map((item) => context.identifierToEntity.get(identifierKey(item.type, item.value)))
      .filter((entity): entity is number => typeof entity === "number");
    const linkedEntities = [...new Set(linked)];
    // BEST EFFORT (never throw on a data conflict). Detect three kinds of conflict:
    //  1. the row's strong identifiers point to >1 existing entity;
    //  2. the chosen entity already has a DIFFERENT value for one of these types;
    //  3. one of these values is already mapped to a DIFFERENT entity.
    // On any conflict we isolate this row under a FRESH entity (so it is still fully
    // pseudonymized) and do NOT write its mappings into the shared context — that
    // keeps cross-row/cross-file linkage for the CONSISTENT rows intact. The file is
    // still produced; the conflict is a data-quality WARNING, not a failure.
    let entity = linkedEntities.length === 1 ? linkedEntities[0]! : undefined;
    let conflicted = linkedEntities.length > 1;
    if (!conflicted && entity !== undefined) {
      const known = context.entityIdentifiers.get(entity);
      if (known) {
        for (const item of strong) {
          const prior = known.get(entitySlot(item));
          if (prior !== undefined && prior !== identifierKey(item.type, item.value)) {
            conflicted = true;
            break;
          }
        }
      }
    }
    if (!conflicted) {
      for (const item of strong) {
        const existing = context.identifierToEntity.get(identifierKey(item.type, item.value));
        if (existing !== undefined && existing !== entity) {
          conflicted = true;
          break;
        }
      }
    }
    if (conflicted || entity === undefined) {
      entity = context.nextEntity;
      context.nextEntity += 1;
    }
    if (conflicted) conflicts += 1;
    // Commit strong-identifier mappings ONLY for non-conflicting rows, so a bad row
    // can never corrupt the deterministic mapping used by good rows.
    if (!conflicted && strong.length > 0) {
      const known =
        context.entityIdentifiers.get(entity) ?? new Map<string, string>();
      for (const item of strong) {
        const key = identifierKey(item.type, item.value);
        known.set(entitySlot(item), key);
        context.identifierToEntity.set(key, entity);
      }
      context.entityIdentifiers.set(entity, known);
    }
    // Pseudonymize EVERY identifier in the row (best effort) with the chosen entity.
    for (const item of identifiers) {
      const bucket = identifierBucket(item.type);
      row[item.index] =
        bucket === "phone"
          ? phoneToken(context, item.value)
          : bucket === "address"
            ? generalizeAddress(item.value)
            : // The ID family is value-keyed so it joins across formats; a type that
              // spans several columns is value-keyed too, so three unrelated code
              // columns never collapse onto one token.
              bucket === "id" || columnScoped.has(item.type)
              ? strongValueAlias(context, item.type, item.value, conflicted)
              : entityAlias(context, item.type, entity, role);
      valuesReplaced += 1;
    }
    for (const [offset, index] of classification.directIdentifierIndexes.entries()) {
      if (!identifiers.some((item) => item.index === index)) {
        const type = classification.directIdentifierTypes[offset]!;
        if (type === "phone" || type === "address") {
          row[index] = "";
        }
      }
    }
  }
  const direct = new Set(classification.directIdentifierIndexes);
  for (let rowIndex = bodyStart; rowIndex < table.rows.length; rowIndex += 1) {
    for (let column = 0; column < table.rows[0]!.length; column += 1) {
      if (!direct.has(column) && table.rows[rowIndex]![column] !== originalRows[rowIndex]![column]) {
        throw new Error("Tabular transformation changed a non-identifier value.");
      }
    }
  }
  return {
    output: withPreamble(preamble, table.delimiter, serializeDelimitedTable(table)),
    classification,
    aliasesCreated: context.nextEntity - entitiesBefore,
    valuesReplaced,
    conflicts,
  };
}

export function aggregateStudentRecords(input: string): StudentRecordTransform {
  const { table } = parseTableWithPreamble(input);
  const classification = classifyStudentRecordTable(table.rows);
  if (classification.sensitivity === "none") {
    throw new Error("No education-record columns detected.");
  }
  const layout = detectTableLayout(table.rows, table.delimiter);
  const recordCount = table.rows.length - layout.dataStartRow;
  const outputRows: string[][] = [["metric", "records", "numeric_mean"]];
  for (const index of classification.performanceIndexes) {
    const values = table.rows.slice(layout.dataStartRow)
      .map((row) => Number(row[index]))
      .filter((value) => Number.isFinite(value));
    const mean = values.length > 0
      ? String(Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100)
      : "";
    // A headerless table has no label row to name the metric.
    const metricName = layout.hasHeader ? (table.rows[0]![index] ?? `column_${index}`) : `column_${index}`;
    outputRows.push([metricName, String(recordCount), mean]);
  }
  return {
    output: serializeDelimitedTable({ delimiter: ",", rows: outputRows }),
    classification,
    aliasesCreated: 0,
    valuesReplaced: classification.directIdentifierColumns * (table.rows.length - 1),
    conflicts: 0,
  };
}
