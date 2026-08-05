/**
 * v0.4.8 Phase 3A — direct-personal identifier transformation wired into the LIVE
 * delivery/retrieval pipeline (spec §13). Synthetic fixture data only.
 *
 * These are the tests the "no display-only policy" requirement stands or falls on: a
 * Balanced/Strict delivery must never contain the raw identifier, and Trusted Local
 * must never silently apply a transform it did not acknowledge.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStudentAliasContext, resolveDeliveryPolicy, type PrivacyMode } from "@yuhi/shared";
import { ContextStore, asSessionId, type ObjectId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { policyForMode } from "./delivery-policy.js";
import { privateMetadata } from "./event.js";
import { ContextRuntime } from "./pipeline.js";

const SESSION = asSessionId("privacy-delivery");

/** The Phase 3B composition, inlined for these Phase 3A tests: derive the runtime's
 *  SECRET delivery policy from the SAME resolved Privacy Mode, exactly as the real
 *  gateway wiring will (`resolveDeliveryPolicy({ privacyMode, surface: "dynamic-terminal" })`). */
async function runtime(
  privacyMode: PrivacyMode = "balanced",
  aliasContext = createStudentAliasContext(),
): Promise<ContextRuntime> {
  const root = await mkdtemp(join(tmpdir(), "yuhi-privacy-delivery-"));
  const store = await ContextStore.open({ root, now: () => "2026-08-05T00:00:00.000Z" });
  const resolved = resolveDeliveryPolicy({ privacyMode, surface: "dynamic-terminal", warningAcknowledged: true });
  const deliveryPolicy = policyForMode(resolved.secretDeliveryMode === "redact" ? "strict" : "developer");
  return new ContextRuntime({ store, now: () => "2026-08-05T00:00:00.000Z", privacyMode, aliasContext, deliveryPolicy });
}

describe("prose tool result", () => {
  const content = "学籍番号 L001\n氏名 山田太郎\n成績 A\n";

  it("balanced masks the name, preserves the operational id and grade", async () => {
    const rt = await runtime("balanced");
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content,
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error(`expected delivery, got withheld`);
    expect(delivery.text).toContain("L001");
    expect(delivery.text).toContain("A");
    expect(delivery.text).not.toContain("山田太郎");
    expect(delivery.privacyMode).toBe("balanced");
    expect(delivery.directIdentifiersTransformed).toBeGreaterThan(0);

    const explanation = await rt.explain(SESSION, delivery.eventId);
    expect(explanation?.record.privacyMode).toBe("balanced");
    expect(explanation?.record.directIdentifiersTransformed).toBeGreaterThan(0);
    expect(explanation?.record.directIdentifierResidue).toBe(0);
    expect(explanation?.record.privacyVerificationPassed).toBe(true);
    expect(JSON.stringify(explanation?.record)).not.toContain("山田太郎");
  });

  it("strict masks identically to balanced", async () => {
    const rt = await runtime("strict");
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content,
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    expect(delivery.text).toContain("L001");
    expect(delivery.text).not.toContain("山田太郎");
  });

  it("trusted-local preserves the name unchanged", async () => {
    const rt = await runtime("trusted-local");
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content,
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    expect(delivery.text).toContain("山田太郎");
    expect(delivery.privacyMode).toBe("trusted-local");
    expect(delivery.directIdentifiersTransformed).toBe(0);
  });
});

describe("JSON tool result", () => {
  it("masks a shape-detectable email value regardless of key, preserves an ordinary name-shaped field with NO operational sibling key, keeps valid JSON", async () => {
    const rt = await runtime("balanced");
    // No operational-identifier-shaped key here ("id" alone is deliberately NOT
    // treated as one -- see text-deidentify.ts's GENERIC_OPERATIONAL_TYPES) -- an
    // ordinary API/test-fixture shape, not a student record.
    const content = JSON.stringify({ id: 1, name: "user-500", email: "user-500@example.com" });
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "json",
      content,
      privateMetadata: privateMetadata(),
      compress: false,
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    const parsed = JSON.parse(delivery.text) as { id: number; name: string; email: string };
    expect(parsed.name).toBe("user-500");
    expect(parsed.email).not.toContain("@example.com");
  });

  it("masks a name field by key when a sibling operational key makes the object record-shaped (student_id + name)", async () => {
    const rt = await runtime("balanced");
    const content = JSON.stringify({ student_id: "L001", name: "山田太郎", score: 90 });
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "json",
      content,
      privateMetadata: privateMetadata(),
      compress: false,
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    const parsed = JSON.parse(delivery.text) as { student_id: string; name: string; score: number };
    expect(parsed.student_id).toBe("L001");
    expect(parsed.name).toMatch(/^PERSON-\d+$/);
    expect(parsed.score).toBe(90);
  });
});

