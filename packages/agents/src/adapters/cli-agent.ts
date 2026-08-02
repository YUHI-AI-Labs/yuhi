/**
 * Foundation CLI adapter (Yuhi v0.3.4).
 *
 * A vendor-neutral {@link AgentAdapter} for any agent launched as a CLI whose
 * working directory IS the prepared repository and whose forwarded args are
 * appended. This is the FOUNDATION the later Claude/Codex-specific adapters build
 * on — it is NOT the Claude/Codex real launch implementation.
 *
 * It reuses Yuhi's existing, audited primitives:
 *   - `lookupOnPath` for detection + executable resolution (no spawn to detect)
 *   - `buildChildEnv` for the minimal, allow-listed child environment (T7)
 *   - `runCommand` for the argv-array spawn (never a shell string, T6)
 */
import type {
  AgentAdapter,
  AgentAvailability,
  AgentDetectOptions,
  AgentLaunchOptions,
  AgentPrepareOptions,
  AgentSession,
  PreparedAgentContext,
  PreparedAgentLaunch,
} from "../adapter.js";
import type { AgentInstructionFile } from "../adapter.js";
import { DEFAULT_DETECT_TIMEOUT_MS } from "../adapter.js";
import type { CliAgentSpec } from "../registry.js";
import { lookupOnPath } from "../which.js";
import { buildChildEnv } from "../env.js";
import { runCommand } from "../run.js";
import {
  buildYuhiInstructionSection,
  instructionFileNameFor,
  mergeInstructionFile,
} from "./instructions.js";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

/** Adapter implementation version — recorded in the Agent Session Manifest. */
export const CLI_AGENT_ADAPTER_VERSION = "0.3.4";

/**
 * Resolve a repo-relative POSIX path to an absolute path that is GUARANTEED to
 * stay inside `root` (THREAT_MODEL: no path traversal / symlink escape out of the
 * prepared repo). Returns null when the target would escape.
 */
function resolveInside(root: string, relpath: string): string | null {
  if (path.isAbsolute(relpath)) return null;
  const normalizedRoot = path.resolve(root);
  const target = path.resolve(normalizedRoot, relpath);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) {
    return null;
  }
  return target;
}

class CliAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly adapterVersion = CLI_AGENT_ADAPTER_VERSION;

  constructor(private readonly spec: CliAgentSpec) {
    this.id = spec.id;
    this.displayName = spec.displayName;
  }

  private installHint(): string {
    const base = `The "${this.spec.command}" CLI was not found on your PATH.`;
    return this.spec.installHintUrl ? `${base} Install it from ${this.spec.installHintUrl}.` : base;
  }

  async detect(options?: AgentDetectOptions): Promise<AgentAvailability> {
    // A SHORT budget so a launch surface never hangs on detection. `lookupOnPath`
    // is a synchronous PATH walk (no spawn), so we simply race it against the budget.
    const timeoutMs = options?.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
    const resolve = new Promise<string | null>((done) => done(lookupOnPath(this.spec.command)));
    const budget = new Promise<null>((done) => {
      const timer = setTimeout(() => done(null), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      options?.signal?.addEventListener("abort", () => done(null), { once: true });
    });
    const executablePath = await Promise.race([resolve, budget]);
    return executablePath
      ? { id: this.id, available: true, executablePath }
      : { id: this.id, available: false, installHint: this.installHint() };
  }

  async prepare(
    context: PreparedAgentContext,
    options?: AgentPrepareOptions,
  ): Promise<PreparedAgentLaunch> {
    const executable = lookupOnPath(this.spec.command);
    const warnings: string[] = [];
    if (!executable) warnings.push(this.installHint());
    // Working directory = the prepared repository. Args are an ARRAY, assembled as
    // [configArgs, forwardedArgs] — never concatenated into a shell string.
    const args = [...(this.spec.configArgs ?? []), ...(options?.forwardedArgs ?? [])];
    const envPassthrough = [
      ...(this.spec.envPassthrough ?? []),
      ...(options?.envPassthrough ?? []),
    ];

    // Generate the agent-specific instruction file INTO the prepared repo,
    // additively and merge-safely. Vendor-neutral agents (no convention) ship none.
    const instructionFiles = await this.writeInstructionFiles(context, warnings);

    return {
      adapterId: this.id,
      contextId: context.contextId,
      workingDirectory: context.workingDirectory,
      executable: executable ?? this.spec.command,
      args,
      instructionFiles,
      envPassthrough,
      warnings,
    };
  }

  /**
   * Write the agent's instruction file(s) into the prepared repository:
   *   - the conventional root file (CLAUDE.md / AGENTS.md), MERGED with any existing
   *     content (never clobbered);
   *   - a clean canonical mirror under `.yuhi/agents/<id>/<file>`.
   *
   * Every write is confined to the prepared directory (path-traversal guarded) and
   * is best-effort: a write failure becomes a warning, never a throw — a failed
   * instruction file must never corrupt the prepared repo or block a launch.
   */
  private async writeInstructionFiles(
    context: PreparedAgentContext,
    warnings: string[],
  ): Promise<AgentInstructionFile[]> {
    const fileName = instructionFileNameFor(this.id);
    if (!fileName) return [];

    const root = path.resolve(context.workingDirectory);
    const section = buildYuhiInstructionSection({
      agentDisplayName: this.displayName,
      contextId: context.contextId,
    });
    const files: AgentInstructionFile[] = [];

    if (!existsSync(root) || !statSync(root).isDirectory()) {
      warnings.push(
        `The prepared workspace directory is not available; skipped writing ${fileName}.`,
      );
      return files;
    }

    // 1) Root instruction file — merge-safe.
    const rootTarget = resolveInside(root, fileName);
    if (rootTarget) {
      try {
        let existing: string | null = null;
        if (existsSync(rootTarget)) existing = await readFile(rootTarget, "utf8");
        const merged = mergeInstructionFile(existing, section);
        await writeFile(rootTarget, merged, { encoding: "utf8", mode: 0o600 });
        files.push({ relpath: fileName, contents: merged });
      } catch {
        warnings.push(`Could not write ${fileName} into the prepared workspace.`);
      }
    } else {
      warnings.push(`Refused to write ${fileName} outside the prepared workspace.`);
    }

    // 2) Canonical mirror under .yuhi/agents/<id>/ — always a clean Yuhi section.
    const mirrorRel = path.posix.join(".yuhi", "agents", this.id, fileName);
    const mirrorTarget = resolveInside(root, mirrorRel);
    if (mirrorTarget) {
      try {
        await mkdir(path.dirname(mirrorTarget), { recursive: true, mode: 0o700 });
        const mirrorContents = `${section.trimEnd()}\n`;
        await writeFile(mirrorTarget, mirrorContents, { encoding: "utf8", mode: 0o600 });
        files.push({ relpath: mirrorRel, contents: mirrorContents });
      } catch {
        /* mirror is a convenience; its absence is not worth a warning */
      }
    }

    return files;
  }

  async launch(plan: PreparedAgentLaunch, options?: AgentLaunchOptions): Promise<AgentSession> {
    const sessionId = options?.sessionId ?? randomUUID();
    const startedAt = options?.startedAt ?? new Date().toISOString();
    const agent = { id: this.id, displayName: this.displayName, adapterVersion: this.adapterVersion };
    const base = {
      sessionId,
      contextId: plan.contextId,
      agent,
      workingDirectory: plan.workingDirectory,
      startedAt,
    };

    if (options?.spawn === false) {
      return { ...base, status: "prepared" };
    }

    // The working directory MUST be an absolute path to an existing directory: the
    // prepared repository. Never spawn into a relative or missing cwd — that is how
    // a launch would escape the prepared copy. Failure returns a clear result and
    // does not throw, so nothing about the prepared or source repo is corrupted.
    if (!path.isAbsolute(plan.workingDirectory) || !existsSync(plan.workingDirectory)) {
      return { ...base, status: "failed" };
    }

    const env = buildChildEnv(plan.envPassthrough as string[]);
    const command = {
      file: plan.executable,
      args: [...plan.args],
      cwd: plan.workingDirectory,
      env,
    };
    const run = options?.runner ?? runCommand;
    try {
      const outcome = await run(command);
      return {
        ...base,
        status: outcome.exitCode === 0 ? "exited" : "failed",
        exitCode: outcome.exitCode,
      };
    } catch {
      return { ...base, status: "failed" };
    }
  }
}

/** Construct the foundation CLI adapter for a vendor-neutral spec. */
export function createCliAgentAdapter(spec: CliAgentSpec): AgentAdapter {
  return new CliAgentAdapter(spec);
}
