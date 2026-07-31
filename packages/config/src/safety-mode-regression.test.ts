import { describe, it, expect } from "vitest";
import { defaultConfig, renderConfigYaml } from "./defaults.js";
import { parseConfig } from "./load.js";
import { resolveSafetyMode } from "./safety-mode.js";

/**
 * Regression guard for the config↔core cycle fix (v0.3.2): the Safety Mode vocabulary
 * lives in @yuhi/shared, so @yuhi/config no longer imports @yuhi/core. If the cycle
 * ever returns, module init can observe `DEFAULT_PREPARE_SAFETY_MODE` as undefined and
 * the schema's `.default("balanced")` collapses into a Required field — these tests
 * would catch that, plus the backward-compat contract for older config files.
 */
describe("Safety Mode config — cycle-free init + backward compatibility", () => {
  it("the config package initializes without a circular-init error and defaults to balanced", () => {
    // These calls exercise module init + the resolved default. A regressed cycle would
    // surface here as an undefined default or a thrown init error.
    expect(resolveSafetyMode()).toBe("balanced");
    expect(defaultConfig("synthetic").safetyMode).toBe("balanced");
  });

  it("renderConfigYaml() output round-trips through parseConfig()", () => {
    const yaml = renderConfigYaml("synthetic");
    expect(parseConfig(yaml, "yuhi.yaml").safetyMode).toBe("balanced");
  });

  it("a config WITHOUT safetyMode loads as balanced (older yuhi.yaml stays valid)", () => {
    const yaml = renderConfigYaml("synthetic")
      .split("\n")
      .filter((line) => !line.trim().startsWith("safetyMode"))
      .join("\n");
    expect(yaml).not.toContain("safetyMode");
    expect(parseConfig(yaml, "yuhi.yaml").safetyMode).toBe("balanced");
  });

  it("an invalid safetyMode is a validation error (never a silent fallback)", () => {
    const yaml = renderConfigYaml("synthetic").replace("safetyMode: balanced", "safetyMode: private");
    expect(() => parseConfig(yaml, "yuhi.yaml")).toThrow();
  });
});
