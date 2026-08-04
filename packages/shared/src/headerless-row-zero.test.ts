import { describe, it, expect } from "vitest";
import {
  cellShape,
  detectTableLayout,
  parseDelimitedTable,
  pseudonymizeStudentRecords,
  tabularResidueCells,
  tabularVerificationValues,
  createStudentAliasContext,
} from "./student-records.js";

/**
 * Row-0 privacy suite (#10).
 *
 * The defect these guard: the transform and the final verifier both derived the
 * body start from the same heuristic, so a headerless table's first record was
 * exempt from BOTH — a raw identifier could sit in the delivered bytes while the
 * run reported `identifierLeaks: 0`.
 */

const BOM = "﻿";
const HEAD = ["学籍番号", "氏名", "コース", "担当教員", "成績"];
const ROWS = [
  ["SID_CANARY_001", "STUDENT_CANARY_001", "COURSE_CANARY", "INSTRUCTOR_CANARY", "85"],
  ["SID_CANARY_002", "STUDENT_CANARY_002", "COURSE_CANARY", "INSTRUCTOR_CANARY", "92"],
  ["SID_CANARY_003", "STUDENT_CANARY_003", "COURSE_CANARY", "INSTRUCTOR_CANARY", "78"],
];
const join = (rows: string[][], d = ",", eol = "\n") =>
  rows.map((r) => r.join(d)).join(eol) + eol;

const ROW0_CANARIES = ["SID_CANARY_001", "STUDENT_CANARY_001"];

describe("cellShape", () => {
  it("separates datetimes and times from codes and free text", () => {
    expect(cellShape("2026-07-15 11:13:14")).toBe("datetime");
    expect(cellShape("2026-07-15")).toBe("datetime");
    expect(cellShape("11:13:14")).toBe("time");
    expect(cellShape("123456")).toBe("numeric");
    expect(cellShape("SID_CANARY_001")).toBe("code");
    expect(cellShape("a@b.co")).toBe("email");
    expect(cellShape("090-1234-5678")).toBe("phone");
    expect(cellShape("学籍番号")).toBe("text");
    expect(cellShape("   ")).toBe("empty");
  });
});

describe("detectTableLayout", () => {
  it("treats a recognized label row as a header", () => {
    const layout = detectTableLayout([HEAD, ...ROWS]);
    expect(layout).toMatchObject({ hasHeader: true, headerRow: 0, dataStartRow: 1 });
  });

  it("treats an unlabelled first record as data, with no email or phone present", () => {
    const layout = detectTableLayout(ROWS);
    expect(layout).toMatchObject({ hasHeader: false, dataStartRow: 0 });
  });

  it("treats a single multi-column row as data rather than a header", () => {
    const layout = detectTableLayout([ROWS[0]!]);
    expect(layout).toMatchObject({ hasHeader: false, dataStartRow: 0 });
  });

  it("treats a two-row headerless table as all data", () => {
    expect(detectTableLayout(ROWS.slice(0, 2)).dataStartRow).toBe(0);
  });
});

describe("headerless row 0 is pseudonymized across the format/encoding matrix", () => {
  const variants: [string, string][] = [
    ["headerless CSV", join(ROWS)],
    ["headerless TXT", join(ROWS)],
    ["headerless TSV", join(ROWS, "\t")],
    ["BOM + LF", BOM + join(ROWS, ",", "\n")],
    ["no BOM + LF", join(ROWS, ",", "\n")],
    ["BOM + CRLF", BOM + join(ROWS, ",", "\r\n")],
    ["no BOM + CRLF", join(ROWS, ",", "\r\n")],
    ["single row", join([ROWS[0]!])],
    ["two rows", join(ROWS.slice(0, 2))],
    ["email in row 0", join(ROWS.map((r, i) => [...r, `s${i}@canary.invalid`]))],
    ["phone in row 0", join(ROWS.map((r, i) => [...r, `090-1234-567${i}`]))],
    ["student id in row 0 only", join(ROWS)],
  ];

  for (const [label, input] of variants) {
    it(`${label}: no row-0 canary survives the transform`, () => {
      const out = pseudonymizeStudentRecords(input).output;
      for (const canary of ROW0_CANARIES) expect(out).not.toContain(canary);
    });
  }

  it("an identifier at a chunk boundary is still transformed", () => {
    const pad = Array.from({ length: 1200 }, (_, i) => [
      `SID_CANARY_P${String(i).padStart(4, "0")}`,
      `STUDENT_CANARY_P${String(i).padStart(4, "0")}`,
      "COURSE_CANARY",
      "INSTRUCTOR_CANARY",
      String(60 + (i % 40)),
    ]);
    const input = join([...ROWS, ...pad]);
    expect(input.length).toBeGreaterThan(64 * 1024);
    const out = pseudonymizeStudentRecords(input).output;
    for (const canary of ROW0_CANARIES) expect(out).not.toContain(canary);
    expect(out).not.toContain("SID_CANARY_P1199");
  });

  it("a headered table keeps its label row verbatim", () => {
    const out = pseudonymizeStudentRecords(join([HEAD, ...ROWS])).output;
    for (const label of HEAD) expect(out).toContain(label);
    for (const canary of ROW0_CANARIES) expect(out).not.toContain(canary);
  });
});

