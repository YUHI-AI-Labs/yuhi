export type YuhiWorkflowState =
  | "ORIGINAL_WORKSPACE"
  | "PREPARING"
  | "RECOVERY_REQUIRED"
  | "READY"
  | "AGENT_RUNNING"
  | "CHANGES_DETECTED"
  | "REVIEW_CHANGES"
  | "COMPLETED";

export interface WorkflowStateInput {
  preparationStatus?: "Success" | "Partial" | "Failed";
  launchAllowed?: boolean;
  agentStarted?: boolean;
  changedFileCount?: number;
  reviewingChanges?: boolean;
  applyResult?: "applied" | "blocked" | "cancelled" | "failed-restored" | "recovery-required";
  preparing?: boolean;
}

/** Shared, presentation-neutral lifecycle used by CLI and VS Code. */
export function deriveWorkflowState(input: WorkflowStateInput): YuhiWorkflowState {
  if (input.applyResult === "applied") return "COMPLETED";
  if (input.applyResult === "recovery-required" || input.applyResult === "blocked") {
    return "RECOVERY_REQUIRED";
  }
  if (input.reviewingChanges) return "REVIEW_CHANGES";
  if ((input.changedFileCount ?? 0) > 0) return "CHANGES_DETECTED";
  if (input.agentStarted) return "AGENT_RUNNING";
  if (
    input.preparationStatus === "Partial" ||
    input.preparationStatus === "Failed" ||
    input.launchAllowed === false
  ) return "RECOVERY_REQUIRED";
  if (input.preparationStatus === "Success" && input.launchAllowed === true) return "READY";
  if (input.preparing) return "PREPARING";
  return "ORIGINAL_WORKSPACE";
}
