/**
 * v0.5.0 Phase 6 — `tallyGenerationPlans` (CLI stats: directive §19's "Generation
 * plans: 18 / Reused: 7 / Structured: 4 / ..." example). Reads the SAME evidence
 * ledger `deliver()` already writes to — no separate live counter, so a gateway
 * restart never loses these counts (matches `tallyRetrievals`'s own pattern).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextStore, asSessionId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { privateMetadata } from "../event.js";
import { tallyGenerationPlans } from "../ledger.js";
import { ContextRuntime } from "../pipeline.js";

const META = privateMetadata({ absolutePath: "/Users/testuser/project/data.json" });

describe("tallyGenerationPlans", () => {
  it("counts nothing when generationMode is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "yuhi-tally-off-"));
    const store = await ContextStore.open({ root, now: () => "2026-08-06T00:00:00.000Z" });
    const runtime = new ContextRuntime({ store, now: () => "2026-08-06T00:00:00.000Z", generationMode: "off" });
    const session = asSessionId("tally-off");
    await runtime.deliver({ sessionId: session, tool: "read", kind: "json", content: JSON.stringify({ a: 1 }), privateMetadata: META });

    const tally = await tallyGenerationPlans(store, session);
    expect(tally.total).toBe(0);
    expect(tally.executed).toBe(0);
  });

  it("counts plan kinds by reading the delivery evidence directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "yuhi-tally-observe-"));
    const store = await ContextStore.open({ root, now: () => "2026-08-06T00:00:00.000Z" });
    const runtime = new ContextRuntime({ store, now: () => "2026-08-06T00:00:00.000Z", generationMode: "observe" });
    const session = asSessionId("tally-observe");

    const content = JSON.stringify({ a: 1 });
    await runtime.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    await runtime.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META }); // repeat -> reuse

    const tally = await tallyGenerationPlans(store, session);
    expect(tally.total).toBe(2);
    expect(tally.byKind["structured"]).toBe(1);
    expect(tally.byKind["reuse"]).toBe(1);
    // Observe mode never executes a plan.
    expect(tally.executed).toBe(0);
  });

  it("counts executed plans separately in active mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "yuhi-tally-active-"));
    const store = await ContextStore.open({ root, now: () => "2026-08-06T00:00:00.000Z" });
    const runtime = new ContextRuntime({ store, now: () => "2026-08-06T00:00:00.000Z", generationMode: "active" });
    const session = asSessionId("tally-active");

    const content = JSON.stringify({ a: 1 });
    await runtime.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    await runtime.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META }); // reuse, executed

    const tally = await tallyGenerationPlans(store, session);
    expect(tally.total).toBe(2);
    expect(tally.executed).toBe(2); // structured (Phase 3) and reuse (Phase 2) both execute in active mode
  });

  it("counts repeated-work events and hints from the same evidence rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "yuhi-tally-repeat-"));
    const store = await ContextStore.open({ root, now: () => "2026-08-06T00:00:00.000Z" });
    const runtime = new ContextRuntime({ store, now: () => "2026-08-06T00:00:00.000Z", generationMode: "observe" });
    const session = asSessionId("tally-repeat");

    const content = JSON.stringify({ a: 1 });
    await runtime.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META });
    await runtime.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META }); // count 1, no hint yet
    await runtime.deliver({ sessionId: session, tool: "read", kind: "json", content, privateMetadata: META }); // count 2, hint

    const tally = await tallyGenerationPlans(store, session);
    expect(tally.repeatedWorkEvents).toBe(2);
    expect(tally.repeatedWorkHints).toBe(1);
  });
});
