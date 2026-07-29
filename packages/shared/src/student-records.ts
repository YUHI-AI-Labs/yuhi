export type StudentRecordSensitivity = "none" | "confidential" | "restricted";
export type DirectIdentifierType =
  | "name"
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
    ["student-card", ["studentcardnumber", "学生証番号"]],
    ["student-id", ["studentid", "studentnumber", "学籍番号", "idナンバ"]],
    ["employee-id", ["employeeid", "employeenumber", "社員番号", "従業員番号"]],
    ["account-id", ["accountid", "memberid", "会員番号"]],
    ["email", ["email", "emailaddress", "メール", "メールアドレス"]],
    ["phone", ["phone", "phonenumber", "電話", "電話番号"]],
    ["address", ["address", "住所"]],
    ["institutional-id", ["governmentid", "institutionalid"]],
  ];
  return groups.find(([, aliases]) =>
    aliases.some((candidate) => {
      const normalized = normalizedHeader(candidate);
      if (header === normalized) return true;
      // Accept descriptive suffixes on specific identifier headers, e.g.
      // 学生証番号6桁 or "student id (required)". Do not prefix-match generic
      // labels such as "name", "email", or "phone".
      return normalized.length >= 5 && header.startsWith(normalized);
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

export function classifyStudentRecordTable(rows: readonly (readonly string[])[]): StudentRecordClassification {
  const base = classifyStudentRecordHeaders(rows[0] ?? []);
  const indexes = [...base.directIdentifierIndexes];
  const types = [...base.directIdentifierTypes];
  const sampled = rows.slice(1, 51);
  for (let index = 0; index < (rows[0]?.length ?? 0); index += 1) {
    if (indexes.includes(index)) continue;
    const values = sampled.map((row) => (row[index] ?? "").trim()).filter(Boolean);
    if (values.length === 0) continue;
    const emailCount = values.filter((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)).length;
    const phoneCount = values.filter((value) => /^\+?[0-9][0-9 ()-]{7,}$/.test(value)).length;
    const inferred: DirectIdentifierType | undefined =
      emailCount / values.length >= 0.8
        ? "email"
        : phoneCount / values.length >= 0.8
          ? "phone"
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

export function parseDelimitedTable(input: string): ParsedDelimitedTable {
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
  if (rows.length < 2 || rows[0]!.length < 1) {
    throw new Error("Malformed delimited table: header and data rows are required.");
  }
  const width = rows[0]!.length;
  if (rows.some((candidate) => candidate.length !== width)) {
    throw new Error("Malformed delimited table: inconsistent column count.");
  }
  return { delimiter, rows };
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
}

export interface StudentAliasContext {
  identifierToEntity: Map<string, number | null>;
  entityIdentifiers: Map<number, Map<DirectIdentifierType, string>>;
  nextEntity: number;
}

export function createStudentAliasContext(): StudentAliasContext {
  return { identifierToEntity: new Map(), entityIdentifiers: new Map(), nextEntity: 1 };
}

function identifierKey(type: DirectIdentifierType, value: string): string {
  return `${type}:${value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function aliasFor(
  type: DirectIdentifierType,
  entity: number,
  role: "student" | "employee" | "person",
): string {
  const number = String(entity).padStart(3, "0");
  switch (type) {
    case "name": return `${role === "student" ? "Student" : role === "employee" ? "Employee" : "Person"} ${number}`;
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
  const table = parseDelimitedTable(input);
  const classification = classifyStudentRecordTable(table.rows);
  const values = new Set<string>();
  for (const row of table.rows.slice(1)) {
    for (const index of classification.directIdentifierIndexes) {
      const value = (row[index] ?? "").trim();
      if (value) values.add(value);
    }
  }
  return [...values];
}

export function pseudonymizeStudentRecords(
  input: string,
  context: StudentAliasContext = createStudentAliasContext(),
): StudentRecordTransform {
  const table = parseDelimitedTable(input);
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
  const entitiesBefore = context.nextEntity;
  let valuesReplaced = 0;
  const priority: Record<DirectIdentifierType, number> = {
    "student-card": 1,
    "student-id": 2,
    "employee-id": 3,
    email: 4,
    "institutional-id": 5,
    "account-id": 6,
    phone: 7,
    name: 99,
    address: 99,
  };
  for (const row of table.rows.slice(1)) {
    const identifiers = classification.directIdentifierIndexes.map((index, offset) => ({
      index,
      type: classification.directIdentifierTypes[offset]!,
      value: (row[index] ?? "").trim(),
    })).filter((item) => item.value);
    if (identifiers.length === 0) throw new Error("Student record row has no direct identifier.");
    const strong = identifiers
      .filter((item) => item.type !== "name" && item.type !== "address")
      .sort((a, b) => priority[a.type] - priority[b.type]);
    const linked = strong
      .map((item) => context.identifierToEntity.get(identifierKey(item.type, item.value)))
      .filter((entity): entity is number => typeof entity === "number");
    const linkedEntities = [...new Set(linked)];
    if (linkedEntities.length > 1) {
      throw new Error("Conflicting direct identifiers refer to different entities.");
    }
    let entity = linkedEntities[0];
    if (entity === undefined) {
      entity = context.nextEntity;
      context.nextEntity += 1;
    }
    if (strong.length > 0) {
      const known =
        context.entityIdentifiers.get(entity) ?? new Map<DirectIdentifierType, string>();
      for (const item of strong) {
        const key = identifierKey(item.type, item.value);
        const prior = known.get(item.type);
        if (prior !== undefined && prior !== key) {
          throw new Error("Safe tabular pseudonymization could not preserve entity uniqueness.");
        }
        known.set(item.type, key);
      }
      context.entityIdentifiers.set(entity, known);
    }
    for (const item of identifiers) {
      const key = identifierKey(item.type, item.value);
      // Names and addresses never establish cross-row identity. A duplicate
      // name may belong to different people; a row without a reliable key gets
      // a fresh row-scoped entity.
      if (item.type !== "name" && item.type !== "address") {
        const existing = context.identifierToEntity.get(key);
        if (existing === undefined) context.identifierToEntity.set(key, entity);
        else if (existing !== entity) {
          throw new Error("Conflicting direct identifier mapping detected.");
        }
      }
      row[item.index] = aliasFor(item.type, entity, role);
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
  for (let rowIndex = 1; rowIndex < table.rows.length; rowIndex += 1) {
    for (let column = 0; column < table.rows[0]!.length; column += 1) {
      if (!direct.has(column) && table.rows[rowIndex]![column] !== originalRows[rowIndex]![column]) {
        throw new Error("Tabular transformation changed a non-identifier value.");
      }
    }
  }
  return {
    output: serializeDelimitedTable(table),
    classification,
    aliasesCreated: context.nextEntity - entitiesBefore,
    valuesReplaced,
  };
}

export function aggregateStudentRecords(input: string): StudentRecordTransform {
  const table = parseDelimitedTable(input);
  const classification = classifyStudentRecordTable(table.rows);
  if (classification.sensitivity === "none") {
    throw new Error("No education-record columns detected.");
  }
  const outputRows: string[][] = [["metric", "records", "numeric_mean"]];
  for (const index of classification.performanceIndexes) {
    const values = table.rows.slice(1)
      .map((row) => Number(row[index]))
      .filter((value) => Number.isFinite(value));
    const mean = values.length > 0
      ? String(Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100)
      : "";
    outputRows.push([table.rows[0]![index]!, String(table.rows.length - 1), mean]);
  }
  return {
    output: serializeDelimitedTable({ delimiter: ",", rows: outputRows }),
    classification,
    aliasesCreated: 0,
    valuesReplaced: classification.directIdentifierColumns * (table.rows.length - 1),
  };
}
