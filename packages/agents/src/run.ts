import { spawn } from "node:child_process";
import type { AgentCommand } from "@yuhi/shared";

export interface RunResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
}

/**
 * Run an agent command as a child process. Uses spawn with an argv array (NEVER
 * a shell string — THREAT_MODEL T6) and inherits stdio so the agent's interactive
 * TUI works. The child's environment is exactly `command.env` (see buildChildEnv).
 */
export function runCommand(command: AgentCommand): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: "inherit",
      shell: false,
      windowsHide: false,
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      resolve({ exitCode: code ?? (signal ? 1 : 0), signal });
    });
  });
}
