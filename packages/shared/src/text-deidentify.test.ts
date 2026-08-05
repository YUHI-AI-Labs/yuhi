import { describe, expect, it } from "vitest";

import {
  deidentifyText,
  scanTextForDirectPersonalIdentifiers,
} from "./text-deidentify.js";
import {
  createStudentAliasContext,
  pseudonymizeStudentRecords,
} from "./student-records.js";

describe("deidentifyText", () => {
  it("masks structured direct identifiers by shape", () => {
    const result = deidentifyText(
      "Email me at taro@example.com or call 090-1234-5678.",
    );
    expect(result.text).not.toContain("taro@example.com");
    expect(result.text).not.toContain("090-1234-5678");
    expect(result.text).toMatch(/EMAIL-\d{3}/);
    expect(result.text).toMatch(/PHONE-\d{3}/);
    expect(result.replaced.email).toBe(1);
    expect(result.replaced.phone).toBe(1);
  });

  it("masks a CJK name-shaped candidate even with no linking key present (never leaves it raw)", () => {
    const result = deidentifyText("Visitor: 鈴木花子");
    expect(result.text).not.toContain("鈴木花子");
    expect(result.text).toMatch(/PERSON-\d{3}/);
    expect(result.unlinkedNameCount).toBe(1);
  });

  it("preserves an operational label word (氏名) while masking the value beside it", () => {
    const result = deidentifyText("氏名：山田太郎");
    expect(result.text).toContain("氏名");
    expect(result.text).not.toContain("山田太郎");
  });

  it("reuses the SAME token as this run's table when a strong key is present in the SAME text", () => {
    const context = createStudentAliasContext();
    pseudonymizeStudentRecords("学籍番号,氏名\nSID_CANARY_001,山田太郎\n", context);

    const result = deidentifyText(
      "学籍番号：SID_CANARY_001 氏名：山田太郎",
      context,
    );
    expect(result.text).toContain("PERSON-001");
    expect(result.text).not.toContain("山田太郎");
    expect(result.unlinkedNameCount).toBe(0);
  });

  it("does NOT reuse the table's token when no linking key is present — mints an unlinked one instead", () => {
    const context = createStudentAliasContext();
    pseudonymizeStudentRecords("学籍番号,氏名\nSID_CANARY_001,山田太郎\n", context);

    // Same name, but the student id is absent from this text.
    const result = deidentifyText("氏名：山田太郎", context);
    expect(result.text).not.toContain("山田太郎");
    expect(result.text).not.toContain("PERSON-001");
    expect(result.unlinkedNameCount).toBe(1);
  });

  it("does not merge two different people who share a name", () => {
    const context = createStudentAliasContext();
    pseudonymizeStudentRecords("学籍番号,氏名\nSID_CANARY_001,山田太郎\n", context);

    // A second document, same run, same name, no key -> a DIFFERENT person's mention
    // must not collapse onto the first person's token.
    const a = deidentifyText("氏名：山田太郎（総務部）", context);
    const b = deidentifyText("氏名：山田太郎（営業部）", context);
    const tokenA = a.text.match(/PERSON-\d{3}/)?.[0];
    const tokenB = b.text.match(/PERSON-\d{3}/)?.[0];
    expect(tokenA).toBeDefined();
    expect(tokenB).toBeDefined();
    expect(tokenA).not.toBe("PERSON-001");
    expect(tokenB).not.toBe("PERSON-001");
  });

  it("reuses the same unlinked token for a repeated mention within one call", () => {
    const result = deidentifyText("鈴木花子 signed in. Later, 鈴木花子 signed out.");
    const tokens = [...result.text.matchAll(/PERSON-\d{3}/g)].map((m) => m[0]);
    expect(tokens.length).toBe(2);
    expect(tokens[0]).toBe(tokens[1]);
  });

  it("never merges an unlinked mention onto the table's entity, even matching by value alone", () => {
    // Regression guard for the identity linkage policy: `directPersonalValueTokens`
    // must not be consulted for a value with no reachable entity.
    const context = createStudentAliasContext();
    pseudonymizeStudentRecords("学籍番号,氏名\nSID_CANARY_001,山田太郎\n", context);
    const result = deidentifyText("山田太郎", context);
    expect(result.text).not.toBe("PERSON-001");
  });

  it("transforms nothing under trusted-local mode", () => {
    const result = deidentifyText(
      "Email taro@example.com, 氏名：山田太郎",
      createStudentAliasContext(),
      "trusted-local",
    );
    expect(result.text).toBe("Email taro@example.com, 氏名：山田太郎");
    expect(result.replacedTotal).toBe(0);
    expect(result.unlinkedNameCount).toBe(0);
  });

  it("works with the default (empty) context — safe even with no registry", () => {
    const result = deidentifyText("Contact taro@example.com. 氏名：山田太郎");
    expect(result.text).not.toContain("taro@example.com");
    expect(result.text).not.toContain("山田太郎");
  });
});

describe("scanTextForDirectPersonalIdentifiers", () => {
  it("flags a raw email/phone as residual", () => {
    const result = scanTextForDirectPersonalIdentifiers(
      "Contact taro@example.com or 090-1234-5678",
    );
    expect(result.residual).toBeGreaterThan(0);
    expect(result.kinds).toContain("email");
    expect(result.kinds).toContain("phone");
  });

  it("finds nothing residual in already-masked, correctly de-identified text", () => {
    const result = deidentifyText("Contact taro@example.com. 氏名：山田太郎");
    const verification = scanTextForDirectPersonalIdentifiers(result.text);
    expect(verification.residual).toBe(0);
    expect(verification.residualRisk).toBe(false);
  });

  it("flags a known registry value that survived unmasked as residual", () => {
    const result = scanTextForDirectPersonalIdentifiers(
      "leaked value: taro@example.com",
      ["taro@example.com"],
    );
    expect(result.residual).toBeGreaterThan(0);
    expect(result.kinds).toContain("known-value");
  });

  it("does not flag a preserved operational label as residual", () => {
    const result = scanTextForDirectPersonalIdentifiers("氏名：PERSON-001");
    expect(result.residual).toBe(0);
    expect(result.residualRisk).toBe(false);
  });
});
