import { describe, expect, it } from "vitest";
import { yuhiConfigSchema } from "./schema.js";

const base = { version: "1" as const };

describe("context.runtimeBudget config field (v0.5.0)", () => {
  it("is entirely absent when the field is omitted — no numeric default is injected", () => {
    const cfg = yuhiConfigSchema.parse({ ...base });
    expect(cfg.context).toBeUndefined();
  });

  it("parses an explicit target/maximum", () => {
    const cfg = yuhiConfigSchema.parse({ ...base, context: { runtimeBudget: { target: 8000, maximum: 16000 } } });
    expect(cfg.context?.runtimeBudget).toEqual({ target: 8000, maximum: 16000 });
  });

  it("allows target or maximum independently", () => {
    const targetOnly = yuhiConfigSchema.parse({ ...base, context: { runtimeBudget: { target: 4000 } } });
    expect(targetOnly.context?.runtimeBudget).toEqual({ target: 4000 });

    const maximumOnly = yuhiConfigSchema.parse({ ...base, context: { runtimeBudget: { maximum: 20000 } } });
    expect(maximumOnly.context?.runtimeBudget).toEqual({ maximum: 20000 });
  });

  it("rejects a non-positive target or maximum", () => {
    expect(yuhiConfigSchema.safeParse({ ...base, context: { runtimeBudget: { target: 0 } } }).success).toBe(false);
    expect(yuhiConfigSchema.safeParse({ ...base, context: { runtimeBudget: { maximum: -1 } } }).success).toBe(false);
  });
});
