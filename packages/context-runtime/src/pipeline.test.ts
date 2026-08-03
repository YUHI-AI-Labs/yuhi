/**
 * Vertical slice 1 end-to-end (spec §20):
 *   Large JSON → compression → private store → retrieve → evidence → benchmark.
 *
 * These tests are the slice-1 gate: the §18 security zeros (secret exposure, PII
 * exposure, metadata leakage) and prefix stability are asserted here, not assumed.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextStore, asSessionId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { privateMetadata } from "./event.js";
import { ContextRuntime, type Delivery } from "./pipeline.js";

const SESSION = asSessionId("slice-one");
const SECRET_HEADER = "-----BEGIN RSA PRIVATE KEY-----";
const ABSOLUTE_PATH = "/Users/testuser/private-project/config.json";
const HOME = "/Users/testuser";

async function runtime(overrides: Partial<ConstructorParameters<typeof ContextRuntime>[0]> = {}): Promise<ContextRuntime> {
  const root = await mkdtemp(join(tmpdir(), "yuhi-ctx-runtime-"));
  const store = await ContextStore.open({ root, now: () => "2026-08-03T00:00:00.000Z" });
  return new ContextRuntime({ store, now: () => "2026-08-03T00:00:00.000Z", ...overrides });
}

/** A large JSON payload whose FIRST row is sampled, so the secret is in the view path. */
function payload(rows = 2000): string {
  const users = Array.from({ length: rows }, (_, i) => ({
    id: i + 1,
    name: `user-${i}`,
    email: `user-${i}@example.com`,
    note: "x".repeat(120),
  }));
  users[0] = {
    id: 1,
    name: "admin",
    email: "admin@example.com",
    note: `${SECRET_HEADER}MIIEowIBAAKCAQEA7Zx9qQ2vTn0lKpZs3mWfYbGh8dJcR4tUvXwYzA1bC2dE3fG4hI5j`,
  } as (typeof users)[number];
  return JSON.stringify({ configPath: ABSOLUTE_PATH, home: HOME, users });
}

const META = privateMetadata({
  absolutePath: ABSOLUTE_PATH,
  sourceBasename: "config.json",
  homeDir: HOME,
  hostname: "test-macbook.local",
});

/** A compressor that always fails — used to exercise the availability class. */
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

async function deliverPayload(rt: ContextRuntime, content = payload()): Promise<Delivery> {
  return rt.deliver({
    sessionId: SESSION,
    tool: "read",
    kind: "json",
    content,
    privateMetadata: META,
  });
}

