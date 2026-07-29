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
  fileCapabilities,
  processorSupported,
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

    const sensitiveTabularData = file.findings.some(
      (finding) => finding.detector.startsWith("tabular-"),
    );
    const tabularDirectIdentifiers = file.findings.some(
      (finding) => finding.detector === "tabular-direct-identifier-column",
    );
    const registeredCapabilities = fileCapabilities(file.relpath);
    const capabilities = file.inspection ?? {
      ...registeredCapabilities,
      inspectionAttempted: registeredCapabilities.parserAvailable,
      inspectionSucceeded: registeredCapabilities.parserAvailable,
      contentVerified: registeredCapabilities.parserAvailable,
    };

    // An unavailable parser is a final local-only route, not an `allow` that a
    // later binary check silently discards. Likewise, never select a processor
    // that cannot accept and verify this file type.
    if (
      !capabilities.parserAvailable ||
      !capabilities.scannerAvailable ||
      !capabilities.contentVerified
    ) {
      if (action !== "block") {
        action = "local-only";
        winningRule = capabilities.parserAvailable
          ? `file-type:${capabilities.fileType}-inspection-incomplete`
          : `file-type:${capabilities.fileType}-inspection-unavailable`;
        reason =
          capabilities.fileType === "xlsx" && sensitiveTabularData
            ? "Restricted workbook kept local because verified local inspection and transformation are unavailable."
            : capabilities.parserAvailable
              ? "File kept local because content inspection did not complete."
              : `File kept local because verified local ${capabilities.fileType.toUpperCase()} inspection is unavailable.`;
        winningDestinations = ["local"];
      }
      winningProcessors = undefined;
    } else if (
      winningProcessors?.some((processor) => !processorSupported(capabilities, processor))
    ) {
      action = "local-only";
      winningRule = `file-type:${capabilities.fileType}-transformation-unavailable`;
      reason = "File kept local because the selected transformation cannot be executed and verified for this file type.";
      winningDestinations = ["local"];
      winningProcessors = undefined;

    // A raw allow is never a safe outcome for detected tabular personal data.
    // Explicit safe transformations remain authoritative. Otherwise Yuhi
    // attempts a deterministic schema-aware transform and verifies its output.
    } else if (sensitiveTabularData && (winningRule === "default" || action === "allow")) {
      action = "prepare-locally";
      winningRule = tabularDirectIdentifiers
        ? "detector:tabular-auto-pseudonymize"
        : "detector:tabular-auto-aggregate";
      reason = tabularDirectIdentifiers
        ? "Sensitive tabular data detected; direct identifiers will be pseudonymized locally and the exact output rescanned."
        : "Sensitive associated tabular data detected; individual rows will be aggregated locally and the exact output rescanned.";
      winningDestinations = ["external", "local"];
      winningProcessors = tabularDirectIdentifiers
        ? ["pseudonymize-student-records", "safety-check"]
        : ["aggregate-student-records", "safety-check"];
    // Other detector findings force at least `redact`.
    } else if (
      file.findings.length > 0 &&
      winningRule === "default" &&
      ACTION_RANK[action] < ACTION_RANK["redact"]
    ) {
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
