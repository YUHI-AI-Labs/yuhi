import picomatch from "picomatch";
import type { PolicyRule, ScanFinding } from "@yuhi/shared";

export interface MatchableFile {
  /** repo-relative POSIX path */
  relpath: string;
  findings: ScanFinding[];
}

/** Precompiled matcher for a rule (path globs + detector set). */
export interface CompiledRule {
  rule: PolicyRule;
  pathMatch?: (p: string) => boolean;
  detectors?: Set<string>;
}

export function compileRule(rule: PolicyRule): CompiledRule {
  const compiled: CompiledRule = { rule };
  const paths = rule.match.paths ?? [];
  if (paths.length > 0) {
    // gitignore-style exceptions: patterns starting with "!" are negations that
    // carve exceptions out of the positive set. (picomatch's own array handling
    // does not do cross-pattern negation, so we implement it explicitly.)
    const positives = paths.filter((p) => !p.startsWith("!"));
    const negatives = paths.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
    const posMatch = positives.length > 0 ? picomatch(positives, { dot: true }) : () => false;
    const negMatch = negatives.length > 0 ? picomatch(negatives, { dot: true }) : null;
    compiled.pathMatch = (p: string) => posMatch(p) && !(negMatch !== null && negMatch(p));
  }
  if (rule.match.detectors && rule.match.detectors.length > 0) {
    compiled.detectors = new Set(rule.match.detectors);
  }
  return compiled;
}

/** Does a compiled rule match this file? Returns why (path/detector) for reasons. */
export function ruleMatches(
  compiled: CompiledRule,
  file: MatchableFile,
): { matched: boolean; via: "path" | "detector" | null } {
  if (compiled.pathMatch && compiled.pathMatch(file.relpath)) {
    return { matched: true, via: "path" };
  }
  if (compiled.detectors) {
    for (const f of file.findings) {
      if (compiled.detectors.has(f.detector)) return { matched: true, via: "detector" };
    }
  }
  return { matched: false, via: null };
}