describe("configuration tool result", () => {
  const content = "API_URL=https://api.example.com\nADMIN_EMAIL=taro.yamada@example.com\nSYNTHETIC_API_KEY=sk-ant-api03-SYNTHETIC0000000000000000000000000000000000000000000000000000\n";

  it("balanced: the secret remains available to Claude, the personal email is transformed, the raw secret never reaches evidence", async () => {
    const rt = await runtime("balanced");
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content,
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    expect(delivery.text).toContain("sk-ant-api03-SYNTHETIC");
    expect(delivery.text).not.toContain("taro.yamada@example.com");

    const explanation = await rt.explain(SESSION, delivery.eventId);
    expect(JSON.stringify(explanation?.record)).not.toContain("sk-ant-api03-SYNTHETIC");
  });

  it("strict: the secret is redacted AND the personal email is transformed", async () => {
    const rt = await runtime("strict");
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content,
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    expect(delivery.text).not.toContain("sk-ant-api03-SYNTHETIC");
    expect(delivery.text).not.toContain("taro.yamada@example.com");
  });

  it("trusted-local: both the secret and the personal email may be delivered unchanged, but never reach evidence", async () => {
    const rt = await runtime("trusted-local");
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content,
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    expect(delivery.text).toContain("sk-ant-api03-SYNTHETIC");
    expect(delivery.text).toContain("taro.yamada@example.com");

    const explanation = await rt.explain(SESSION, delivery.eventId);
    expect(JSON.stringify(explanation?.record)).not.toContain("sk-ant-api03-SYNTHETIC");
  });
});

describe("retrieval reapplies the current privacy policy", () => {
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

  async function deliverWithOmittedName(rt: ContextRuntime): Promise<{ eventId: string; objectId: ObjectId }> {
    const before = Array.from({ length: 120 }, (_, i) => `row ${i}`);
    const after = Array.from({ length: 120 }, (_, i) => `row ${i + 400}`);
    const lines = [...before, "学籍番号 L001", "氏名 山田太郎", "成績 A", ...after].join("\n");
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "bash",
      kind: "text",
      content: lines,
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error("expected a degraded delivery");
    expect(delivery.text).not.toContain("山田太郎");
    const gap = delivery.retrievable[0]?.locator;
    if (!gap) throw new Error("expected an omitted, retrievable gap");
    return { eventId: delivery.eventId, objectId: delivery.publicMetadata.objectId };
  }

  it("balanced: retrieval of the omitted region returns the masked token, never the raw name", async () => {
    const root = await mkdtemp(join(tmpdir(), "yuhi-privacy-retrieval-"));
    const store = await ContextStore.open({ root, now: () => "2026-08-05T00:00:00.000Z" });
    const rt = new ContextRuntime({
      store,
      now: () => "2026-08-05T00:00:00.000Z",
      compressors: [exploding()],
      privacyMode: "balanced",
    });
    const { objectId } = await deliverWithOmittedName(rt);
    const retrieval = await rt.retrieveByObject({ sessionId: SESSION, objectId, locator: "L121-L123" });
    expect(retrieval.status).toBe("delivered");
    if (retrieval.status !== "delivered") return;
    expect(retrieval.text).toContain("L001");
    expect(retrieval.text).not.toContain("山田太郎");
  });

  it("trusted-local: retrieval of the omitted region returns the original name", async () => {
    const root = await mkdtemp(join(tmpdir(), "yuhi-privacy-retrieval-tl-"));
    const store = await ContextStore.open({ root, now: () => "2026-08-05T00:00:00.000Z" });
    const rt = new ContextRuntime({
      store,
      now: () => "2026-08-05T00:00:00.000Z",
      compressors: [exploding()],
      privacyMode: "trusted-local",
    });
    const before = Array.from({ length: 120 }, (_, i) => `row ${i}`);
    const after = Array.from({ length: 120 }, (_, i) => `row ${i + 400}`);
    const lines = [...before, "学籍番号 L001", "氏名 山田太郎", "成績 A", ...after].join("\n");
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "bash",
      kind: "text",
      content: lines,
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error("expected a degraded delivery");
    const objectId = delivery.publicMetadata.objectId;
    const retrieval = await rt.retrieveByObject({ sessionId: SESSION, objectId, locator: "L121-L123" });
    expect(retrieval.status).toBe("delivered");
    if (retrieval.status !== "delivered") return;
    expect(retrieval.text).toContain("山田太郎");
  });
});

