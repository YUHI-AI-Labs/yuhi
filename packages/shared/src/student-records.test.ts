import { describe, expect, it } from "vitest";
import {
  aggregateStudentRecords,
  classifyStudentRecordHeaders,
  classifyStudentRecordTable,
  createStudentAliasContext,
  parseDelimitedTable,
  pseudonymizeStudentRecords,
  tabularDirectIdentifierValues,
} from "./student-records.js";

const JA =
  "\uFEFFフルネーム,IDナンバ,学生証番号,小テスト,コース合計,評定\n" +
  "Synthetic A,100001,200001,8,88,A\n" +
  "Synthetic B,100002,200002,7,77,B\n";

describe("student record tables", () => {
  it("classifies identifiers plus education performance as Restricted", () => {
    const parsed = parseDelimitedTable(JA);
    const result = classifyStudentRecordHeaders(parsed.rows[0]!);
    expect(result.sensitivity).toBe("restricted");
    expect(result.directIdentifierColumns).toBe(3);
    expect(result.associatedCategories).toEqual(["education-performance"]);
  });

  it("classifies names without associated data as Confidential", () => {
    expect(classifyStudentRecordHeaders(["full name", "team"]).sensitivity).toBe("confidential");
  });

  it("classifies grades without identifiers as Confidential", () => {
    expect(classifyStudentRecordHeaders(["grade", "quiz"]).sensitivity).toBe("confidential");
  });

  it("recognizes English records, duplicate headers, salary, email, and phone", () => {
    const result = classifyStudentRecordHeaders([
      "full name", "student id", "email", "phone number", "score", "score", "salary",
    ]);
    expect(result.sensitivity).toBe("restricted");
    expect(result.directIdentifierColumns).toBe(4);
    expect(result.performanceColumns).toBe(3);
    expect(result.associatedCategories).toEqual(["education-performance", "salary"]);
  });

  it("uses sampled values to identify unlabeled email and phone columns", () => {
    const result = classifyStudentRecordTable([
      ["contact one", "contact two", "grade"],
      ["a@example.test", "+1 202 555 0101", "A"],
      ["b@example.test", "+1 202 555 0102", "B"],
    ]);
    expect(result.sensitivity).toBe("restricted");
    expect(result.directIdentifierTypes).toEqual(["email", "phone"]);
  });

  it("supports TSV, quoted commas, and multiline cells", () => {
    const parsed = parseDelimitedTable(
      'full name\tstudent id\tgrade\n"Doe, Synthetic"\t"S-1"\t"A\nplus note"\n',
    );
    expect(parsed.delimiter).toBe("\t");
    expect(parsed.rows[1]?.[0]).toBe("Doe, Synthetic");
    expect(parsed.rows[1]?.[2]).toContain("\n");
  });

  it("fails closed for malformed tables", () => {
    expect(() => parseDelimitedTable('full name,student id,grade\n"unterminated,S-1,A'))
      .toThrow(/Malformed delimited table/);
  });

  it("uses stable sequential aliases within a run and preserves grades", () => {
    const result = pseudonymizeStudentRecords(JA);
    expect(result.output).toContain("Student 001,SID-001,CARD-001,8,88,A");
    expect(result.output).toContain("Student 002,SID-002,CARD-002,7,77,B");
    for (const value of tabularDirectIdentifierValues(JA)) {
      expect(result.output).not.toContain(value);
    }
  });

  it("recognizes descriptive suffixes on specific identifier headers", () => {
    const result = classifyStudentRecordHeaders(["学生証番号6桁", "評点"]);
    expect(result.directIdentifierColumns).toBe(1);
    expect(result.directIdentifierTypes).toEqual(["student-card"]);
    expect(result.sensitivity).toBe("restricted");
  });

  it("uses type-appropriate aliases and nulls phone values", () => {
    const result = pseudonymizeStudentRecords(
      "full name,student id,student card number,email,phone number,grade\n" +
      "Synthetic A,S-1,C-1,a@example.test,+1-555-0000,A\n",
    );
    expect(result.output).toContain(
      "Student 001,SID-001,CARD-001,student001@example.invalid,,A",
    );
  });

  it("links repeated IDs across files while keeping different IDs distinct", () => {
    const context = createStudentAliasContext();
    const first = pseudonymizeStudentRecords(
      "full name,student id,score\nSynthetic Name,S-1,80\nSame Name,S-2,70\n",
      context,
    );
    const second = pseudonymizeStudentRecords(
      "full name,student id,grade\n  SYNTHETIC   NAME  ,S-1,A\nSame Name,S-3,B\n",
      context,
    );
    expect(first.output).toContain("Student 001,SID-001,80");
    expect(first.output).toContain("Student 002,SID-002,70");
    expect(second.output).toContain("Student 001,SID-001,A");
    expect(second.output).toContain("Student 003,SID-003,B");
  });

  it("aggregates performance fields without retaining individual rows", () => {
    const result = aggregateStudentRecords(JA);
    expect(result.output).toContain("小テスト,2,7.5");
    expect(result.output).toContain("コース合計,2,82.5");
    expect(result.output).not.toContain("Synthetic A");
    expect(result.output).not.toContain("100001");
  });

  it("handles a large synthetic CSV deterministically", () => {
    const rows = Array.from(
      { length: 5_000 },
      (_, index) => `Synthetic ${index},S-${index},${index % 101}`,
    );
    const input = `full name,student id,score\n${rows.join("\n")}\n`;
    const result = pseudonymizeStudentRecords(input);
    expect(result.aliasesCreated).toBe(5_000);
    expect(result.output).toContain("Student 5000");
    expect(result.output).not.toContain("Synthetic 4999");
  });

  it("preserves one unique pseudonymous entity per distinct Japanese student ID", () => {
    const rows = Array.from(
      { length: 20 },
      (_, index) =>
        `合成氏名 ${index + 1},${2_000_000 + index},${300_000 + index},${70 + index},${index % 2 ? "A" : "B"}`,
    );
    const input =
      `\uFEFFフルネーム,IDナンバ,学生証番号,コース合計 (実データ),評定\n${rows.join("\n")}\n`;
    const transformed = pseudonymizeStudentRecords(input);
    const output = parseDelimitedTable(transformed.output);
    expect(new Set(output.rows.slice(1).map((row) => row[0])).size).toBe(20);
    expect(new Set(output.rows.slice(1).map((row) => row[1])).size).toBe(20);
    expect(new Set(output.rows.slice(1).map((row) => row[2])).size).toBe(20);
    expect(output.rows.slice(1).map((row) => row[3])).toEqual(
      Array.from({ length: 20 }, (_, index) => String(70 + index)),
    );
  });

  it("preserves 100 unique IDs even when every score and grade is equal", () => {
    const rows = Array.from(
      { length: 100 },
      (_, index) => `Duplicate Name,S-${index + 1},C-${index + 1},100,A,15,99.5`,
    );
    const result = parseDelimitedTable(pseudonymizeStudentRecords(
      `full name,student id,student card number,quiz,grade,assignment count,percentage\n${rows.join("\n")}\n`,
    ).output);
    expect(new Set(result.rows.slice(1).map((row) => row[0])).size).toBe(100);
    expect(new Set(result.rows.slice(1).map((row) => row[1])).size).toBe(100);
    expect(result.rows.slice(1).every((row) =>
      row[3] === "100" && row[4] === "A" && row[5] === "15" && row[6] === "99.5"
    )).toBe(true);
  });

  it("does not merge missing-ID rows or duplicate names", () => {
    const result = parseDelimitedTable(pseudonymizeStudentRecords(
      "full name,student id,grade\nSame Name,,A\nSame Name,,B\nSame Name,S-3,C\n",
    ).output);
    expect(result.rows[1]?.[0]).toBe("Student 001");
    expect(result.rows[2]?.[0]).toBe("Student 002");
    expect(result.rows[3]?.[0]).toBe("Student 003");
  });

  it("links a repeated stable ID and rejects conflicting strong identifiers", () => {
    const repeated = parseDelimitedTable(pseudonymizeStudentRecords(
      "full name,student id,student card number,score\nName One,S-1,C-1,80\nVariant Name,S-1,C-1,90\n",
    ).output);
    expect(repeated.rows[1]?.slice(0, 3)).toEqual(repeated.rows[2]?.slice(0, 3));
    expect(() => pseudonymizeStudentRecords(
      "full name,student id,student card number,score\nOne,S-1,C-1,80\nTwo,S-2,C-1,90\n",
    )).toThrow(/Conflicting direct identifiers|preserve entity uniqueness/);
  });
});