describe("verification does not share the transform's header/body guess", () => {
  it("collects row-0 values as verification candidates for a headerless table", () => {
    const values = tabularVerificationValues(join(ROWS));
    for (const canary of ROW0_CANARIES) expect(values).toContain(canary);
  });

  it("still collects row-0 values when the table LOOKS headered", () => {
    // Even for a headered table the verifier must not exempt row 0; it excludes
    // recognized LABELS by content, not the first row by position.
    const values = tabularVerificationValues(join([HEAD, ...ROWS]));
    expect(values).toContain("SID_CANARY_001");
    for (const label of HEAD) expect(values).not.toContain(label);
  });

  it("structured rescan catches a row-0 residue that a body-only scan would miss", () => {
    const source = join(ROWS);
    // Simulate the historical defect: rows 2..N transformed, row 0 left raw.
    const leaked = join([
      ROWS[0]!,
      ["SID-002", "Student 002", "COURSE_CANARY", "INSTRUCTOR_CANARY", "92"],
      ["SID-003", "Student 003", "COURSE_CANARY", "INSTRUCTOR_CANARY", "78"],
    ]);
    const { residueCells, residueValues } = tabularResidueCells(source, leaked);
    expect(residueCells).toBeGreaterThan(0);
    expect(residueValues).toContain("SID_CANARY_001");
    expect(residueValues).toContain("STUDENT_CANARY_001");
  });

  it("byte scan catches the same row-0 residue", () => {
    const leaked = join([ROWS[0]!, ["SID-002", "Student 002", "C", "I", "92"]]);
    const candidates = tabularVerificationValues(join(ROWS));
    const surviving = candidates.filter((v) => leaked.includes(v));
    expect(surviving).toContain("SID_CANARY_001");
  });

  it("reports no residue for a fully transformed table", () => {
    const source = join(ROWS);
    const out = pseudonymizeStudentRecords(source).output;
    expect(tabularResidueCells(source, out).residueCells).toBe(0);
    const candidates = tabularVerificationValues(source);
    expect(candidates.filter((v) => out.includes(v))).toEqual([]);
  });

  it("a recognized label row is never mistaken for a residue", () => {
    const source = join([HEAD, ...ROWS]);
    const out = pseudonymizeStudentRecords(source).output;
    // Labels survive by design and must not be counted.
    expect(tabularResidueCells(source, out).residueCells).toBe(0);
  });
});

describe("single-row tables are tables", () => {
  it("parses a lone multi-column row instead of rejecting it", () => {
    const table = parseDelimitedTable(join([ROWS[0]!]));
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toHaveLength(5);
  });

  it("still rejects a lone single-cell line as non-tabular", () => {
    expect(() => parseDelimitedTable("just one line of prose\n")).toThrow(
      /at least one multi-column row/,
    );
  });

  it("pseudonymizes a single-record export completely", () => {
    const out = pseudonymizeStudentRecords(join([ROWS[0]!])).output;
    for (const canary of ROW0_CANARIES) expect(out).not.toContain(canary);
  });
});

