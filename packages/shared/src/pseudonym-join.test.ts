import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  createStudentAliasContext,
  createRunPseudonymRegistry,
  identifierBucket,
  parseDelimitedTable,
  pseudonymizeStudentRecords,
} from "./student-records.js";
import { pseudonymizeXlsxRecords } from "./xlsx-records.js";

/**
 * Pseudonym join suite (#11).
 *
 * The defect: a headed table matched `学籍番号` -> `student-id` and produced
 * entity-keyed `SID-nnn`, while a headerless table could only infer `account-id`
 * and produced column-INDEX-keyed `ACCOUNT-<letter>-nnn`. Same run, same values,
 * two token spaces:
 *
 *   CSV <-> XLSX join 100%,  CSV <-> TXT join 0%,  three-way join 0%.
 */

const ROWS = 730;

interface Row {
  sid: string;
  name: string;
  course: string;
  instructor: string;
  grade: string;
}

const rows: Row[] = Array.from({ length: ROWS }, (_, i) => ({
  // Leading-zero IDs: must survive as distinct values and never be numeric-coerced.
  sid: `0${String(i + 1).padStart(6, "0")}`,
  name: `STUDENT_CANARY_${String(i + 1).padStart(4, "0")}`,
  course: "COURSE_CANARY",
  instructor: "INSTRUCTOR_CANARY",
  grade: String(60 + (i % 41)),
}));

/** Deterministic shuffle — no Math.random, so failures reproduce exactly. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const HEAD = ["学籍番号", "氏名", "コース", "担当教員", "成績"];
const cells = (r: Row) => [r.sid, r.name, r.course, r.instructor, r.grade];
const csv = (rs: readonly Row[], head = true) =>
  (head ? [HEAD.join(",")] : []).concat(rs.map((r) => cells(r).join(","))).join("\n") + "\n";

/** Column order B: identifier columns moved, header retained. */
const HEAD_B = ["成績", "担当教員", "氏名", "コース", "学籍番号"];
const cellsB = (r: Row) => [r.grade, r.instructor, r.name, r.course, r.sid];
const csvReordered = (rs: readonly Row[]) =>
  [HEAD_B.join(",")].concat(rs.map((r) => cellsB(r).join(","))).join("\n") + "\n";

