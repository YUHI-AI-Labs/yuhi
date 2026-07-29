import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { parseDotenv } from "@yuhi/processors";
import type { Plan } from "./plan.js";

export interface InjectedEnv {
  /** Variable name → value, to add to the agent's process environment. */
  vars: Record<string, string>;
  /** Files the values came from (repo-relative). */
  sources: string[];
  /** Variable names only (safe to log/display — never the values). */
  keys: string[];
}

/**
 * Gather values for the "Runtime only" route: files with action `inject` are
 * parsed (as .env) and their values are returned to be injected into the agent's
 * process environment. The FILES are never copied into the context the agent
 * reads — only the running program receives the values. Values are never logged.
 */
export function collectInjectedEnv(plan: Plan): InjectedEnv {
  const vars: Record<string, string> = {};
  const sources: string[] = [];
  for (const d of plan.evaluation.decisions) {
    if (d.action !== "inject") continue;
    const abs = path.join(plan.context.root, d.relpath);
    try {
      if (!lstatSync(abs).isFile()) continue;
      Object.assign(vars, parseDotenv(readFileSync(abs, "utf8")));
      sources.push(d.relpath);
    } catch {
      /* unreadable — skip */
    }
  }
  return { vars, sources, keys: Object.keys(vars) };
}
