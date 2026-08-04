import ExcelJS from "exceljs";
import {
  classifyStudentRecordTable,
  detectTableLayout,
  createStudentAliasContext,
  parseDelimitedTable,
  pseudonymizeStudentRecords,
  serializeDelimitedTable,
  type StudentAliasContext,
} from "./student-records.js";

export interface XlsxInspection {
  sheetsInspected: number;
  sensitiveSheets: number;
  directIdentifierColumns: number;
  associatedDataPresent: boolean;
}

export interface XlsxTransformResult extends XlsxInspection {
  output: Buffer;
  valuesReplaced: number;
  entitiesCreated: number;
  analyticalColumnsPreserved: number;
  rawIdentifiers: string[];
}

function rowsForSheet(sheet: ExcelJS.Worksheet): {
  headerRow: number;
  rows: string[][];
} | undefined {
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 20); rowNumber += 1) {
    const width = Math.max(sheet.columnCount, sheet.getRow(rowNumber).cellCount);
    if (width === 0) continue;
    const rows: string[][] = [];
    for (let current = rowNumber; current <= sheet.rowCount; current += 1) {
      const row: string[] = [];
      for (let column = 1; column <= width; column += 1) {
        row.push(sheet.getRow(current).getCell(column).text);
      }
      rows.push(row);
    }
    // Use the SAME classifier as the delimited path (#11): header-only
    // classification gave XLSX a different entity-type verdict from CSV/TXT for the
    // same table, and no header-independent inference at all.
    if (classifyStudentRecordTable(rows).directIdentifierColumns > 0) {
      return { headerRow: rowNumber, rows };
    }
  }
  return undefined;
}

/**
 * Extract EVERY cell's rendered text from a workbook, joined by a separator.
 * Used by the final-artifact security gate to scan the ACTUAL delivered bytes for
 * surviving identifiers — never trusting an in-memory transform result.
 */
export async function xlsxCellText(input: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input as never);
  const cells: string[] = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cell.text;
        if (text) cells.push(text);
      });
    });
  }
  return cells.join("");
}

export async function inspectXlsxRecords(input: Buffer): Promise<XlsxInspection> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input as never);
  let sensitiveSheets = 0;
  let directIdentifierColumns = 0;
  let associatedDataPresent = false;
  for (const sheet of workbook.worksheets) {
    const table = rowsForSheet(sheet);
    if (!table) continue;
    const classification = classifyStudentRecordTable(table.rows);
    sensitiveSheets += 1;
    directIdentifierColumns += classification.directIdentifierColumns;
    associatedDataPresent ||= classification.performanceColumns > 0;
  }
  return {
    sheetsInspected: workbook.worksheets.length,
    sensitiveSheets,
    directIdentifierColumns,
    associatedDataPresent,
  };
}

export async function pseudonymizeXlsxRecords(
  input: Buffer,
  context: StudentAliasContext = createStudentAliasContext(),
): Promise<XlsxTransformResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input as never);
  const entitiesBefore = context.nextEntity;
  const rawIdentifiers = new Set<string>();
  let sensitiveSheets = 0;
  let directIdentifierColumns = 0;
  let analyticalColumnsPreserved = 0;
  let associatedDataPresent = false;
  let valuesReplaced = 0;

  for (const sheet of workbook.worksheets) {
    const table = rowsForSheet(sheet);
    if (!table) continue;
    const classification = classifyStudentRecordTable(table.rows);
    sensitiveSheets += 1;
    directIdentifierColumns += classification.directIdentifierColumns;
    analyticalColumnsPreserved +=
      table.rows[0]!.length - classification.directIdentifierColumns;
    associatedDataPresent ||= classification.performanceColumns > 0;
    const layout = detectTableLayout(table.rows, ",");
    for (const row of table.rows.slice(layout.dataStartRow)) {
      for (const index of classification.directIdentifierIndexes) {
        const value = (row[index] ?? "").trim();
        if (value) rawIdentifiers.add(value);
      }
    }
    const serialized = serializeDelimitedTable({ delimiter: ",", rows: table.rows });
    const transformed = pseudonymizeStudentRecords(serialized, context);
    const outputRows = parseDelimitedTable(transformed.output).rows;
    for (let rowIndex = layout.dataStartRow; rowIndex < outputRows.length; rowIndex += 1) {
      for (const columnIndex of classification.directIdentifierIndexes) {
        sheet
          .getRow(table.headerRow + rowIndex)
          .getCell(columnIndex + 1).value = outputRows[rowIndex]![columnIndex] ?? "";
      }
    }
    valuesReplaced += transformed.valuesReplaced;
  }

  if (sensitiveSheets === 0) {
    throw new Error("Workbook contains no supported identifiable table.");
  }
  workbook.creator = "Yuhi";
  workbook.lastModifiedBy = "Yuhi";
  workbook.company = "";
  workbook.manager = "";
  workbook.title = "";
  workbook.subject = "";
  workbook.description = "";
  workbook.keywords = "";
  workbook.category = "";
  const output = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    output,
    sheetsInspected: workbook.worksheets.length,
    sensitiveSheets,
    directIdentifierColumns,
    associatedDataPresent,
    valuesReplaced,
    entitiesCreated: context.nextEntity - entitiesBefore,
    analyticalColumnsPreserved,
    rawIdentifiers: [...rawIdentifiers],
  };
}

export async function xlsxContainsAnyValue(
  input: Buffer,
  forbidden: ReadonlySet<string>,
): Promise<boolean> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(input as never);
  return workbook.worksheets.some((sheet) =>
    sheet.getSheetValues().some((row) =>
      Array.isArray(row) &&
      row.some((cell) => typeof cell === "string" && forbidden.has(cell.trim())),
    ),
  );
}
