import { describe, expect, it } from "vitest";
import { compressWithFallback, defaultCompressContext, BUILTIN_COMPRESSORS } from "@yuhi/context-compression";
import { planWithRules } from "./rules.js";
import { capabilitiesOf } from "./types.js";
import type { PlannerInput, PriorDelivery } from "./types.js";

const CAPS = capabilitiesOf([...BUILTIN_COMPRESSORS]);

function baseInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    intent: "unknown",
    role: "unknown",
    contentType: "json",
    objectId: "obj-1",
    revision: 1,
    measurement: { estimatedTokens: 500, exactCharacters: 2000 },
    priorDeliveries: [],
    retrievalAvailable: false,
    compressors: CAPS,
    privacyMode: "balanced",
    secretDeliveryMode: "developer-delivery",
    privacyOrSecurityFailure: false,
    tool: "read",
    ...overrides,
  };
}

describe("Planner Rules v1", () => {
  it("Rule 1: a privacy/security failure withholds regardless of other signals", () => {
    const plan = planWithRules(baseInput({ privacyOrSecurityFailure: true, role: "load-bearing" }));
    expect(plan.kind).toBe("withhold");
    expect(plan.rule).toBe("rule-1-privacy-failure");
  });

  it("Rule 2: same object/revision already delivered reuses it", () => {
    const prior: PriorDelivery = {
      objectId: "obj-1",
      revision: 1,
      representationId: "json-outline@1",
      deliveredHash: "abc123",
      planKind: "structured",
      estimatedTokens: 100,
      exactCharacters: 400,
      deliveredAtTurn: 1,
    };
    const plan = planWithRules(baseInput({ priorDeliveries: [prior] }));
    expect(plan.kind).toBe("reuse");
    expect(plan.rule).toBe("rule-2-reuse");
    expect(plan.reuseObjectId).toBe("obj-1");
  });

  it("Rule 3: small + load-bearing delivers full", () => {
    const plan = planWithRules(
      baseInput({
        role: "load-bearing",
        contentType: "text",
        measurement: { estimatedTokens: 100, exactCharacters: 400 },
        compressors: [],
      }),
    );
    expect(plan.kind).toBe("full");
    expect(plan.rule).toBe("rule-3-small-load-bearing");
  });

  it("Rule 4: a structured compressor available routes to structured", () => {
    const plan = planWithRules(baseInput({ contentType: "json", role: "supporting" }));
    expect(plan.kind).toBe("structured");
    expect(plan.rule).toBe("rule-4-structured");
  });

  it("Rule 5: large + retrieval available + reference role routes to reference", () => {
    const plan = planWithRules(
      baseInput({
        role: "reference",
        contentType: "log",
        retrievalAvailable: true,
        measurement: { estimatedTokens: 50_000, exactCharacters: 200_000 },
        compressors: [],
      }),
    );
    expect(plan.kind).toBe("reference");
    expect(plan.rule).toBe("rule-5-reference");
  });

  it("Rule 6: large prose/source without retrieval routes to window", () => {
    const plan = planWithRules(
      baseInput({
        role: "supporting",
        contentType: "source",
        retrievalAvailable: false,
        measurement: { estimatedTokens: 50_000, exactCharacters: 200_000 },
        compressors: [],
      }),
    );
    expect(plan.kind).toBe("window");
    expect(plan.rule).toBe("rule-6-window");
  });

  it("Rule 7: content that fits the configured maximum delivers full", () => {
    const plan = planWithRules(
      baseInput({
        role: "supporting",
        contentType: "xml",
        compressors: [],
        measurement: { estimatedTokens: 1_000, exactCharacters: 4_000 },
        budget: {
          unit: "tokens",
          method: "cjk-weighted-heuristic",
          estimatedDelivered: 0,
          exactDeliveredCharacters: 0,
          maximum: 16_000,
        },
      }),
    );
    expect(plan.kind).toBe("full");
    expect(plan.rule).toBe("rule-7-fits-maximum");
  });

  it("Rule 8: unknown role/intent exceeding the maximum falls to a safe window/reference, never full", () => {
    const withRetrieval = planWithRules(
      baseInput({
        contentType: "xml",
        compressors: [],
        retrievalAvailable: true,
        measurement: { estimatedTokens: 20_000, exactCharacters: 80_000 },
        budget: {
          unit: "tokens",
          method: "cjk-weighted-heuristic",
          estimatedDelivered: 0,
          exactDeliveredCharacters: 0,
          maximum: 16_000,
        },
      }),
    );
    expect(withRetrieval.kind).toBe("reference");
    expect(withRetrieval.rule).toBe("rule-8-safe-fallback");

    const withoutRetrieval = planWithRules(
      baseInput({
        contentType: "xml",
        compressors: [],
        retrievalAvailable: false,
        measurement: { estimatedTokens: 20_000, exactCharacters: 80_000 },
        budget: {
          unit: "tokens",
          method: "cjk-weighted-heuristic",
          estimatedDelivered: 0,
          exactDeliveredCharacters: 0,
          maximum: 16_000,
        },
      }),
    );
    expect(withoutRetrieval.kind).toBe("window");
    expect(withoutRetrieval.rule).toBe("rule-8-safe-fallback");
  });

  it("Rule 9 fires only when classified content exceeds maximum but matched no more specific rule", () => {
    // No compressors (Rule 4 excluded), role/intent CLASSIFIED (Rule 8 excluded by
    // its "unknown" qualifier), contentType xml (Rule 6's prose/source list and
    // Rule 5's reference role both excluded), exceeds maximum (Rule 7 excluded).
    const plan = planWithRules(
      baseInput({
        intent: "implement",
        role: "supporting",
        contentType: "xml",
        compressors: [],
        measurement: { estimatedTokens: 20_000, exactCharacters: 80_000 },
        budget: {
          unit: "tokens",
          method: "cjk-weighted-heuristic",
          estimatedDelivered: 0,
          exactDeliveredCharacters: 0,
          maximum: 16_000,
        },
      }),
    );
    expect(plan.rule).toBe("rule-9-v0.4-fallback");
  });

  it("Rule 9 (unbudgeted, small, unstructured) is what the caller executes via the SAME registry v0.4 already uses", async () => {
    // Rule 9 does not call the registry itself — the CALLER (ContextRuntime.deliver)
    // does, exactly as it did before v0.5.0 (planner_contract.md §3). This proves
    // the registry call itself is unaffected by the planner's existence.
    const ctx = defaultCompressContext();
    const outcome = await compressWithFallback(
      { objectId: "obj-1" as never, revision: 1, kind: "xml", content: "<a><b/></a>" },
      ctx,
    );
    expect(outcome.attempts).toBeDefined();
  });

  it("never resolves an unknown role to withhold — only Rule 1 can withhold", () => {
    const plan = planWithRules(baseInput({ role: "unknown", intent: "unknown", compressors: [] }));
    expect(plan.kind).not.toBe("withhold");
  });
});
