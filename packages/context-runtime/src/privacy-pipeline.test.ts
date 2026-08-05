/**
 * Content routing + transform unit tests (v0.4.8 Phase 3A). Synthetic fixture data
 * only, matching the identifiers already used throughout 0.4.6/0.4.7's own test suite
 * (`packages/shared/src/student-records.test.ts`, `text-deidentify.test.ts`).
 */
import { createStudentAliasContext } from "@yuhi/shared";
import { describe, expect, it } from "vitest";

import { classifyDeliveryContent, transformDirectPersonalIdentifiers } from "./privacy-pipeline.js";

describe("classifyDeliveryContent", () => {
  it("routes by ContentKind first", () => {
    expect(classifyDeliveryContent("csv", "a,b\n1,2")).toBe("structured-table");
    expect(classifyDeliveryContent("tsv", "a\tb\n1\t2")).toBe("structured-table");
    expect(classifyDeliveryContent("json", "{}")).toBe("structured-json");
    expect(classifyDeliveryContent("markdown", "# hi")).toBe("prose");
    expect(classifyDeliveryContent("pdf-companion", "hi")).toBe("prose");
    expect(classifyDeliveryContent("log", "x")).toBe("command-output");
    expect(classifyDeliveryContent("test-output", "x")).toBe("command-output");
    expect(classifyDeliveryContent("shell-output", "x")).toBe("command-output");
    expect(classifyDeliveryContent("git-diff", "x")).toBe("command-output");
    expect(classifyDeliveryContent("html", "<p>x</p>")).toBe("source-code");
    expect(classifyDeliveryContent("xml", "<x/>")).toBe("source-code");
  });

  it("disambiguates 'text' by shape: dotenv-style -> configuration", () => {
    const dotenv = "API_URL=https://api.example.com\nMODEL_NAME=claude\nTIMEOUT_MS=30000\n";
    expect(classifyDeliveryContent("text", dotenv)).toBe("configuration");
  });

  it("disambiguates 'text' by shape: consistent-width delimited rows -> structured-table", () => {
    const csvish = "id,name,email\n1,a,a@example.com\n2,b,b@example.com\n3,c,c@example.com\n";
    expect(classifyDeliveryContent("text", csvish)).toBe("structured-table");
  });

  it("falls back to prose for ordinary text", () => {
    expect(classifyDeliveryContent("text", "学籍番号 L001\n氏名 山田太郎\n成績 A\n")).toBe("prose");
  });

  it("disambiguates 'source' by shape: dotenv-style -> configuration, else source-code", () => {
    const dotenv = "API_URL=https://api.example.com\nMODEL=claude\nTIMEOUT=30\n";
    expect(classifyDeliveryContent("source", dotenv)).toBe("configuration");
    expect(classifyDeliveryContent("source", "export function add(a, b) {\n  return a + b;\n}\n")).toBe(
      "source-code",
    );
  });
});