describe("MUTATION GUARD: verification must not consult the body start", () => {
  /**
   * The historical bug in one line: candidate collection skipped row 0. If a future
   * change reintroduces that (by slicing from `tableBodyStart`, or by any other
   * route that exempts the first row), this test fails.
   */
  it("a body-only candidate scan misses the row-0 canary that the real verifier catches", () => {
    const source = join(ROWS);
    const leaked = join([
      ROWS[0]!,
      ["SID-002", "Student 002", "COURSE_CANARY", "INSTRUCTOR_CANARY", "92"],
      ["SID-003", "Student 003", "COURSE_CANARY", "INSTRUCTOR_CANARY", "78"],
    ]);

    // The mutant: collect identifier-column candidates from the BODY only, which is
    // exactly what `tabularDirectIdentifierValues` did before the fix.
    const rows = parseDelimitedTable(source).rows;
    const identifierColumns = [0, 1];
    const bodyOnlyCandidates = new Set<string>();
    for (const row of rows.slice(1)) {
      for (const column of identifierColumns) {
        const value = (row[column] ?? "").trim();
        if (value) bodyOnlyCandidates.add(value);
      }
    }
    const mutantSurviving = [...bodyOnlyCandidates].filter((v) => leaked.includes(v));

    // The real verifier.
    const realSurviving = tabularVerificationValues(source).filter((v) => leaked.includes(v));

    // The mutant reports clean on a file that is demonstrably leaking row 0.
    expect(mutantSurviving).toEqual([]);
    for (const canary of ROW0_CANARIES) expect(realSurviving).toContain(canary);
  });

  it("known residue can never coexist with a clean verdict", () => {
    const source = join(ROWS);
    const leaked = join([ROWS[0]!, ["SID-002", "Student 002", "C", "I", "92"]]);
    const structured = tabularResidueCells(source, leaked).residueCells;
    const byteScan = tabularVerificationValues(source).filter((v) => leaked.includes(v)).length;
    // At least one layer must fire; a clean verdict requires BOTH to be zero.
    expect(structured + byteScan).toBeGreaterThan(0);
  });
});

describe("detector precision: temporal values are never phone numbers", () => {
  it("does not tokenize a bare ISO date column as a phone number", () => {
    // `2026-07-15` is digits + hyphens and matches the phone pattern; without the
    // temporal guard an entire date column becomes PHONE-nnn.
    const input = join([
      ["受付日", "登録日時", "担当教員", "成績"],
      ["2026-07-15", "2026-07-15 11:13:14", "INSTRUCTOR_CANARY", "85"],
      ["2026-07-16", "2026-07-16 09:05:00", "INSTRUCTOR_CANARY", "92"],
      ["2026-07-17", "2026-07-17 14:22:31", "INSTRUCTOR_CANARY", "78"],
    ]);
    let out: string;
    try {
      out = pseudonymizeStudentRecords(input).output;
    } catch {
      // No direct-identifier column at all is an acceptable outcome here.
      out = input;
    }
    expect(out).not.toContain("PHONE-");
    expect(out).toContain("2026-07-15");
    expect(out).toContain("2026-07-15 11:13:14");
    // Measures survive untouched.
    for (const grade of ["85", "92", "78"]) expect(out).toContain(grade);
  });

  it("still classifies a real phone column as phone", () => {
    const input = join([
      ["氏名", "電話番号", "成績"],
      ["STUDENT_CANARY_001", "090-1234-5678", "85"],
      ["STUDENT_CANARY_002", "090-2345-6789", "92"],
    ]);
    const out = pseudonymizeStudentRecords(input).output;
    expect(out).toContain("PHONE-");
    expect(out).not.toContain("090-1234-5678");
  });

  it("keeps a six-digit student ID out of the phone namespace", () => {
    const input = join([
      ["学籍番号", "成績"],
      ["123456", "85"],
      ["123457", "92"],
      ["123458", "78"],
    ]);
    const out = pseudonymizeStudentRecords(input).output;
    expect(out).toContain("SID-");
    expect(out).not.toContain("PHONE-");
  });
});

describe("cross-file alias context still links entities", () => {
  it("shares pseudonyms across two headerless files in one run", () => {
    const ctx = createStudentAliasContext();
    const a = pseudonymizeStudentRecords(join(ROWS), ctx).output;
    const b = pseudonymizeStudentRecords(join(ROWS.slice(0, 2)), ctx).output;
    const tokenA = a.split("\n")[0]!.split(",")[0]!;
    const tokenB = b.split("\n")[0]!.split(",")[0]!;
    expect(tokenA).toBe(tokenB);
  });
});

describe("shape matching is linear and bounded (CodeQL js/polynomial-redos)", () => {
  it("matches ordinary emails and rejects near-misses", () => {
    expect(cellShape("a@b.co")).toBe("email");
    expect(cellShape("first.last@sub.example.co.jp")).toBe("email");
    // A trailing dot is not an email; the old pattern also rejected it, but only
    // after quadratic backtracking.
    expect(cellShape("a@b.")).not.toBe("email");
    expect(cellShape("a@b")).not.toBe("email");
    expect(cellShape("@b.co")).not.toBe("email");
  });

  it("returns quickly on the adversarial input CodeQL identified", () => {
    // `a@a.` + many `a.` repetitions was the quadratic case.
    const attack = "a@a." + "a.".repeat(40_000);
    const started = process.hrtime.bigint();
    expect(cellShape(attack)).toBe("text");
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(250);
  });

  it("treats an oversized cell as free text without pattern matching it", () => {
    expect(cellShape("x".repeat(5000))).toBe("text");
  });
});
