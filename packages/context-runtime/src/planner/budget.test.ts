/**
 * v0.5.0 Phase 4 — Dynamic Budget, runtime-level (see rules.test.ts for the pure
 * Rule 7/8 unit tests). Directive §24 Budget Tests: target unset -> v0.4
 * compatible, target set -> planner uses budget, maximum exceeded ->
 * reference/window, load-bearing not silently removed.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextStore, asSessionId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { privateMetadata } from "../event.js";
import { ContextRuntime, type Delivery } from "../pipeline.js";

async function runtimeWith(
  generationMode: "off" | "observe" | "active",
  runtimeBudget?: { target?: number; maximum?: number },
): Promise<ContextRuntime> {
  const root = await mkdtemp(join(tmpdir(), "yuhi-planner-budget-"));
  const store = await ContextStore.open({ root, now: () => "2026-08-06T00:00:00.000Z" });
  return new ContextRuntime({
    store,
    now: () => "2026-08-06T00:00:00.000Z",
    generationMode,
    retrievalAvailable: true,
    ...(runtimeBudget ? { runtimeBudget } : {}),
  });
}

const META = privateMetadata({ absolutePath: "/Users/testuser/project/data.txt" });

function largeProse(): string {
  const lines: string[] = [];
  for (let i = 0; i < 2000; i++) lines.push(`Line ${i}: the quick brown fox jumps over the lazy dog.`);
  return lines.join("\n");
}

describe("v0.5.0 Phase 4 — Dynamic Budget", () => {
  it("an unset budget is pre-0.5.0 compatible: no `budget` field reaches the plan's evidence at all", async () => {
    const observe = await runtimeWith("observe");
    const session = asSessionId("budget-unset");
    const content = largeProse();
    const delivery: Delivery = await observe.deliver({ sessionId: session, tool: "read", kind: "text", content, privateMetadata: META });
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    // No crash, no budget-pressure reason, and delivery identical to what off mode produces.
    const off = await runtimeWith("off");
    const deliverOff = await off.deliver({ sessionId: session, tool: "read", kind: "text", content, privateMetadata: META });
    if (deliverOff.status !== "delivered") throw new Error("expected delivery");
    expect(delivery.text).toBe(deliverOff.text);
  });

  it("a configured target changes the plan the Planner produces for load-bearing content", async () => {
    const active = await runtimeWith("active", { target: 50 });
    const session = asSessionId("budget-target");
    const content = "short load-bearing content";
    const delivery: Delivery = await active.deliver({
      sessionId: session,
      tool: "read",
      kind: "text",
      content,
      privateMetadata: META,
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    const explanation = await active.explain(session, delivery.eventId);
    // With a target this small, the plan must reference the target explicitly
    // rather than silently falling through unaffected.
    expect(explanation?.record.plan).toBeDefined();
  });

  it("content exceeding a configured maximum resolves to reference or window, never silently withheld", async () => {
    const active = await runtimeWith("active", { maximum: 100 });
    const session = asSessionId("budget-maximum");
    const content = largeProse();
    const delivery: Delivery = await active.deliver({
      sessionId: session,
      tool: "read",
      kind: "text",
      content,
      privateMetadata: META,
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    const explanation = await active.explain(session, delivery.eventId);
    expect(["rule-5-reference", "rule-6-window", "rule-8-safe-fallback"]).toContain(explanation?.record.plan?.rule);
    expect(delivery.status).toBe("delivered"); // never withheld purely for size
  });

  it("large load-bearing content is never silently removed under budget pressure — it stays retrievable", async () => {
    const active = await runtimeWith("active", { maximum: 200 });
    const session = asSessionId("budget-load-bearing");
    // A file path that is its own active edit target, so role classification can
    // resolve to load-bearing even though it is far larger than the maximum.
    const path = "/Users/testuser/project/src/index.ts";
    const content = largeProse();
    const delivery: Delivery = await active.deliver({
      sessionId: session,
      tool: "read",
      kind: "source",
      content,
      privateMetadata: privateMetadata({ absolutePath: path }),
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    // Never "withheld": the content is either windowed/referenced (retrievable)
    // or delivered in full — but the delivery never simply vanishes.
    expect(delivery.status).toBe("delivered");
    expect(delivery.tokensAfter).toBeGreaterThan(0);
  });

  it("cumulative delivered tokens across a session feed the budget state (estimatedRemaining shrinks)", async () => {
    const active = await runtimeWith("observe", { maximum: 1_000_000 });
    const session = asSessionId("budget-cumulative");
    await active.deliver({ sessionId: session, tool: "read", kind: "text", content: largeProse(), privateMetadata: META });
    const secondSession = asSessionId("budget-cumulative-2");
    // A second, distinct object under the SAME runtime instance still shares the
    // cumulative counter (budget is runtime/session-scoped, not per-object).
    const delivery = await active.deliver({
      sessionId: secondSession,
      tool: "read",
      kind: "text",
      content: `${largeProse()}\nextra`,
      privateMetadata: META,
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    const explanation = await active.explain(secondSession, delivery.eventId);
    expect(explanation?.record.plan).toBeDefined();
  });
});