describe("Yuhi Runtime — large JSON slice", () => {
  it("delivers a compressed view, never the original bytes", async () => {
    const rt = await runtime();
    const delivery = await deliverPayload(rt);

    expect(delivery.status).toBe("delivered");
    if (delivery.status !== "delivered") return;

    expect(delivery.strategy).toBe("json-outline@1");
    expect(delivery.text).toContain("array(2000)");
    // §18: ≥70% fewer delivered tokens for large JSON.
    expect(1 - delivery.tokensAfter / delivery.tokensBefore).toBeGreaterThan(0.7);
    // The agent sees an opaque id, not a path.
    expect(delivery.publicMetadata.objectId).toMatch(/^obj_[0-9a-f]{32}$/);
    expect(JSON.stringify(delivery.publicMetadata)).not.toContain("testuser");
  });

  it("leaks zero secrets, zero PII and zero private metadata (§18 zeros)", async () => {
    const rt = await runtime();
    const delivery = await deliverPayload(rt);
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    expect(delivery.text).not.toContain(SECRET_HEADER);
    expect(delivery.text).not.toContain(ABSOLUTE_PATH);
    expect(delivery.text).not.toContain("testuser");
    expect(delivery.text).not.toContain("test-macbook.local");
    // The scrub is visible rather than silent.
    expect(delivery.text).toContain("«PATH»");

    const explanation = await rt.explain(SESSION, delivery.eventId);
    expect(explanation?.record.secretRedactions).toBeGreaterThan(0);
    expect(explanation?.record.metadataRedactions).toBeGreaterThan(0);
    expect(explanation?.record.metadataLabels).toContain("PATH");
  });

  it("records complete evidence for the transformation", async () => {
    const rt = await runtime();
    const delivery = await deliverPayload(rt);
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    const explanation = await rt.explain(SESSION, delivery.eventId);
    const record = explanation?.record;
    expect(record).toBeDefined();
    expect(record?.originalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.deliveredHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.originalHash).not.toBe(record?.deliveredHash);
    expect(record?.strategy).toBe("json-outline@1");
    expect(record?.anchors.length).toBeGreaterThan(0);
    expect(record?.removed.length).toBeGreaterThan(0);
    expect(record?.deliveryPath).toBe("delivered");
    expect(explanation?.retrievable.length).toBeGreaterThan(0);
    // Findings are public-safe: counts and categories only, never a value.
    for (const finding of record?.safetyFindings ?? []) {
      expect(Object.keys(finding).sort()).toEqual(["count", "detector", "severity"]);
    }
  });

  it("bounds retrieval: refuses an over-large range and suggests a narrower one", async () => {
    const rt = await runtime();
    const delivery = await deliverPayload(rt);
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    const slice = delivery.retrievable.find((o) => o.kind === "array-elements");
    expect(slice?.locator).toBe("$.users[2:1998]");

    // An exposed locator is not permission to pull an unbounded range (§10).
    const tooLarge = await rt.retrieve({
      sessionId: SESSION,
      eventId: delivery.eventId,
      locator: slice?.locator ?? "",
    });
    expect(tooLarge).toMatchObject({ status: "withheld", reason: "range-too-large" });
    if (tooLarge.status !== "withheld") return;
    expect(tooLarge.suggestion).toBe("$.users[2:102]");
  });

  it("reverses an omission through a narrower sub-range, and counts it in the ledger", async () => {
    const rt = await runtime();
    const delivery = await deliverPayload(rt);
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    // Narrower than the exposed slice: strictly less data, so it stays authorized.
    const retrieval = await rt.retrieveByObject({
      sessionId: SESSION,
      objectId: delivery.publicMetadata.objectId,
      locator: "$.users[500:520]",
      reason: "inspect the failing records",
    });
    expect(retrieval.status).toBe("delivered");
    if (retrieval.status !== "delivered") return;
    expect(retrieval.text).toContain("user-500");
    expect(retrieval.tokens).toBeGreaterThan(0);

    // Deterministic: the same range returns the same bytes.
    const again = await rt.retrieveByObject({
      sessionId: SESSION,
      objectId: delivery.publicMetadata.objectId,
      locator: "$.users[500:520]",
    });
    if (again.status !== "delivered") throw new Error("expected delivery");
    expect(again.text).toBe(retrieval.text);

    const explanation = await rt.explain(SESSION, delivery.eventId);
    expect(explanation?.retrievalCount).toBeGreaterThanOrEqual(1);
  });

  it("refuses a locator the event never withheld", async () => {
    const rt = await runtime();
    const delivery = await deliverPayload(rt);
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    // `$.users[0]` was delivered as a sample, so it is not a retrievable omission.
    // retrieve() must not become an arbitrary read of the private object.
    const refused = await rt.retrieve({ sessionId: SESSION, eventId: delivery.eventId, locator: "$.users[0]" });
    expect(refused).toMatchObject({ status: "withheld", reason: "locator-not-withheld" });

    const explanation = await rt.explain(SESSION, delivery.eventId);
    expect(explanation?.retrievals[0]?.outcome).toBe("withheld");
  });

  it("re-scans retrieved regions, so a collapsed secret cannot come back raw", async () => {
    const rt = await runtime();
    const rows = Array.from({ length: 300 }, (_, i) => ({ id: i, note: `row ${i}` }));
    rows[150] = { id: 150, note: `${SECRET_HEADER}AAAAB3NzaC1yc2EAAAADAQABAAABgQDZx9qQ2vTn0lKpZs3` };
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "json",
      content: JSON.stringify({ rows }),
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    expect(delivery.text).not.toContain(SECRET_HEADER);

    const slice = delivery.retrievable.find((o) => o.kind === "array-elements");
    const retrieval = await rt.retrieve({
      sessionId: SESSION,
      eventId: delivery.eventId,
      locator: slice?.locator ?? "",
    });
    if (retrieval.status !== "delivered") throw new Error("expected retrieval");
    expect(retrieval.text).toContain("row 149");
    expect(retrieval.text).not.toContain(SECRET_HEADER);
  });

  it("keeps delivered bytes stable for the same object and revision", async () => {
    const rt = await runtime();
    const content = payload();
    const first = await deliverPayload(rt, content);
    const second = await deliverPayload(rt, content);
    if (first.status !== "delivered" || second.status !== "delivered") throw new Error("expected deliveries");

    // Byte-identical: re-emitting a changed prefix would bust the provider KV cache.
    expect(second.text).toBe(first.text);
    expect(rt.stableFor(first.publicMetadata.objectId, first.publicMetadata.revision)).toBe(true);
    const explanation = await rt.explain(SESSION, second.eventId);
    expect(explanation?.record.prefixStable).toBe(true);
  });

  it("delivers the scanned original when content is genuinely incompressible", async () => {
    const rt = await runtime();
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "json",
      content: '{"ok":true}',
      privateMetadata: privateMetadata(),
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    // Honest: no inflated view, and the ledger says which path was taken.
    expect(delivery.strategy).toBe("original");
    expect(delivery.text).toBe('{"ok":true}');
    const explanation = await rt.explain(SESSION, delivery.eventId);
    expect(explanation?.record.deliveryPath).toBe("delivered-original");
  });

  it("degrades to a deterministic safe window when compression is UNAVAILABLE", async () => {
    // §7: an availability failure is not a security failure. These bytes already passed
    // secret/PII/metadata scanning, so blocking the agent entirely would be the wrong
    // trade — `file blocked ≠ launch blocked`.
    const rt = await runtime({ compressors: [exploding()] });
    const lines = Array.from({ length: 400 }, (_, i) => `row ${i}`).join("\n");
    const delivery = await rt.deliver({
      sessionId: SESSION,
      tool: "bash",
      kind: "shell-output",
      content: lines,
      privateMetadata: privateMetadata(),
    });

    if (delivery.status !== "delivered") throw new Error("expected a degraded delivery");
    expect(delivery.fallback).toBe("safe-window");
    expect(delivery.text).toContain("row 0");
    expect(delivery.text).not.toContain("row 200");
    expect(delivery.tokensAfter).toBeLessThan(delivery.tokensBefore);

    const explanation = await rt.explain(SESSION, delivery.eventId);
    expect(explanation?.record.deliveryPath).toBe("delivered-fallback");
    expect(explanation?.record.failureClass).toBe("availability");

    // The gap the fallback created is itself retrievable — nothing is destroyed.
    const gap = delivery.retrievable[0]?.locator ?? "";
    expect(gap).toMatch(/^L\d+-L\d+$/);
    const back = await rt.retrieveByObject({
      sessionId: SESSION,
      objectId: delivery.publicMetadata.objectId,
      locator: "L61-L160",
    });
    expect(back.status).toBe("delivered");
  });

  it("withholds — never falls back to raw — when the policy forbids degrading", async () => {
    const rt = await runtime({
      compressors: [exploding()],
      fallbackPolicy: { onAvailabilityFailure: "withhold", safeWindowLines: 120 },
    });
    const delivery = await deliverPayload(rt);

    expect(delivery.status).toBe("withheld");
    if (delivery.status !== "withheld") return;
    expect(delivery.reason).toBe("all-compressors-failed");
    expect(delivery.failureClass).toBe("availability");
    // Public metadata is still available: the agent learns something exists.
    expect(delivery.publicMetadata.kind).toBe("json");

    const explanation = await rt.explain(SESSION, delivery.eventId);
    expect(explanation?.record.deliveryPath).toBe("withheld");
    expect(explanation?.record.deliveredHash).toBe("");
  });

  it("withholds when a compressor would emit private metadata", async () => {
    // A compressor that reconstructs a private path defeats the pre-scan; only the
    // exact-output rescan can catch it. This is that test.
    const leaking = {
      id: "leaking",
      version: "1",
      supports: () => true,
      estimateTokens: (t: string) => t.length,
      compress: async () => ({
        compressorId: "leaking",
        compressorVersion: "1",
        text: `summary of ${ABSOLUTE_PATH}`,
        anchors: [],
        omissions: [],
        removed: [],
        tokensBefore: 10_000,
        tokensAfter: 10,
      }),
      verify: () => ({ ok: true }) as const,
    };
    const rt = await runtime({ compressors: [leaking] });
    const delivery = await deliverPayload(rt);
    // A SECURITY failure: no policy may degrade this into a delivery.
    expect(delivery).toMatchObject({
      status: "withheld",
      reason: "private-metadata-in-output",
      failureClass: "security",
    });
  });

  it("gives each event a deterministic id and a monotonic sequence", async () => {
    const rt = await runtime();
    const a = await deliverPayload(rt, payload(300));
    const b = await deliverPayload(rt, payload(400));
    expect(a.eventId).toMatch(/^evt_[0-9a-f]{32}$/);
    expect(b.eventId).not.toBe(a.eventId);
    const first = await rt.explain(SESSION, a.eventId);
    const second = await rt.explain(SESSION, b.eventId);
    expect(second?.record.seq).toBe((first?.record.seq ?? 0) + 1);
  });
});
