import {
  ACTION_RANK,
  mostRestrictive,
  type Action,
  type Destination,
  type FileDecision,
  type PolicyEvaluation,
  type PolicyInput,
  type PolicyRule,
  ACTIONS,
} from "@yuhi/shared";
import { compileRule, ruleMatches, type MatchableFile, type CompiledRule } from "./match.js";

function defaultDestinations(action: Action): Destination[] {
  switch (action) {
    case "allow":
    case "redact":
    case "prepare-locally":
    case "metadata-only":
    case "summarize-local":
      return ["external", "local"];
    case "local-only":
      return ["local"];
    case "inject":
    case "block":
    case "ask":
      return [];
  }
}

function emptyByAction(): Record<Action, FileDecision[]> {
  const out = {} as Record<Action, FileDecision[]>;
  for (const a of ACTIONS) out[a] = [];
  return out;
}

/**
 * Resolve one FileDecision per file using most-restrictive-wins precedence
 * (ADR-0003). Detector findings escalate a file to at least `redact`. `ask`
 * degrades to `block` when non-interactive.
 */
export function resolvePolicy(input: PolicyInput, files: MatchableFile[]): PolicyEvaluation {
  const compiled: CompiledRule[] = input.rules.map(compileRule);
  const decisions: FileDecision[] = [];

  for (const file of files) {
    let action: Action = input.defaultAction;
    let winningRule = "default";
    let reason = `Default action (${input.defaultAction}).`;
    let winningDestinations: Destination[] | undefined;
    let winningProcessors: PolicyRule["processors"];

    for (const c of compiled) {
      const m = ruleMatches(c, file);
      if (!m.matched) continue;
      const candidate = c.rule.action;
      const next = mostRestrictive(action, candidate);
      // Update the winner when this rule is strictly more restrictive, or when it
      // matches at the same restrictiveness as the current default (first explicit wins).
      if (ACTION_RANK[candidate] >= ACTION_RANK[action] && candidate === next) {
        if (ACTION_RANK[candidate] > ACTION_RANK[action] || winningRule === "default") {
          winningRule = c.rule.name;
          reason =
            c.rule.reason ?? `Matched rule "${c.rule.name}" via ${m.via} → ${candidate}.`;
          winningDestinations = c.rule.destinations;
          winningProcessors = c.rule.processors;
        }
      }
      action = next;
    }

    // Detector escalation: any finding forces at least `redact`.
    if (file.findings.length > 0 && ACTION_RANK[action] < ACTION_RANK["redact"]) {
      action = "redact";
      const ids = [...new Set(file.findings.map((f) => f.detector))].join(",");
      winningRule = `detector:${ids}`;
      reason = `Secret-like content detected (${ids}); masked in the copy.`;
      winningDestinations = undefined;
    }

    // `ask` degrades to `block` when we cannot prompt.
    if (action === "ask" && !input.interactive) {
      action = "block";
      reason = `${reason} Resolved to block (non-interactive).`;
      winningRule = winningRule === "default" ? "ask→block" : winningRule;
    }

    decisions.push({
      relpath: file.relpath,
      action,
      ruleName: winningRule,
      reason,
      destinations: winningDestinations ?? defaultDestinations(action),
      findings: file.findings,
      ...(action === "prepare-locally" && winningProcessors ? { processors: winningProcessors } : {}),
    });
  }

  const byAction = emptyByAction();
  for (const d of decisions) byAction[d.action].push(d);

  return { decisions, byAction };
}

/** Explain a single path by resolving just that file. */
export function explainFile(
  input: PolicyInput,
  file: MatchableFile,
): FileDecision {
  return resolvePolicy(input, [file]).decisions[0]!;
}
