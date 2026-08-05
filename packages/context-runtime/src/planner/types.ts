/**
 * v0.5.0 Planner contract (docs/design/0.5.0_planner_contract.md).
 *
 * The Planner decides WHICH existing compressor/window/reference/reuse path runs;
 * it never rewrites content itself. Every type here is either a closed enum or a
 * safe (non-content) string — nothing in this file can carry raw bytes, matching
 * the same private/public metadata discipline `event.ts` already enforces.
 */

import type { ContentKind, ObjectId } from "@yuhi/context-store";
import type { PrivacyMode, SecretDeliveryMode } from "@yuhi/shared";

import type { Compressor } from "@yuhi/context-compression";
import type { ToolName } from "../event.js";

/** Coarse, deterministically-inferred task intent. Never guessed by a model. */
export type ContextIntent =
  | "debug"
  | "implement"
  | "test-failure"
  | "search"
  | "data-analysis"
  | "document-analysis"
  | "refactor"
  | "unknown";

/** The content's role in the CURRENT task, not merely its content type. */
export type ContextRole =
  | "load-bearing"
  | "supporting"
  | "reference"
  | "repeated"
  | "generated-noise"
  | "unknown";

/**
 * `"summary"` is deliberately absent from the directive's literal union — see
 * `0.5.0_dynamic_generation.md` §3. A deterministic summary is executed as a
 * `structured` plan via the existing JSON/test-output compressors; there is no
 * separate summary executor in v0.5.0.
 */
export type ContextPlanKind = "full" | "structured" | "window" | "reference" | "reuse" | "withhold";

export type ContextPlanReason =
  | "fits-budget"
  | "load-bearing"
  | "structured-representation"
  | "budget-pressure"
  | "already-delivered"
  | "retrievable-later"
  | "generated-noise"
  | "privacy-failure"
  | "verification-failure"
  | "unknown";

export type PlanConfidence = "high" | "medium" | "low";

/** A retrievable range the plan chose to omit, expressed in the existing locator grammar. */
export interface ContextRange {
  readonly locator: string;
  readonly kind: string;
}

export interface ContextMeasurement {
  readonly estimatedTokens: number;
  readonly exactCharacters: number;
}

export interface ContextPlan {
  readonly kind: ContextPlanKind;
  readonly reason: ContextPlanReason;

  /** `compressorId@version` when `kind` is `structured`/`window`; absent otherwise. */
  readonly strategyId?: string;
  readonly ranges?: readonly ContextRange[];
  readonly reuseObjectId?: string;
  readonly retrievalLocators?: readonly string[];

  readonly estimatedBefore: ContextMeasurement;
  readonly estimatedAfter?: ContextMeasurement;

  readonly confidence: PlanConfidence;

  /** Which Rule (1-9, see planner_contract.md §3) produced this plan. Explainability only. */
  readonly rule: PlannerRuleId;
}

export type PlannerRuleId =
  | "rule-1-privacy-failure"
  | "rule-2-reuse"
  | "rule-3-small-load-bearing"
  | "rule-4-structured"
  | "rule-5-reference"
  | "rule-6-window"
  | "rule-7-fits-maximum"
  | "rule-8-safe-fallback"
  | "rule-9-v0.4-fallback";

/** `"off"` never constructs a `PlannerInput` at all — a zero-overhead escape hatch. */
export type GenerationMode = "off" | "observe" | "active";

export interface CompressorCapability {
  readonly id: string;
  readonly version: string;
  readonly supportsKind: (kind: ContentKind) => boolean;
}

export function capabilitiesOf(compressors: readonly Compressor[]): CompressorCapability[] {
  return compressors.map((c) => ({
    id: c.id,
    version: c.version,
    supportsKind: (kind: ContentKind) => c.supports(kind, { text: "", bytes: 0, truncated: false }),
  }));
}

/** Session-scoped record of an already-delivered representation. Never raw content. */
export interface PriorDelivery {
  readonly objectId: string;
  readonly revision: number;
  readonly representationId: string;
  readonly deliveredHash: string;
  readonly planKind: ContextPlanKind;
  readonly strategyId?: string;
  readonly estimatedTokens: number;
  readonly exactCharacters: number;
  readonly deliveredAtTurn: number;
}

export interface RuntimeBudgetState {
  readonly target?: number;
  readonly maximum?: number;
  readonly unit: "tokens";
  readonly method: string;
  readonly estimatedDelivered: number;
  readonly estimatedRemaining?: number;
  readonly exactDeliveredCharacters: number;
}

export interface PlannerInput {
  readonly intent: ContextIntent;
  readonly role: ContextRole;
  readonly contentType: ContentKind;
  readonly objectId: ObjectId | string;
  readonly revision: number;

  readonly measurement: ContextMeasurement;
  readonly budget?: RuntimeBudgetState;
  readonly priorDeliveries: readonly PriorDelivery[];

  readonly retrievalAvailable: boolean;
  readonly compressors: readonly CompressorCapability[];
  readonly privacyMode: PrivacyMode;
  readonly secretDeliveryMode: SecretDeliveryMode;

  /** Computed by the runtime BEFORE the planner runs (privacy/secret scan already ran). */
  readonly privacyOrSecurityFailure: boolean;

  readonly tool: ToolName;
}

export interface DynamicContextPlanner {
  plan(input: PlannerInput): ContextPlan;
}
