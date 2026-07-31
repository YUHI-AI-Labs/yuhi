import { describe, expect, it } from "vitest";
import { yuhiConfigSchema } from "./schema.js";
import { parseConfig } from "./load.js";
import { resolveSafetyMode } from "./safety-mode.js";

const base = { version: "1" as const };

describe("safetyMode config field", () => {
  it("defaults to balanced when the field is absent", () => {
    const cfg = yuhiConfigSchema.parse({ ...base });
    expect(cfg.safetyMode).toBe("balanced");
  });

  it.each(["balanced", "strict", "maximum-privacy"] as const)(
    "parses the explicit value %s",
    (mode) => {
      const cfg = yuhiConfigSchema.parse({ ...base, safetyMode: mode });
      expect(cfg.safetyMode).toBe(mode);
    },
  );

  it("rejects an invalid value with a schema validation error", () => {
    const result = yuhiConfigSchema.safeParse({ ...base, safetyMode: "private" });
    expect(result.success).toBe(false);
  });

  it("still loads an old config file that predates the field (→ balanced)", () => {
    // A yuhi.yaml written before v0.3.2 has no `safetyMode` key at all.
    const legacy = ['version: "1"', "project:", "  name: legacy", "workspace:", "  mode: copy"].join(
      "\n",
    );
    const cfg = parseConfig(legacy, "yuhi.yaml");
    expect(cfg.safetyMode).toBe("balanced");
  });
});

describe("resolveSafetyMode", () => {
  it("prefers CLI over repo over user over the balanced default", () => {
    expect(
      resolveSafetyMode({ cli: "strict", repo: "maximum-privacy", user: "balanced" }),
    ).toBe("strict");
    expect(resolveSafetyMode({ repo: "maximum-privacy", user: "balanced" })).toBe(
      "maximum-privacy",
    );
    expect(resolveSafetyMode({ user: "strict" })).toBe("strict");
    expect(resolveSafetyMode({})).toBe("balanced");
  });

  it("falls through invalid lower-priority values to the next valid source", () => {
    expect(resolveSafetyMode({ repo: "nonsense", user: "strict" })).toBe("strict");
    expect(resolveSafetyMode({ repo: "nonsense", user: 123 })).toBe("balanced");
  });

  it("ignores an invalid CLI value and falls through (the caller rejects it)", () => {
    expect(resolveSafetyMode({ cli: "private", repo: "strict" })).toBe("strict");
  });
});
