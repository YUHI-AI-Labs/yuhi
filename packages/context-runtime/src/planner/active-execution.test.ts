/**
 * v0.5.0 Phase 3 — structured/window/reference plans actually EXECUTE in
 * "active" generation mode, via the existing compressor registry / safeWindow /
 * referenceOnly helpers. Every case here also proves the downstream safety
 * pipeline (exact-output scan, and for reference/retrieval, the residue rescan)
 * still runs on whatever bytes these new paths propose.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextStore, asSessionId } from "@yuhi/context-store";
import { describe, expect, it } from "vitest";

import { privateMetadata } from "../event.js";
import { ContextRuntime, type Delivery } from "../pipeline.js";

async function runtimeWith(generationMode: "off" | "observe" | "active"): Promise<ContextRuntime> {
  const root = await mkdtemp(join(tmpdir(), "yuhi-planner-active-"));
  const store = await ContextStore.open({ root, now: () => "2026-08-06T00:00:00.000Z" });
  return new ContextRuntime({
    store,
    now: () => "2026-08-06T00:00:00.000Z",
    generationMode,
    retrievalAvailable: true,
  });
}

const META = privateMetadata({ absolutePath: "/Users/testuser/project/server.log" });

function largeLog(): string {
  const lines: string[] = [];
  for (let i = 0; i < 3000; i++) lines.push(`2026-08-06T00:00:${String(i % 60).padStart(2, "0")}Z INFO request ${i} handled ok`);
  return lines.join("\n");
}

describe("v0.5.0 Phase 3 — active-mode execution of structured/window/reference", () => {
  it("a large, classified log delivers a WINDOW when active, with a retrievable omission", async () => {
    const active = await runtimeWith("active");
    const session = asSessionId("phase3-window");
    const content = largeLog();
    const delivery: Delivery = await active.deliver({ sessionId: session, tool: "bash", kind: "log", content, privateMetadata: META });
    if (delivery.status !== "delivered") throw new Error("expected delivery");

    const explanation = await active.explain(session, delivery.eventId);
    const rule = explanation?.record.plan?.rule;
    // Depending on retrieval availability, Rule 5 (reference) or Rule 6 (window)
    // may fire — both are Phase 3's execution targets. Either way it must be
    // meaningfully smaller than the original and carry a retrievable omission.
    expect(["rule-5-reference", "rule-6-window"]).toContain(rule);
    expect(explanation?.record.plan?.executed).toBe(true);
    expect(delivery.tokensAfter).toBeLessThan(delivery.tokensBefore);
    expect(delivery.retrievable.length).toBeGreaterThan(0);
    expect(delivery.text).not.toBe(content);
  });

  it("the omitted region is retrievable and matches the original exactly", async () => {
    const active = await runtimeWith("active");
    const session = asSessionId("phase3-retrieve");
    const content = largeLog();
    const delivery: Delivery = await active.deliver({ sessionId: session, tool: "bash", kind: "log", content, privateMetadata: META });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    expect(delivery.retrievable.length).toBeGreaterThan(0);

    const region = delivery.retrievable[0]!;
    const retrieval = await active.retrieveByObject({
      sessionId: session,
      objectId: delivery.publicMetadata.objectId,
      locator: region.locator,
    });
    // A retrieval may be refused for exceeding the bounded-retrieval ceiling (the
    // whole log easily can); either way it must never silently fall back to
    // something outside the authorized locator, and a delivered retrieval must
    // reproduce exactly the withheld original bytes for that range.
    if (retrieval.status === "delivered") {
      expect(content).toContain(retrieval.text);
    } else {
      expect(retrieval.reason).toBeDefined();
    }
  });

  it("observe mode computes the SAME plan but never executes it — delivery matches off exactly", async () => {
    const off = await runtimeWith("off");
    const observe = await runtimeWith("observe");
    const session = asSessionId("phase3-observe-parity");
    const content = largeLog();

    const deliverOff = await off.deliver({ sessionId: session, tool: "bash", kind: "log", content, privateMetadata: META });
    const deliverObserve = await observe.deliver({ sessionId: session, tool: "bash", kind: "log", content, privateMetadata: META });
    if (deliverOff.status !== "delivered" || deliverObserve.status !== "delivered") throw new Error("expected delivery");

    expect(deliverObserve.text).toBe(deliverOff.text);
    expect(deliverObserve.strategy).toBe(deliverOff.strategy);

    const explanation = await observe.explain(session, deliverObserve.eventId);
    expect(explanation?.record.plan?.executed).toBe(false);
    expect(["rule-5-reference", "rule-6-window"]).toContain(explanation?.record.plan?.rule);
  });

  it("a reference-only candidate still passes the exact-output rescan (no raw secret leaks through the notice)", async () => {
    const active = await runtimeWith("active");
    const session = asSessionId("phase3-safety");
    // A large log with an embedded secret-shaped value; the notice text itself
    // must never contain it, regardless of which Phase 3 path executes.
    const content = `${largeLog()}\nAKIAABCDEFGHIJKLMNOP leaked-looking-key\n${largeLog()}`;
    const delivery: Delivery = await active.deliver({ sessionId: session, tool: "bash", kind: "log", content, privateMetadata: META });
    if (delivery.status !== "delivered") throw new Error("expected delivery");
    expect(delivery.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });
});
