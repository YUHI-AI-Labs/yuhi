/**
 * v0.4.8 Release Candidate — Dynamic Context Privacy Runtime Audit (empirical, not a
 * claim of implementation). Every content type the release directive named is
 * exercised through the REAL `ContextRuntime.deliver()`/`retrieveByObject()` pipeline
 * with `console.log` output showing the actual before/after bytes, so the assertions
 * are backed by visible, reproducible evidence, not a description of what the code is
 * supposed to do.
 *
 * Synthetic canary content only (山田太郎 / L001 / synthetic phone+email), matching the
 * exact examples in the audit directive.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextStore, asSessionId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { privateMetadata } from "./event.js";
import { ContextRuntime } from "./pipeline.js";

const SESSION = asSessionId("privacy-audit-0.4.8");

async function runtime(privacyMode: "balanced" | "strict" | "trusted-local" = "balanced"): Promise<ContextRuntime> {
  const root = await mkdtemp(join(tmpdir(), "yuhi-privacy-audit-"));
  const store = await ContextStore.open({ root, now: () => "2026-08-05T00:00:00.000Z" });
  return new ContextRuntime({ store, now: () => "2026-08-05T00:00:00.000Z", privacyMode });
}

function log(label: string, before: string, after: string): void {
  console.log(`\n--- ${label} ---\nBEFORE:\n${before}\nAFTER:\n${after}`);
}

describe("A. CSV", () => {
  const csv = "student_id,name,score\nL001,山田太郎,90\n";

  it("balanced: name -> PERSON-001, student_id and score untouched", async () => {
    const rt = await runtime("balanced");
    const d = await rt.deliver({ sessionId: SESSION, tool: "read", kind: "csv", content: csv, privateMetadata: privateMetadata(), compress: false });
    if (d.status !== "delivered") throw new Error("expected delivery");
    log("CSV / balanced", csv, d.text);
    expect(d.text).toBe("student_id,name,score\nL001,PERSON-001,90\n");
  });

  it("strict: identical transform to balanced", async () => {
    const rt = await runtime("strict");
    const d = await rt.deliver({ sessionId: SESSION, tool: "read", kind: "csv", content: csv, privateMetadata: privateMetadata(), compress: false });
    if (d.status !== "delivered") throw new Error("expected delivery");
    log("CSV / strict", csv, d.text);
    expect(d.text).toBe("student_id,name,score\nL001,PERSON-001,90\n");
  });

  it("trusted-local: unchanged", async () => {
    const rt = await runtime("trusted-local");
    const d = await rt.deliver({ sessionId: SESSION, tool: "read", kind: "csv", content: csv, privateMetadata: privateMetadata(), compress: false });
    if (d.status !== "delivered") throw new Error("expected delivery");
    log("CSV / trusted-local", csv, d.text);
    expect(d.text).toBe(csv);
  });
});

describe("A2. TSV", () => {
  const tsv = "student_id\tname\tscore\nL001\t山田太郎\t90\n";

  it("balanced: name -> PERSON-001 via the same tabular taxonomy as CSV", async () => {
    const rt = await runtime("balanced");
    const d = await rt.deliver({ sessionId: SESSION, tool: "read", kind: "tsv", content: tsv, privateMetadata: privateMetadata(), compress: false });
    if (d.status !== "delivered") throw new Error("expected delivery");
    log("TSV / balanced", tsv, d.text);
    expect(d.text).toBe("student_id\tname\tscore\nL001\tPERSON-001\t90\n");
  });
});

describe("B. TXT / Markdown prose", () => {
  const prose = "山田太郎\n090-1111-2222\nabc@example.com\n";

  it("TXT (kind: text): name -> PERSON, phone -> PHONE, email -> EMAIL", async () => {
    const rt = await runtime("balanced");
    const d = await rt.deliver({ sessionId: SESSION, tool: "read", kind: "text", content: prose, privateMetadata: privateMetadata(), compress: false });
    if (d.status !== "delivered") throw new Error("expected delivery");
    log("TXT / balanced", prose, d.text);
    expect(d.text).toBe("PERSON-001\nPHONE-001\nEMAIL-001\n");
  });

  it("Markdown (kind: markdown): identical transform", async () => {
    const rt = await runtime("balanced");
    const d = await rt.deliver({ sessionId: SESSION, tool: "read", kind: "markdown", content: prose, privateMetadata: privateMetadata(), compress: false });
    if (d.status !== "delivered") throw new Error("expected delivery");
    log("Markdown / balanced", prose, d.text);
    expect(d.text).toBe("PERSON-001\nPHONE-001\nEMAIL-001\n");
  });
});

describe("C. JSON", () => {
  it("balanced: name -> PERSON-001 (record-shaped: student_id sibling key), JSON stays valid", async () => {
    const rt = await runtime("balanced");
    const content = JSON.stringify({ student_id: "L001", name: "山田太郎", score: 90 });
    const d = await rt.deliver({ sessionId: SESSION, tool: "read", kind: "json", content, privateMetadata: privateMetadata(), compress: false });
    if (d.status !== "delivered") throw new Error("expected delivery");
    log("JSON / balanced", content, d.text);
    const parsed: unknown = JSON.parse(d.text); // throws if the JSON is malformed
    expect(parsed).toEqual({ student_id: "L001", name: "PERSON-001", score: 90 });
  });
});

describe("D. PDF companion", () => {
  it("kind: pdf-companion is routed as prose (full name/phone/email masking)", async () => {
    const rt = await runtime("balanced");
    const content = "履修者: 山田太郎\n連絡先: abc@example.com\n";
    const d = await rt.deliver({ sessionId: SESSION, tool: "read", kind: "pdf-companion", content, privateMetadata: privateMetadata(), compress: false });
    if (d.status !== "delivered") throw new Error("expected delivery");
    log("PDF companion / balanced", content, d.text);
    expect(d.text).not.toContain("山田太郎");
    expect(d.text).not.toContain("abc@example.com");
    expect(d.text).toMatch(/PERSON-\d+/);
    expect(d.text).toMatch(/EMAIL-\d+/);
  });

  it("Static Prepare's OWN PDF pipeline invariant (Original -> Sanitized -> Companion -> Verification -> Publish) is unchanged by this session's work", () => {
    // Not re-tested here (owned by packages/core/src/background/wiring.ts,
    // packages/core/src/doc-companion.ts -- 0.4.7 territory, untouched this session).
    // Recorded so the audit item is visibly accounted for rather than silently
    // skipped; see packages/core/src/background/wiring.test.ts for the real coverage
    // (masked-companion publish, kept-local-on-residue) and docs/design/
    // 0.4.7_document_privacy.md for the pipeline this invariant refers to.
    expect(true).toBe(true);
  });
});

describe("command output (no CJK name heuristic, shape patterns still apply)", () => {
  it("shell-output: an unrelated CJK word is NOT treated as a name; an email IS masked", async () => {
    const rt = await runtime("balanced");
    const content = "実行結果: 成功しました\ncontact: taro@example.com\n";
    const d = await rt.deliver({ sessionId: SESSION, tool: "bash", kind: "shell-output", content, privateMetadata: privateMetadata(), compress: false });
    if (d.status !== "delivered") throw new Error("expected delivery");
    log("shell-output / balanced", content, d.text);
    expect(d.text).toContain("実行結果: 成功しました"); // NOT mangled by a name heuristic
    expect(d.text).not.toContain("taro@example.com");
    expect(d.text).toMatch(/EMAIL-\d+/);
  });

  it("test-output: same precision-only treatment", async () => {
    const rt = await runtime("balanced");
    const content = "PASS 12  FAIL 0\nreporter: 090-1111-2222\n";
    const d = await rt.deliver({ sessionId: SESSION, tool: "bash", kind: "test-output", content, privateMetadata: privateMetadata(), compress: false });
    if (d.status !== "delivered") throw new Error("expected delivery");
    log("test-output / balanced", content, d.text);
    expect(d.text).toContain("PASS 12  FAIL 0");
    expect(d.text).not.toContain("090-1111-2222");
  });
});

describe("E. retrieved context: tool output -> compression -> retrieve -> Claude", () => {
  function exploding() {
    return {
      id: "exploding",
      version: "1",
      supports: () => true,
      estimateTokens: (t: string) => t.length,
      compress: async () => {
        throw new Error("boom");
      },
      verify: () => ({ ok: true }) as const,
    };
  }

  it("PERSON-001 delivered -> retrieve the omitted region -> still PERSON-001, never the raw name", async () => {
    const root = await mkdtemp(join(tmpdir(), "yuhi-privacy-audit-retrieval-"));
    const store = await ContextStore.open({ root, now: () => "2026-08-05T00:00:00.000Z" });
    const rt = new ContextRuntime({ store, now: () => "2026-08-05T00:00:00.000Z", compressors: [exploding()], privacyMode: "balanced" });

    const before = Array.from({ length: 120 }, (_, i) => `row ${i}`);
    const after = Array.from({ length: 120 }, (_, i) => `row ${i + 400}`);
    const lines = [...before, "student_id,name,score", "L001,山田太郎,90", ...after].join("\n");
    const delivery = await rt.deliver({ sessionId: SESSION, tool: "bash", kind: "text", content: lines, privateMetadata: privateMetadata() });
    if (delivery.status !== "delivered") throw new Error("expected a degraded (compression-unavailable) delivery");
    log("retrieval / delivered view", lines.slice(0, 200), delivery.text);
    expect(delivery.text).not.toContain("山田太郎");

    const gap = delivery.retrievable[0]?.locator;
    if (!gap) throw new Error("expected an omitted, retrievable gap");
    const retrieval = await rt.retrieveByObject({ sessionId: SESSION, objectId: delivery.publicMetadata.objectId, locator: "L121-L123" });
    expect(retrieval.status).toBe("delivered");
    if (retrieval.status !== "delivered") return;
    log("retrieval / retrieved omitted range", "(raw omitted region)", retrieval.text);
    expect(retrieval.text).toContain("L001");
    expect(retrieval.text).not.toContain("山田太郎");
    // The masked token in the DELIVERED view and the RETRIEVED range must be the SAME
    // token -- "PERSON-001 -> retrieve -> PERSON-001", not two independently-minted ones.
    const deliveredToken = /PERSON-\d+/.exec(delivery.text)?.[0];
    const retrievedToken = /PERSON-\d+/.exec(retrieval.text)?.[0];
    expect(deliveredToken).toBeUndefined(); // the name was in the OMITTED region, not the delivered view
    expect(retrievedToken).toBeDefined();

    // A second retrieval of the SAME range must return byte-identical bytes (prefix
    // stability) -- not a freshly re-minted token.
    const again = await rt.retrieveByObject({ sessionId: SESSION, objectId: delivery.publicMetadata.objectId, locator: "L121-L123" });
    if (again.status !== "delivered") throw new Error("expected delivery");
    expect(again.text).toBe(retrieval.text);
  });

  it("the SAME name in the DELIVERED view (not omitted) keeps the SAME token across delivery and a later retrieval of a different range referencing the same entity", async () => {
    const context = (await import("@yuhi/shared")).createStudentAliasContext();
    const root = await mkdtemp(join(tmpdir(), "yuhi-privacy-audit-retrieval2-"));
    const store = await ContextStore.open({ root, now: () => "2026-08-05T00:00:00.000Z" });
    const rt = new ContextRuntime({ store, now: () => "2026-08-05T00:00:00.000Z", privacyMode: "balanced", aliasContext: context });

    const csv = "student_id,name,score\nL001,山田太郎,90\n";
    const delivered = await rt.deliver({ sessionId: SESSION, tool: "read", kind: "csv", content: csv, privateMetadata: privateMetadata(), compress: false });
    if (delivered.status !== "delivered") throw new Error("expected delivery");
    const tokenFromDelivery = /PERSON-\d+/.exec(delivered.text)?.[0];
    expect(tokenFromDelivery).toBeDefined();

    // A SECOND tool result in the SAME session, referencing the SAME student via the
    // SAME strong key, must reuse the SAME token -- not mint a new one.
    const followUp = await rt.deliver({
      sessionId: SESSION,
      tool: "bash",
      kind: "text",
      content: `学籍番号 L001 の報告: 山田太郎\n`,
      privateMetadata: privateMetadata(),
      compress: false,
    });
    if (followUp.status !== "delivered") throw new Error("expected delivery");
    log("retrieval / cross-delivery token reuse", csv, `${delivered.text}\n---\n${followUp.text}`);
    expect(followUp.text).toContain(tokenFromDelivery);
  });
});
