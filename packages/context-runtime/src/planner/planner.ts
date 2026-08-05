import { planWithRules } from "./rules.js";
import type { ContextPlan, DynamicContextPlanner, PlannerInput } from "./types.js";

/** The v1 deterministic planner (planner_contract.md §3). No model call, ever. */
export class DeterministicPlanner implements DynamicContextPlanner {
  plan(input: PlannerInput): ContextPlan {
    return planWithRules(input);
  }
}

export const defaultPlanner: DynamicContextPlanner = new DeterministicPlanner();
