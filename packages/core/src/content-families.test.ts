import { describe, it, expect } from "vitest";
import {
  buildContentFamilies,
  duplicateAliasText,
  normalizedTableHash,
  type FamilyCandidate,
} from "./content-families.js";

/**
 * Duplicate-content family suite (#15/P1-B).
 *
 * Measured defect: 5 delivered files, 1 distinct content, 195 bytes each — 780
 * duplicate bytes, 42% of delivered text — with no dedup, no canonical
 * representation and nothing in the manifest recording that they were copies.
 */

const BOM = "﻿";
const ROWS = [
  ["SID_CANARY_001", "STUDENT_CANARY_001", "85"],
  ["SID_CANARY_002", "STUDENT_CANARY_002", "92"],
  ["SID_CANARY_003", "STUDENT_CANARY_003", "78"],
];
const join = (rows: string[][], d = ",", eol = "\n") =>
  rows.map((r) => r.join(d)).join(eol) + eol;

const candidate = (relpath: string, text: string): FamilyCandidate => ({
  relpath,
  text,
  bytes: Buffer.byteLength(text),
});

describe("normalizedTableHash", () => {
  it("matches the same table across BOM, line endings and cell padding", () => {
    const a = normalizedTableHash(join(ROWS, ",", "\n"));
    const b = normalizedTableHash(BOM + join(ROWS, ",", "\r\n"));
    const c = normalizedTableHash(join(ROWS.map((r) => r.map((v) => ` ${v} `)), ",", "\n"));
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("matches the same table across delimiters (CSV vs TSV)", () => {
    expect(normalizedTableHash(join(ROWS, "\t"))).toBe(normalizedTableHash(join(ROWS, ",")));
  });

  it("ignores row order — a differently sorted re-export is the same table", () => {
    const reversed = [...ROWS].reverse();
    expect(normalizedTableHash(join(reversed))).toBe(normalizedTableHash(join(ROWS)));
  });

  it("does NOT match a table with different data", () => {
    const changed = ROWS.map((r, i) => (i === 0 ? [r[0]!, r[1]!, "99"] : r));
    expect(normalizedTableHash(join(changed))).not.toBe(normalizedTableHash(join(ROWS)));
  });

  it("returns undefined for content that is not a table", () => {
    expect(normalizedTableHash("just some prose\n")).toBeUndefined();
  });
});

describe("buildContentFamilies", () => {
  it("groups the measured 5-file / 1-content case and reports the duplicate bytes", () => {
    // Exactly the reproduction: BOM and CRLF are normalized away by the transform,
    // so all five delivered artifacts are byte-identical.
    const text = join(ROWS);
    const candidates = [
      candidate("a_roster_headerless.txt", text),
      candidate("b1_bom_lf_multi.txt", text),
      candidate("b2_nobom_lf_multi.txt", text),
      candidate("b3_bom_crlf_multi.txt", text),
      candidate("b4_nobom_crlf_multi.txt", text),
    ];
    const metrics = buildContentFamilies(candidates, 1999);

    expect(metrics.families).toHaveLength(1);
    const family = metrics.families[0]!;
    expect(family.kind).toBe("exact");
    expect(family.members).toHaveLength(5);
    expect(family.members.filter((m) => m.canonical)).toHaveLength(1);

    const each = Buffer.byteLength(text);
    expect(metrics.duplicateBytes).toBe(each * 4);
    expect(metrics.canonicalDeliveredBytes).toBe(each);
    // Separated metrics, as required.
    expect(metrics.sourceBytes).toBe(1999);
    expect(metrics.uniqueContentBytes).toBe(each);
    expect(metrics.duplicateAliasBytes).toBe(each * 4);
  });

  it("groups the same table delivered as CSV, TXT and TSV under one normalized family", () => {
    const candidates = [
      candidate("roster.csv", join([["学籍番号", "氏名", "成績"], ...ROWS])),
      candidate("roster.txt", join([["学籍番号", "氏名", "成績"], ...ROWS], ",", "\r\n")),
      candidate("roster.tsv", join([["学籍番号", "氏名", "成績"], ...ROWS], "\t")),
    ];
    const metrics = buildContentFamilies(candidates, 900);
    expect(metrics.families).toHaveLength(1);
    expect(metrics.families[0]!.kind).toBe("normalized");
    expect(metrics.families[0]!.members).toHaveLength(3);
    expect(metrics.duplicateBytes).toBeGreaterThan(0);
  });

  it("picks one deterministic canonical member — the largest, then by path", () => {
    // SAME logical table, different byte sizes: one compact, one with a BOM, CRLF
    // and padded cells. Both belong to one normalized family.
    const table = [["学籍番号", "氏名"], ["SID_CANARY_001", "STUDENT_CANARY_001"]];
    const small = candidate("small.csv", join(table));
    const big = candidate(
      "big.csv",
      BOM + join(table.map((r) => r.map((v) => `  ${v}  `)), ",", "\r\n"),
    );
    expect(big.bytes).toBeGreaterThan(small.bytes);

    const first = buildContentFamilies([small, big], 0).families[0];
    const second = buildContentFamilies([big, small], 0).families[0];
    expect(first?.members).toHaveLength(2);
    expect(first?.members[0]?.canonical).toBe(true);
    expect(first?.members[0]?.relpath).toBe("big.csv");
    // Different input order, same canonical choice.
    expect(first?.members[0]?.relpath).toBe(second?.members[0]?.relpath);
  });

  it("reports no families and zero duplication for genuinely distinct files", () => {
    const metrics = buildContentFamilies(
      [
        candidate("one.csv", join([["a"], ["1"]])),
        candidate("two.csv", join([["a"], ["2"]])),
      ],
      100,
    );
    expect(metrics.families).toEqual([]);
    expect(metrics.duplicateBytes).toBe(0);
    expect(metrics.duplicateAliasBytes).toBe(0);
  });

  it("never puts a file in two families", () => {
    const text = join(ROWS);
    const metrics = buildContentFamilies(
      [candidate("a.txt", text), candidate("b.txt", text), candidate("c.csv", text)],
      0,
    );
    const seen = metrics.families.flatMap((f) => f.members.map((m) => m.relpath));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("matches binary artifacts by bytes only", () => {
    const metrics = buildContentFamilies(
      [
        { relpath: "a.xlsx", bytes: 6659, sha256: "deadbeef" },
        { relpath: "b.xlsx", bytes: 6659, sha256: "deadbeef" },
        { relpath: "c.xlsx", bytes: 700, sha256: "cafe" },
      ],
      0,
    );
    expect(metrics.families).toHaveLength(1);
    expect(metrics.families[0]!.members.map((m) => m.relpath).sort()).toEqual(["a.xlsx", "b.xlsx"]);
  });
});

describe("duplicateAliasText", () => {
  it("names the family, the canonical path AND its public document id", () => {
    const text = duplicateAliasText({
      familyId: "family-abc123",
      canonicalRelpath: "roster.csv",
      canonicalDocumentId: "doc-9f1c2b",
      kind: "exact",
      formatDetailLost: false,
    });
    expect(text).toContain("Duplicate of dataset family-abc123");
    expect(text).toContain("Use the canonical representation for analysis.");
    expect(text).toContain("roster.csv");
    // Traceable by stable public identity, not only by a (possibly pseudonymized) name.
    expect(text).toContain("Canonical document id: doc-9f1c2b");
    expect(text).toContain("Duplicate kind: identical bytes");
  });

  it("distinguishes a normalized family from an exact one in the alias body", () => {
    const text = duplicateAliasText({
      familyId: "family-abc123",
      canonicalRelpath: "roster.csv",
      kind: "normalized",
      formatDetailLost: false,
    });
    expect(text).toContain("identical table, different encoding or format");
  });

  it("discloses format-specific loss when members differ in encoding or format", () => {
    const text = duplicateAliasText({
      familyId: "family-abc123",
      canonicalRelpath: "roster.csv",
      kind: "normalized",
      formatDetailLost: true,
    });
    expect(text).toMatch(/differ in encoding or format/);
    expect(text).toMatch(/preserves the DATA but/);
  });

  it("says nothing about format loss for a byte-identical family", () => {
    const text = duplicateAliasText({
      familyId: "family-abc123",
      canonicalRelpath: "roster.csv",
      kind: "exact",
      formatDetailLost: false,
    });
    expect(text).not.toMatch(/differ in encoding or format/);
  });
});

describe("canonical selection keeps the agent's context readable", () => {
  it("never makes a binary artifact canonical for a family containing text", () => {
    // Two reinforcing reasons. Structurally, a binary only ever joins an EXACT family
    // and cannot be byte-identical to a text file, so a mixed family does not arise
    // today. Behaviourally, the sort puts text first regardless — defence in depth if
    // normalized matching is ever extended to spreadsheet contents.
    const table = [["学籍番号", "氏名"], ["SID_CANARY_001", "STUDENT_CANARY_001"]];
    const csv = candidate("roster.csv", join(table));
    const xlsx: FamilyCandidate = { relpath: "roster.xlsx", bytes: 60_000, sha256: "aa" };
    const metrics = buildContentFamilies([xlsx, csv, candidate("copy.csv", join(table))], 0);

    // The binary is not grouped with the text representations at all.
    for (const family of metrics.families) {
      const paths = family.members.map((m) => m.relpath);
      if (paths.some((path) => path.endsWith(".csv"))) {
        expect(paths).not.toContain("roster.xlsx");
      }
      // Whatever the family, a canonical is never a binary while text is present.
      const hasText = paths.some((path) => /\.(?:csv|tsv|txt)$/.test(path));
      if (hasText) expect(family.canonicalRelpath).not.toMatch(/\.xlsx$/);
    }
    // And the text pair did form a family with a text canonical.
    const textFamily = metrics.families.find((f) =>
      f.members.every((m) => m.relpath.endsWith(".csv")),
    );
    expect(textFamily).toBeDefined();
    expect(textFamily!.canonicalRelpath).toMatch(/\.csv$/);
  });

  it("exposes the canonical relpath and document id on the family", () => {
    const table = [["学籍番号", "氏名"], ["SID_CANARY_001", "STUDENT_CANARY_001"]];
    const metrics = buildContentFamilies(
      [
        { ...candidate("a.csv", join(table)), documentId: "doc-aaa" },
        { ...candidate("b.csv", join(table)), documentId: "doc-bbb" },
      ],
      0,
    );
    const family = metrics.families[0]!;
    expect(family.canonicalRelpath).toBeTruthy();
    expect(family.canonicalDocumentId).toBeTruthy();
    // Every member carries its own id too, so a consumer can map both directions.
    expect(family.members.every((m) => Boolean(m.documentId))).toBe(true);
  });

  it("flags format loss across BOM/CRLF/delimiter variants, not within identical bytes", () => {
    const table = [["学籍番号", "氏名"], ["SID_CANARY_001", "STUDENT_CANARY_001"]];
    const mixed = buildContentFamilies(
      [candidate("a.csv", join(table)), candidate("b.tsv", join(table, "\t"))],
      0,
    ).families[0]!;
    expect(mixed.formatDetailLost).toBe(true);

    const identical = buildContentFamilies(
      [candidate("a.csv", join(table)), candidate("b.csv", join(table))],
      0,
    ).families[0]!;
    expect(identical.formatDetailLost).toBe(false);
  });
});