async function xlsxBuffer(rs: readonly Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("roster");
  ws.addRow(HEAD);
  for (const r of rs) ws.addRow(cells(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Map source sid -> delivered token, from a delimited output. */
function tokensFromCsv(output: string, sidColumn: number, order: readonly Row[]): Map<string, string> {
  const table = parseDelimitedTable(output);
  const body = table.rows.slice(table.rows.length === order.length ? 0 : 1);
  const map = new Map<string, string>();
  body.forEach((row, i) => map.set(order[i]!.sid, (row[sidColumn] ?? "").trim()));
  return map;
}

function joinRate(a: Map<string, string>, b: Map<string, string>): number {
  let joinable = 0;
  for (const [sid, token] of a) if (b.get(sid) === token) joinable += 1;
  return joinable / a.size;
}

describe("cross-format pseudonym join over 730 rows", () => {
  it("joins headed CSV, headerless TXT and XLSX at 100% in one run", async () => {
    // ONE registry for the whole run, shared by every format. Row order and column
    // order differ per file on purpose.
    const context = createStudentAliasContext();

    const headedOrder = rows;
    const headedOut = pseudonymizeStudentRecords(csv(headedOrder), context).output;

    const txtOrder = shuffled(rows, 7);
    const txtOut = pseudonymizeStudentRecords(csv(txtOrder, false), context).output;

    const reorderedOrder = shuffled(rows, 99);
    const reorderedOut = pseudonymizeStudentRecords(csvReordered(reorderedOrder), context).output;

    const xlsxOrder = shuffled(rows, 42);
    const xlsxResult = await pseudonymizeXlsxRecords(await xlsxBuffer(xlsxOrder), context);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxResult.output as never);
    const sheet = wb.worksheets[0]!;
    const xlsxTokens = new Map<string, string>();
    xlsxOrder.forEach((r, i) => {
      xlsxTokens.set(r.sid, String(sheet.getRow(i + 2).getCell(1).text).trim());
    });

    const headed = tokensFromCsv(headedOut, 0, headedOrder);
    const txt = tokensFromCsv(txtOut, 0, txtOrder);
    const reordered = tokensFromCsv(reorderedOut, 4, reorderedOrder);

    expect(headed.size).toBe(ROWS);
    expect(txt.size).toBe(ROWS);
    expect(xlsxTokens.size).toBe(ROWS);

    // The invariant: format, file, row order and column order must not matter.
    expect(joinRate(headed, txt)).toBe(1);
    expect(joinRate(headed, xlsxTokens)).toBe(1);
    expect(joinRate(txt, xlsxTokens)).toBe(1);
    expect(joinRate(headed, reordered)).toBe(1);

    // Three-way join.
    let threeWay = 0;
    for (const [sid, token] of headed) {
      if (txt.get(sid) === token && xlsxTokens.get(sid) === token) threeWay += 1;
    }
    expect(threeWay / ROWS).toBe(1);
  });

  it("has no token collisions and no false cross-column equalities", () => {
    const context = createStudentAliasContext();
    const out = pseudonymizeStudentRecords(csv(rows), context).output;
    const table = parseDelimitedTable(out);
    const body = table.rows.slice(1);

    // Distinct source ids -> distinct tokens (no collisions).
    const sidTokens = body.map((r) => r[0]!);
    expect(new Set(sidTokens).size).toBe(ROWS);
    const nameTokens = body.map((r) => r[1]!);
    expect(new Set(nameTokens).size).toBe(ROWS);

    // The id token and the name token of one row are never the same string.
    for (const row of body) expect(row[0]).not.toBe(row[1]);

    // Constant course/instructor columns stay constant and stay DISTINCT from
    // each other — the v0.3.6 corruption was three columns sharing one token.
    expect(new Set(body.map((r) => r[2])).size).toBe(1);
    expect(new Set(body.map((r) => r[3])).size).toBe(1);

    // Measures untouched.
    body.forEach((row, i) => expect(row[4]).toBe(rows[i]!.grade));
  });

  it("leaves no raw identifier in any delivered representation", async () => {
    const context = createStudentAliasContext();
    const outputs = [
      pseudonymizeStudentRecords(csv(rows), context).output,
      pseudonymizeStudentRecords(csv(shuffled(rows, 3), false), context).output,
      pseudonymizeStudentRecords(csvReordered(shuffled(rows, 5)), context).output,
    ];
    const xlsx = await pseudonymizeXlsxRecords(await xlsxBuffer(rows), context);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.output as never);
    const xlsxText: string[] = [];
    for (const ws of wb.worksheets) {
      ws.eachRow((row) => row.eachCell({ includeEmpty: false }, (c) => xlsxText.push(c.text)));
    }
    const all = outputs.join("\n") + "\n" + xlsxText.join("\n");

    let residue = 0;
    for (const r of rows) {
      if (all.includes(r.sid)) residue += 1;
      if (all.includes(r.name)) residue += 1;
    }
    expect(residue).toBe(0);
  });

  it("keeps leading-zero identifiers distinct rather than coercing them", () => {
    const context = createStudentAliasContext();
    const out = pseudonymizeStudentRecords(
      "学籍番号,氏名,成績\n" +
        "0000001,STUDENT_CANARY_A,80\n" +
        "0000010,STUDENT_CANARY_B,81\n" +
        "0000100,STUDENT_CANARY_C,82\n",
      context,
    ).output;
    const body = parseDelimitedTable(out).rows.slice(1);
    expect(new Set(body.map((r) => r[0])).size).toBe(3);
  });
});

describe("RunPseudonymRegistry", () => {
  it("returns the same pseudonym for the same normalized value", () => {
    const registry = createRunPseudonymRegistry();
    const a = registry.getOrCreate("student-id", "SID_CANARY_001");
    const b = registry.getOrCreate("student-id", "SID_CANARY_001");
    expect(a).toBe(b);
  });

  it("shares one token across types in the same bucket, so formats agree", () => {
    const registry = createRunPseudonymRegistry();
    // A headed file resolves the type; a headerless file can only infer account-id.
    const headed = registry.getOrCreate("student-id", "SID_CANARY_001");
    const headerless = registry.getOrCreate("account-id", "SID_CANARY_001");
    expect(identifierBucket("student-id")).toBe(identifierBucket("account-id"));
    expect(headerless).toBe(headed);
  });

  it("gives different values different tokens", () => {
    const registry = createRunPseudonymRegistry();
    expect(registry.getOrCreate("student-id", "SID_CANARY_001")).not.toBe(
      registry.getOrCreate("student-id", "SID_CANARY_002"),
    );
  });

  it("has no file-local state: one registry drives every file in the run", () => {
    const context = createStudentAliasContext();
    const one = pseudonymizeStudentRecords(csv(rows.slice(0, 5)), context).output;
    const two = pseudonymizeStudentRecords(csv(rows.slice(0, 5), false), context).output;
    const a = parseDelimitedTable(one).rows.slice(1).map((r) => r[0]);
    const b = parseDelimitedTable(two).rows.map((r) => r[0]);
    expect(a).toEqual(b);
  });
});
