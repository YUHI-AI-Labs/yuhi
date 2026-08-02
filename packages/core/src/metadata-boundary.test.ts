import { describe, expect, it } from "vitest";

import {
  buildWithheldRedactions,
  documentIdFor,
  findMetadataLeaks,
  redactMetadata,
  withheldDisplayName,
} from "./metadata-boundary.js";

describe("metadata boundary primitives", () => {
  it("derives a stable, non-reversible document identity", () => {
    const a = documentIdFor("docs/9999990001 評定-0722.xlsx", "salt-1");
    expect(a).toMatch(/^doc-[0-9a-f]{12}$/);
    // Deterministic for the same salt, different for another workspace/policy.
    expect(documentIdFor("docs/9999990001 評定-0722.xlsx", "salt-1")).toBe(a);
    expect(documentIdFor("docs/9999990001 評定-0722.xlsx", "salt-2")).not.toBe(a);
    // Nothing of the name survives in the identity.
    expect(a).not.toContain("9999990001");
    expect(a).not.toContain("評定");
  });

  it("keeps the KIND but nothing else in a withheld display name", () => {
    const id = documentIdFor("名簿/9999990001-評定.PDF", "s");
    expect(withheldDisplayName("名簿/9999990001-評定.PDF", id)).toBe(`${id}.pdf`);
    // An extension that is not a plain kind token is dropped, not echoed.
    expect(withheldDisplayName("weird/name.9999990001", id)).toBe(id);
    expect(withheldDisplayName("no-extension-at-all", id)).toBe(id);
  });

  it("rewrites every withheld name token, including the directory", () => {
    const withheld = [{ sourceRelpath: "名簿-9999990001/評定-0722.csv", documentId: "doc-abc123abc123" }];
    const redactions = buildWithheldRedactions({ withheld, delivered: ["src/app.ts"] });
    const surface = {
      relpath: "名簿-9999990001/評定-0722.csv",
      reason: "matched rule for 評定-0722.csv under 名簿-9999990001",
      nested: [{ note: "評定-0722" }],
      count: 3,
    };
    const projected = redactMetadata(surface, redactions);
    expect(findMetadataLeaks(projected, ["9999990001", "評定", "名簿"])).toEqual([]);
    expect(projected.relpath).toBe("doc-abc123abc123.csv");
    expect(projected.count).toBe(3);
  });

  it("never rewrites a name a DELIVERED file legitimately carries", () => {
    const redactions = buildWithheldRedactions({
      withheld: [{ sourceRelpath: "config/.env", documentId: "doc-000000000000" }],
      delivered: ["config/.env.example", "src/app.ts"],
    });
    const projected = redactMetadata({ a: "config/.env.example", b: "src/app.ts" }, redactions);
    expect(projected.a).toBe("config/.env.example");
    expect(projected.b).toBe("src/app.ts");
  });

  it("rewrites the longest token first so a path never becomes a half-name", () => {
    const redactions = buildWithheldRedactions({
      withheld: [{ sourceRelpath: "hr/roster-9999990001.pdf", documentId: "doc-deadbeefcafe" }],
      delivered: [],
    });
    expect(redactMetadata("hr/roster-9999990001.pdf", redactions)).toBe("doc-deadbeefcafe.pdf");
  });

  it("finds leaks in raw text as well as in a parsed object", () => {
    expect(findMetadataLeaks("### docs/roster.pdf", ["roster"])).toEqual(["roster"]);
    expect(findMetadataLeaks({ items: [{ relpath: "docs/roster.pdf" }] }, ["roster"])).toEqual(["roster"]);
    expect(findMetadataLeaks({ items: [{ documentId: "doc-1" }] }, ["roster"])).toEqual([]);
  });

  it("is a no-op when nothing was withheld", () => {
    const surface = { relpath: "src/app.ts" };
    expect(redactMetadata(surface, [])).toBe(surface);
  });
});