describe("transformDirectPersonalIdentifiers", () => {
  it("trusted-local preserves everything, in every content type, with zero detection", () => {
    const context = createStudentAliasContext();
    const prose = transformDirectPersonalIdentifiers(
      "氏名 山田太郎",
      "prose",
      context,
      "trusted-local",
    );
    expect(prose.text).toBe("氏名 山田太郎");
    expect(prose.detected).toBe(0);
    expect(prose.transformed).toBe(0);

    const table = transformDirectPersonalIdentifiers(
      "学籍番号,氏名\nL001,山田太郎\n",
      "structured-table",
      context,
      "trusted-local",
    );
    expect(table.text).toContain("山田太郎");
  });

  it("prose masks a CJK name with no linking key, using a fresh unlinked token", () => {
    const context = createStudentAliasContext();
    const result = transformDirectPersonalIdentifiers("氏名 山田太郎です。", "prose", context, "balanced");
    expect(result.text).not.toContain("山田太郎");
    expect(result.transformed).toBeGreaterThan(0);
  });

  it("source-code and command-output do NOT run the CJK name heuristic", () => {
    const context = createStudentAliasContext();
    // A comment mentioning a CJK word that is NOT a registered identifier and NOT
    // shape-detectable must survive: masking it would be exactly the over-masking the
    // content-type routing exists to prevent.
    const code = "// 対象データを検証する\nfunction validate(target) { return target != null; }\n";
    const result = transformDirectPersonalIdentifiers(code, "source-code", context, "balanced");
    expect(result.text).toBe(code);

    const output = transformDirectPersonalIdentifiers("実行結果: 成功しました", "command-output", context, "balanced");
    expect(output.text).toBe("実行結果: 成功しました");
  });

  it("source-code and configuration still mask shape-detectable identifiers (email)", () => {
    const context = createStudentAliasContext();
    const code = '// contact: taro.yamada@example.com\nconst ADMIN = "taro.yamada@example.com";\n';
    const result = transformDirectPersonalIdentifiers(code, "source-code", context, "balanced");
    expect(result.text).not.toContain("taro.yamada@example.com");
    expect(result.text).toContain("EMAIL-001");
    // Same value, same token, reused within the one call.
    expect(result.text.match(/EMAIL-001/g)?.length).toBe(2);
  });

  it("structured-table pseudonymizes a CSV using the tabular taxonomy", () => {
    const context = createStudentAliasContext();
    const csv = "学籍番号,氏名\nL001,山田太郎\n";
    const result = transformDirectPersonalIdentifiers(csv, "structured-table", context, "balanced");
    expect(result.text).toContain("L001");
    expect(result.text).not.toContain("山田太郎");
    expect(result.transformed).toBeGreaterThan(0);
  });

  it("structured-table with no direct-personal columns is left byte-identical (sentinel handled, not an error)", () => {
    const context = createStudentAliasContext();
    const csv = "学籍番号,得点\nL001,90\nL002,85\n";
    const result = transformDirectPersonalIdentifiers(csv, "structured-table", context, "balanced");
    expect(result.text).toBe(csv);
    expect(result.transformed).toBe(0);
  });

  it("a mis-detected 'table' that is not actually delimited falls through to prose, not raw passthrough", () => {
    const context = createStudentAliasContext();
    // Content type says table (caller's routing was wrong), but this is prose with a
    // name and no key — must still get masked, not delivered untransformed.
    const result = transformDirectPersonalIdentifiers("氏名 山田太郎です。", "structured-table", context, "balanced");
    expect(result.contentType).toBe("prose");
    expect(result.text).not.toContain("山田太郎");
  });

  it("structured-json masks shape-detectable string values without touching key names", () => {
    const context = createStudentAliasContext();
    const json = JSON.stringify({ id: 1, name: "user-500", email: "user-500@example.com" });
    const result = transformDirectPersonalIdentifiers(json, "structured-json", context, "balanced");
    const parsed = JSON.parse(result.text) as { id: number; name: string; email: string };
    // A bare "name" field is NOT masked by key alone -- see the module doc comment
    // (Phase 3 JSON precision decision): arbitrary tool-output JSON is not a student
    // record, and masking every "name" key would over-mask ordinary API/test data.
    expect(parsed.name).toBe("user-500");
    // An email VALUE is masked regardless of which key it lives under (shape-based).
    expect(parsed.email).not.toContain("@example.com");
    expect(result.transformed).toBeGreaterThan(0);
  });

  it("structured-json reuses a run-registered token when a strong key links the value in the SAME payload", () => {
    const context = createStudentAliasContext();
    // First, register 山田太郎 <-> L001 the same way a CSV delivery would.
    transformDirectPersonalIdentifiers("学籍番号,氏名\nL001,山田太郎\n", "structured-table", context, "balanced");
    const json = JSON.stringify({ studentId: "L001", note: "担当: 山田太郎" });
    const result = transformDirectPersonalIdentifiers(json, "structured-json", context, "balanced");
    const parsed = JSON.parse(result.text) as { note: string };
    expect(parsed.note).not.toContain("山田太郎");
    expect(parsed.note).toContain("PERSON-001");
  });

  it("invalid JSON falls through to prose rather than being delivered untransformed", () => {
    const context = createStudentAliasContext();
    const notJson = "{not valid json, 氏名 山田太郎";
    const result = transformDirectPersonalIdentifiers(notJson, "structured-json", context, "balanced");
    expect(result.contentType).toBe("prose");
    expect(result.text).not.toContain("山田太郎");
  });

  it("configuration masks a personal email but leaves ordinary assignments untouched", () => {
    const context = createStudentAliasContext();
    const config = "API_URL=https://api.example.com\nADMIN_EMAIL=taro.yamada@example.com\n";
    const result = transformDirectPersonalIdentifiers(config, "configuration", context, "balanced");
    expect(result.text).toContain("API_URL=https://api.example.com");
    expect(result.text).not.toContain("taro.yamada@example.com");
  });

  it("strict and balanced apply an identical transform", () => {
    const contextA = createStudentAliasContext();
    const contextB = createStudentAliasContext();
    const text = "氏名 山田太郎";
    const a = transformDirectPersonalIdentifiers(text, "prose", contextA, "balanced");
    const b = transformDirectPersonalIdentifiers(text, "prose", contextB, "strict");
    expect(a.text).toBe(b.text);
  });
});
