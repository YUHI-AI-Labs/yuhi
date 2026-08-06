/**
 * v0.5.0 Phase 5 — Repeated Work Observation wired through ContextRuntime.
 * Advisory only: never a forced block, recorded in evidence/stats, and a hint
 * is offered at most once per (object, type) pair.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextStore, asSessionId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { privateMetadata } from "../event.js";
import { ContextRuntime, type Delivery } from "../pipeline.js";

async function runtimeWith(generationMode: "off" | "observe" | "active"): Promise<ContextRuntime> {
  const root = await mkdtemp(join(tmpdir(), "yuhi-repeated-work-"));
  const store = await ContextStore.open({ root, now: () => "2026-08-06T00:00:00.000Z" });
  return new ContextRuntime({ store, now: () => "2026-08-06T00:00:00.000Z", generationMode });
}

const META = privateMetadata({ absolutePath: "/Users/testuser/project/data.json" });

describe("v0.5.0 Phase 5 — Repeated Work Observation", () => {
  it("records an exact-read event and hint only from the SECOND identical delivery onward", async () => {
    const observe = await runtimeWith("observe");
    const session = asSessionId("repeated-1");
    const content = JSON.stringify({ a: 1 });

    const first: Delivery = await observe.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    if (first.status !== "delivered") throw new Error("expected delivery");
    const firstExplanation = await observe.explain(session, first.eventId);
    expect(firstExplanation?.record.repeatedWork).toBeUndefined();

    const second: Delivery = await observe.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    if (second.status !== "delivered") throw new Error("expected delivery");
    const secondExplanation = await observe.explain(session, second.eventId);
    expect(secondExplanation?.record.repeatedWork?.type).toBe("exact-read");
    expect(secondExplanation?.record.repeatedWork?.count).toBe(1);
    expect(secondExplanation?.record.repeatedWork?.hint).toBeUndefined(); // count < 2 in the tracker's own numbering starts at 1 for the first repeat

    const third: Delivery = await observe.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    if (third.status !== "delivered") throw new Error("expected delivery");
    const thirdExplanation = await observe.explain(session, third.eventId);
    expect(thirdExplanation?.record.repeatedWork?.count).toBe(2);
    expect(thirdExplanation?.record.repeatedWork?.hint).toBeDefined();

    const fourth: Delivery = await observe.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    if (fourth.status !== "delivered") throw new Error("expected delivery");
    const fourthExplanation = await observe.explain(session, fourth.eventId);
    // Never the same hint twice for the same (object, type) pair.
    expect(fourthExplanation?.record.repeatedWork?.hint).toBeUndefined();
  });

  it("never blocks or changes delivered bytes — advisory only", async () => {
    const active = await runtimeWith("active");
    const session = asSessionId("repeated-2");
    const content = JSON.stringify({ a: 1 });

    const first = await active.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    const second = await active.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    if (first.status !== "delivered" || second.status !== "delivered") throw new Error("expected delivery");
    expect(second.status).toBe("delivered");
    expect(second.text).toBe(first.text);
  });

  it("stats aggregate by type across the session", async () => {
    const observe = await runtimeWith("observe");
    const session = asSessionId("repeated-3");
    const content = JSON.stringify({ a: 1 });
    await observe.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    await observe.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    await observe.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });

    const stats = observe.repeatedWorkSessionStats;
    expect(stats.byType["exact-read"]).toBe(2); // 2nd and 3rd deliveries are repeats
    expect(stats.hintedPairs).toBe(1);
  });

  it("a retrieval repeated against an earlier retrieval of the same object is observed as contained/overlapping-read", async () => {
    const observe = await runtimeWith("observe");
    const session = asSessionId("repeated-5");
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const delivery: Delivery = await observe.deliver({ sessionId: session, tool: "read", kind: "text", content: lines, privateMetadata: META, compress: true });
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    // First retrieval, using an allowed unexposed range for the test (bypassing
    // the "must have been omitted" gate) so this test only exercises repeated
    // work observation, not the full omission/exposure machinery.
    const objectId = delivery.publicMetadata.objectId;
    const first = await observe.retrieveByObject({ sessionId: session, objectId, locator: "L1-L50", allowUnexposed: true, reason: "test" });
    if (first.status !== "delivered") throw new Error(`expected delivered retrieval, got ${first.status}: ${JSON.stringify(first)}`);

    // Same exact locator again -> contained-read.
    const second = await observe.retrieveByObject({ sessionId: session, objectId, locator: "L1-L50", allowUnexposed: true, reason: "test" });
    expect(second.status).toBe("delivered");

    const rows = await observe.explain(session, delivery.eventId);
    void rows; // explain() covers deliveries; retrieval rows are asserted via stats below
    expect(observe.repeatedWorkSessionStats.byType["contained-read"]).toBeGreaterThan(0);
  });

  it("off mode never observes repeated work at all", async () => {
    const off = await runtimeWith("off");
    const session = asSessionId("repeated-4");
    const content = JSON.stringify({ a: 1 });
    await off.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    const second = await off.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    if (second.status !== "delivered") throw new Error("expected delivery");
    const explanation = await off.explain(session, second.eventId);
    expect(explanation?.record.repeatedWork).toBeUndefined();
    expect(off.repeatedWorkSessionStats.byType["exact-read"]).toBe(0);
  });
});
