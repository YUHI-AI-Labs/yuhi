import type { Action, Destination } from "./actions.js";
import type { ProcessorSpec } from "./processors.js";

/** Structural rule shape consumed by the policy engine (mirrors config's Rule). */
export interface PolicyRuleMatch {
  paths?: string[];
  detectors?: string[];
}

export interface PolicyRule {
  name: string;
  match: PolicyRuleMatch;
  action: Action;
  reason?: string;
  destinations?: Destination[];
  /** For the `prepare-locally` route: the RouteExecutor pipeline to run. */
  processors?: ProcessorSpec[];
}

export interface PolicyInput {
  defaultAction: Action;
  rules: PolicyRule[];
  /** When false (non-interactive), `ask` resolves to `block`. */
  interactive: boolean;
}
