/**
 * Launching the isolated window, and installing the official extension into its profile.
 *
 * Two things the feasibility probe made non-negotiable:
 *
 * 1. **`--profile` alone does not isolate, and it does not carry extensions.** A profile
 *    created by the CLI starts with no extensions at all, so `--extensions-dir` pointing at
 *    a directory containing the extension is NOT enough — the extension host will not load
 *    it. Isolation comes from `--user-data-dir` + `--extensions-dir`; the profile is for the
 *    settings scope and the visual identity.
 * 2. **The install must go through the VS Code CLI.** Copying an unpacked extension
 *    directory looks like it works and then silently does not, and hand-writing VS Code's
 *    per-profile extension bookkeeping would be guessing at an internal format.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { OFFICIAL_EXTENSION_ID, type ExtensionManifest } from "./extension-contract.js";
import type { NativeGuiEnvironment } from "./types.js";

export interface ProcessRunner {
  run(input: {
    file: string;
    args: readonly string[];
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Start and do not wait. Returns the child pid when the OS gave us one. */
  spawnDetached(input: { file: string; args: readonly string[]; env?: Record<string, string> }): { pid: number | undefined };
}

export const nodeProcessRunner: ProcessRunner = {
  run: (input) =>
    new Promise((resolve, reject) => {
      const child = spawn(input.file, [...input.args], {
        env: input.env ? { ...process.env, ...input.env } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      const timer = input.timeoutMs
        ? setTimeout(() => {
            child.kill("SIGKILL");
          }, input.timeoutMs)
        : undefined;
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    }),
  spawnDetached: (input) => {
    const child = spawn(input.file, [...input.args], {
      env: input.env ? { ...process.env, ...input.env } : process.env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    return { pid: child.pid };
  },
};

export const YUHI_PROFILE_NAME = "Yuhi Dynamic";
/** Distinct enough from the default title bar to be unmistakable at a glance. */
export const YUHI_TITLE_BAR_ACCENT = "#1F3A5F";

export interface IsolationPaths {
  readonly userDataDir: string;
  readonly extensionsDir: string;
  readonly profileName: string;
}

function isolationArgs(paths: IsolationPaths): string[] {
  return [
    "--user-data-dir",
    paths.userDataDir,
    "--extensions-dir",
    paths.extensionsDir,
    "--profile",
    paths.profileName,
  ];
}

/** Read the manifest of the extension as installed in the ISOLATED directory. */
export async function readIsolatedManifest(
  extensionsDir: string,
  lister: (dir: string) => Promise<readonly string[]>,
): Promise<ExtensionManifest | undefined> {
  const entries = await lister(extensionsDir).catch(() => [] as readonly string[]);
  const match = entries.find((name) => name.toLowerCase().startsWith(OFFICIAL_EXTENSION_ID.toLowerCase()));
  if (!match) return undefined;
  try {
    return JSON.parse(await readFile(join(extensionsDir, match, "package.json"), "utf8")) as ExtensionManifest;
  } catch {
    return undefined;
  }
}

export async function listInstalledExtensions(
  runner: ProcessRunner,
  executable: string,
  paths: IsolationPaths,
): Promise<readonly string[]> {
  const result = await runner.run({
    file: executable,
    args: [...isolationArgs(paths), "--list-extensions", "--show-versions"],
    timeoutMs: 60_000,
  });
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes("."));
}

export interface InstallResult {
  readonly ok: boolean;
  readonly installedVersion: string | undefined;
  readonly output: string;
}

/**
 * Install the official extension into the isolated profile.
 *
 * A version is requested when the caller pins one, which keeps a Native GUI session on the
 * build the contract was validated against instead of whatever happens to be latest.
 */
export async function installOfficialExtension(
  runner: ProcessRunner,
  executable: string,
  paths: IsolationPaths,
  version?: string,
): Promise<InstallResult> {
  const target = version ? `${OFFICIAL_EXTENSION_ID}@${version}` : OFFICIAL_EXTENSION_ID;
  const result = await runner.run({
    file: executable,
    args: [...isolationArgs(paths), "--install-extension", target, "--force"],
    timeoutMs: 300_000,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code !== 0) return { ok: false, installedVersion: undefined, output };

  const installed = await listInstalledExtensions(runner, executable, paths);
  const line = installed.find((e) => e.toLowerCase().startsWith(`${OFFICIAL_EXTENSION_ID.toLowerCase()}@`));
  return { ok: line !== undefined, installedVersion: line?.split("@")[1], output };
}

export interface LaunchInput extends IsolationPaths {
  readonly executable: string;
  readonly preparedWorkspace: string;
  /**
   * Fallback path only. The primary integration writes the endpoint into the profile's
   * `claudeCode.environmentVariables`, so this stays undefined and the isolated window
   * inherits nothing Yuhi-specific.
   */
  readonly processEnvFallback?: NativeGuiEnvironment;
}

export function buildLaunchArgs(input: LaunchInput): string[] {
  return ["--new-window", ...isolationArgs(input), input.preparedWorkspace];
}

export function launchIsolatedWindow(runner: ProcessRunner, input: LaunchInput): { pid: number | undefined } {
  const env = input.processEnvFallback ? { ...(input.processEnvFallback as unknown as Record<string, string>) } : undefined;
  return runner.spawnDetached({
    file: input.executable,
    args: buildLaunchArgs(input),
    ...(env ? { env } : {}),
  });
}

/** Ask an already-running isolated instance to focus its window, without opening a new one. */
export async function focusIsolatedWindow(
  runner: ProcessRunner,
  input: { executable: string; preparedWorkspace: string } & IsolationPaths,
): Promise<void> {
  await runner.run({
    file: input.executable,
    args: [...isolationArgs(input), "--reuse-window", input.preparedWorkspace],
    timeoutMs: 30_000,
  });
}

export async function readVsCodeVersion(runner: ProcessRunner, executable: string): Promise<string | undefined> {
  try {
    const result = await runner.run({ file: executable, args: ["--version"], timeoutMs: 30_000 });
    return result.stdout.split("\n")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}
