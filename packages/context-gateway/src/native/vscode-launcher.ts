/**
 * Launching the isolated window, and installing the official extension into its profile.
 *
 * Two things the feasibility probe and the first real launch made non-negotiable:
 *
 * 1. **Isolation is `--user-data-dir` + `--extensions-dir`.** See `isolationArgs` for why
 *    `--profile` is not used at all.
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

/**
 * Isolation is `--user-data-dir` + `--extensions-dir`, and deliberately NOT `--profile`.
 *
 * A named profile adds nothing here — the user-data-dir is already Yuhi's own, so its
 * default profile is private by construction — and it actively breaks two things:
 * `--install-extension --profile X` fails with "Profile 'X' not found" before the profile
 * has ever been created, and a CLI-created profile starts with no extensions, so the
 * extension host would load nothing. The window is instead made visually distinct through
 * `workbench.colorCustomizations`, which is a setting we already own in that directory.
 */
function isolationArgs(paths: IsolationPaths): string[] {
  return ["--user-data-dir", paths.userDataDir, "--extensions-dir", paths.extensionsDir];
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
 * Install the official extension into the isolated extensions directory.
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

/**
 * `--disable-workspace-trust` is required, not cosmetic.
 *
 * A fresh `--user-data-dir` has trusted nothing, so the window opens in Restricted Mode, and
 * Restricted Mode DISABLES every extension that does not declare untrusted-workspace support
 * — including the official Claude extension and Yuhi itself. Without this the session starts
 * a gateway, opens a window, and then silently loads neither extension.
 *
 * The scope is narrow enough to be defensible: this flag applies only to the isolated window
 * Yuhi created, opening a Prepared Workspace Yuhi itself produced. The user's normal window
 * and its trust decisions are untouched.
 */
export function buildLaunchArgs(input: LaunchInput): string[] {
  return ["--new-window", ...isolationArgs(input), "--disable-workspace-trust", input.preparedWorkspace];
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
    args: [...isolationArgs(input), "--disable-workspace-trust", "--reuse-window", input.preparedWorkspace],
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

/** Marketplace identity of the Yuhi extension itself. */
/**
 * Marketplace identity of the Yuhi extension.
 *
 * Was `yuhi-ai-labs.yuhi-vscode` through 0.4.3. That listing was removed from the
 * Marketplace, and a removed extension name is permanently reserved — "cannot be
 * reused, even by the original publisher" — so the old id can never serve a release
 * again. 0.4.4 moves to a new id; every consumer must read it from HERE rather than
 * hardcoding a literal, which is what made this a three-site change.
 */
export const YUHI_EXTENSION_ID = "yuhi-ai-labs.yuhi-code";

/**
 * Install Yuhi into the isolated directory as well as Claude.
 *
 * Without this the isolated window has no Yuhi extension, so nothing attaches to the broker
 * and nothing opens the official panel — the session would start a gateway and then sit
 * there. `ref` is either a marketplace id (production) or a path to a `.vsix` (development
 * and E2E, where the build under test is not the published one).
 */
export async function installYuhiExtension(
  runner: ProcessRunner,
  executable: string,
  paths: IsolationPaths,
  ref: string = YUHI_EXTENSION_ID,
): Promise<InstallResult> {
  const attempt = async (target: string): Promise<{ code: number | null; output: string }> => {
    const r = await runner.run({
      file: executable,
      args: [...isolationArgs(paths), "--install-extension", target, "--force"],
      timeoutMs: 300_000,
    });
    return { code: r.code, output: `${r.stdout}\n${r.stderr}`.trim() };
  };

  let result = await attempt(ref);
  // A pinned version that is not on the marketplace yet (the build is newer than the
  // published one) must not leave the isolated window with no Yuhi at all. Fall back to
  // whatever is published and let the version check below report what actually landed.
  if (result.code !== 0 && ref.includes("@") && !ref.toLowerCase().endsWith(".vsix")) {
    result = await attempt(ref.split("@")[0] ?? YUHI_EXTENSION_ID);
  }
  if (result.code !== 0) return { ok: false, installedVersion: undefined, output: result.output };

  const installed = await listInstalledExtensions(runner, executable, paths);
  const line = installed.find((e) => e.toLowerCase().startsWith(`${YUHI_EXTENSION_ID}@`));
  return { ok: line !== undefined, installedVersion: line?.split("@")[1], output: result.output };
}

/**
 * The isolated window needs a Yuhi that knows about Native GUI Mode.
 *
 * An older published build has no attach client and no Claude adapter, so the session would
 * start a gateway, open a window, and then sit at `vscode-attaching` forever with no
 * explanation. Comparing versions turns that into a sentence the user can act on.
 */
export const NATIVE_GUI_MIN_YUHI_VERSION = "0.4.1";

export function yuhiVersionSupportsNativeGui(version: string | undefined): boolean {
  if (!version) return false;
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  const min = NATIVE_GUI_MIN_YUHI_VERSION.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}
