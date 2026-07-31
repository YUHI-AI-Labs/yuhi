import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  inspectXlsxRecords,
  pseudonymizeXlsxRecords,
  xlsxContainsAnyValue,
} from "./xlsx-records.js";

async function fixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Synthetic Author";
  const sheet = workbook.addWorksheet("Grades");
  sheet.addRow(["フルネーム", "学生証番号", "点数", "評定"]);
  sheet.addRow(["Synthetic Student One", "100001", 90, "A"]);
  sheet.addRow(["Synthetic Student Two", "100002", 80, "B"]);
  sheet.getCell("E1").value = "合計";
  sheet.getCell("E2").value = { formula: "C2+10", result: 100 };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("XLSX student-record preparation", () => {
  it("detects and pseudonymizes identifiers while preserving structure and formulas", async () => {
    const source = await fixture();
    const inspection = await inspectXlsxRecords(source);
    expect(inspection).toMatchObject({
      sensitiveSheets: 1,
      directIdentifierColumns: 2,
      associatedDataPresent: true,
    });

    const transformed = await pseudonymizeXlsxRecords(source);
    expect(transformed.valuesReplaced).toBe(4);
    expect(await xlsxContainsAnyValue(
      transformed.output,
      new Set(["Synthetic Student One", "Synthetic Student Two", "100001", "100002"]),
    )).toBe(false);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(transformed.output as never);
    const sheet = workbook.getWorksheet("Grades")!;
    expect(sheet.getCell("A2").text).toBe("Student 001");
    expect(sheet.getCell("B2").text).toBe("CARD-001");
    expect(sheet.getCell("C2").value).toBe(90);
    expect(sheet.getCell("D2").value).toBe("A");
    expect(sheet.getCell("E2").value).toMatchObject({ formula: "C2+10", result: 100 });
    expect(workbook.creator).toBe("Yuhi");
  });
});
