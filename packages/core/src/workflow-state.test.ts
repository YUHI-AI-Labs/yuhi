import { describe, expect, it } from "vitest";
import { deriveWorkflowState } from "./workflow-state.js";

describe("shared Yuhi workflow state", () => {
  it.each([
    [{}, "ORIGINAL_WORKSPACE"],
    [{ preparing: true }, "PREPARING"],
    [{ preparationStatus: "Success", launchAllowed: true }, "READY"],
    [{ preparationStatus: "Partial", launchAllowed: false }, "RECOVERY_REQUIRED"],
    [{ preparationStatus: "Failed", launchAllowed: false }, "RECOVERY_REQUIRED"],
    [{ agentStarted: true }, "AGENT_RUNNING"],
    [{ agentStarted: true, changedFileCount: 2 }, "CHANGES_DETECTED"],
    [{ changedFileCount: 2, reviewingChanges: true }, "REVIEW_CHANGES"],
    [{ applyResult: "applied" }, "COMPLETED"],
  ] as const)("derives %s", (input, expected) => {
    expect(deriveWorkflowState(input)).toBe(expected);
  });
});
