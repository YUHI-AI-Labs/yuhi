/**
 * v0.5.0 Phase 1 — the ONE guarantee that matters for "observe": the executed
 * delivery path in `generationMode: "observe"` must be byte-identical to
 * `generationMode: "off"` (the pre-0.5.0 default). A Planner bug in observe mode
 * must never be able to change a single delivered byte — see
 * docs/design/0.5.0_dynamic_generation.md §7.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextStore, asSessionId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { privateMetadata } from "../event.js";
import { ContextRuntime, type Delivery } from "../pipeline.js";

const SESSION = asSessionId("planner-observe");

async function runtimeWith(generationMode: "off" | "observe" | "active"): Promise<ContextRuntime> {
  const root = await mkdtemp(join(tmpdir(), "yuhi-planner-observe-"));
  const store = await ContextStore.open({ root, now: () => "2026-08-06T00:00:00.000Z" });
  return new ContextRuntime({ store, now: () => "2026-08-06T00:00:00.000Z", generationMode });
}

const META = privateMetadata({ absolutePath: "/Users/testuser/project/data.json" });

function jsonPayload(): string {
  return JSON.stringify({
    users: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `user-${i}`, email: `user-${i}@example.com` })),
  });
}

describe("v0.5.0 Planner — observe mode never changes delivery", () => {
  it("off and observe produce byte-identical delivered text, strategy, and token counts", async () => {
    const off = await runtimeWith("off");
    const observe = await runtimeWith("observe");

    const content = jsonPayload();
    const deliverOff = await off.deliver({ sessionId: SESSION, tool: "read", kind: "json", content, privateMetadata: META });
    const deliverObserve = await observe.deliver({ sessionId: SESSION, tool: "read", kind: "json", content, privateMetadata: META });

    expect(deliverOff.status).toBe("delivered");
    expect(deliverObserve.status).toBe("delivered");
    if (deliverOff.status !== "delivered" || deliverObserve.status !== "delivered") return;

    expect(deliverObserve.text).toBe(deliverOff.text);
    expect(deliverObserve.strategy).toBe(deliverOff.strategy);
    expect(deliverObserve.tokensBefore).toBe(deliverOff.tokensBefore);
    expect(deliverObserve.tokensAfter).toBe(deliverOff.tokensAfter);
  });

  it("records a plan in evidence under observe mode, with executed always false", async () => {
    const observe = await runtimeWith("observe");
    const content = jsonPayload();
    const delivery: Delivery = await observe.deliver({
      sessionId: SESSION,
      tool: "read",
      kind: "json",
      content,
      privateMetadata: META,
    });
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    const explanation = await observe.explain(SESSION, delivery.eventId);
    expect(explanation?.record.plan).toBeDefined();
    expect(explanation?.record.plan?.generationMode).toBe("observe");
    expect(explanation?.record.plan?.executed).toBe(false);
    expect(explanation?.record.plan?.kind).toBe("structured");
    expect(explanation?.record.plan?.rule).toBe("rule-4-structured");
  });

  it("off mode never records a plan at all (zero overhead, not a no-op flag)", async () => {
    const off = await runtimeWith("off");
    const content = jsonPayload();
    const delivery: Delivery = await off.deliver({ sessionId: SESSION, tool: "read", kind: "json", content, privateMetadata: META });
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    const explanation = await off.explain(SESSION, delivery.eventId);
    expect(explanation?.record.plan).toBeUndefined();
  });

  it("a Rule 2 reuse plan is recorded on the second delivery of the identical content", async () => {
    const observe = await runtimeWith("observe");
    const content = jsonPayload();
    const first = await observe.deliver({ sessionId: SESSION, tool: "read", kind: "json", content, privateMetadata: META });
    const second = await observe.deliver({ sessionId: SESSION, tool: "read", kind: "json", content, privateMetadata: META });
    if (first.status !== "delivered" || second.status !== "delivered") throw new Error("expected delivery");

    // Delivery itself is unaffected (prefix stability already guarantees this in v0.4).
    expect(second.text).toBe(first.text);

    const explanation = await observe.explain(SESSION, second.eventId);
    expect(explanation?.record.plan?.rule).toBe("rule-2-reuse");
    expect(explanation?.record.plan?.kind).toBe("reuse");
  });
});