describe("repeated delivery: same raw value, same session, same entity -> same token, byte-stable", () => {
  it("delivers byte-identical masked output for the same object and revision", async () => {
    const rt = await runtime("balanced");
    const content = "氏名 山田太郎\n";
    const first = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content,
      privateMetadata: privateMetadata(),
    });
    const second = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content,
      privateMetadata: privateMetadata(),
    });
    if (first.status !== "delivered" || second.status !== "delivered") throw new Error("expected deliveries");
    expect(second.text).toBe(first.text);
  });

  it("the SAME name mints the SAME token across two different tool results in one session, when a strong key links them", async () => {
    // A bare name with NO strong key deliberately mints a FRESH, unlinked token per
    // call (0.4.7 identity-linkage policy: a value match alone is not sufficient
    // evidence of identity — prose alone never REGISTERS an entity, only a table
    // does). Linkage requires the SAME strong business key (`L001`), registered by a
    // table delivery, to also be present in the prose delivery — exactly Static
    // Prepare's CSV<->PDF linkage rule, applied to two live tool results.
    const context = createStudentAliasContext();
    const rt = await runtime("balanced", context);
    const a = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "csv",
      content: "学籍番号,氏名\nL001,山田太郎\n",
      privateMetadata: privateMetadata(),
      compress: false,
    });
    const b = await rt.deliver({
      sessionId: SESSION,
      tool: "bash",
      kind: "text",
      content: "学籍番号 L001 の報告: 山田太郎\n",
      privateMetadata: privateMetadata(),
    });
    if (a.status !== "delivered" || b.status !== "delivered") throw new Error("expected deliveries");
    const tokenA = /PERSON-\d+/.exec(a.text)?.[0];
    const tokenB = /PERSON-\d+/.exec(b.text)?.[0];
    expect(tokenA).toBeDefined();
    expect(tokenA).toBe(tokenB);
  });
});

describe("verification mutation guard", () => {
  it("withholds delivery when the exact delivered bytes still contain a shape-detectable direct identifier", async () => {
    // Simulates what a broken/removed transform call would produce: a compressor that
    // reconstructs the raw email regardless of what safe-content it was given. Only
    // the post-compression residue rescan can catch this -- the same discipline the
    // existing secret-in-output test (`pipeline.test.ts`) already exercises.
    const leaking = {
      id: "leaking",
      version: "1",
      supports: () => true,
      estimateTokens: (t: string) => t.length,
      compress: async () => ({
        compressorId: "leaking",
        compressorVersion: "1",
        text: "contact taro.yamada@example.com for details",
        anchors: [],
        omissions: [],
        removed: [],
        tokensBefore: 10,
        tokensAfter: 5,
      }),
      verify: () => ({ ok: true }) as const,
    };
    const root = await mkdtemp(join(tmpdir(), "yuhi-privacy-mutation-"));
    const store = await ContextStore.open({ root, now: () => "2026-08-05T00:00:00.000Z" });
    const rt = new ContextRuntime({
      store,
      now: () => "2026-08-05T00:00:00.000Z",
      compressors: [leaking],
      privacyMode: "balanced",
    });
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content: "irrelevant original content, long enough to attempt compression".repeat(20),
      privateMetadata: privateMetadata(),
    });
    expect(delivery).toMatchObject({ status: "withheld", reason: "direct-personal-identifier-in-output" });
  });

  it("trusted-local: the same reconstructed-email compressor output is delivered (nothing was ever masked, so there is no residue policy to violate)", async () => {
    const leaking = {
      id: "leaking",
      version: "1",
      supports: () => true,
      estimateTokens: (t: string) => t.length,
      compress: async () => ({
        compressorId: "leaking",
        compressorVersion: "1",
        text: "contact taro.yamada@example.com for details",
        anchors: [],
        omissions: [],
        removed: [],
        tokensBefore: 10,
        tokensAfter: 5,
      }),
      verify: () => ({ ok: true }) as const,
    };
    const root = await mkdtemp(join(tmpdir(), "yuhi-privacy-mutation-tl-"));
    const store = await ContextStore.open({ root, now: () => "2026-08-05T00:00:00.000Z" });
    const rt = new ContextRuntime({
      store,
      now: () => "2026-08-05T00:00:00.000Z",
      compressors: [leaking],
      privacyMode: "trusted-local",
    });
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "text",
      content: "irrelevant original content, long enough to attempt compression".repeat(20),
      privateMetadata: privateMetadata(),
    });
    expect(delivery.status).toBe("delivered");
  });
});
