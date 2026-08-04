/**
 * Finding a VS Code executable to launch the isolated window with.
 *
 * The order is the same everywhere: an explicitly configured path first (the user's choice
 * outranks discovery), then the `code` CLI, then platform install locations, then Insiders,
 * then ask. Nothing here guesses a path that does not exist on disk — a resolver that
 * returns a plausible-but-wrong executable turns into "VS Code launch failed" three steps
 * later, which is a much worse error to debug.
 *
 * Remote environments are detected and refused rather than half-supported: a local
 * `--user-data-dir` handed to a Remote-SSH or WSL window would isolate nothing, because the
 * `claude` child runs on the far side.
 */

import { access, constants } from "node:fs/promises";
import { join } from "node:path";

export type VsCodeChannel = "stable" | "insiders";

export interface VsCodeCandidate {
  readonly executable: string;
  readonly channel: VsCodeChannel;
  readonly source: "configured" | "path" | "install-location";
}

export interface ResolverEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Record<string, string | undefined>;
  readonly exists: (p: string) => Promise<boolean>;
  /** Resolve a bare command on PATH. Returns undefined when absent. */
  readonly which: (cmd: string) => Promise<string | undefined>;
  readonly home: string;
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** macOS/Linux app-bundle and package install locations, in preference order. */
function installLocations(env: ResolverEnvironment): readonly { path: string; channel: VsCodeChannel }[] {
  if (env.platform === "darwin") {
    return [
      { path: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", channel: "stable" },
      { path: join(env.home, "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"), channel: "stable" },
      {
        path: "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
        channel: "insiders",
      },
    ];
  }
  if (env.platform === "win32") {
    const programFiles = env.env["ProgramFiles"] ?? "C:\\Program Files";
    const localAppData = env.env["LOCALAPPDATA"] ?? join(env.home, "AppData", "Local");
    return [
      { path: join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"), channel: "stable" },
      { path: join(programFiles, "Microsoft VS Code", "bin", "code.cmd"), channel: "stable" },
      { path: join(localAppData, "Programs", "Microsoft VS Code Insiders", "bin", "code-insiders.cmd"), channel: "insiders" },
    ];
  }
  return [
    { path: "/usr/bin/code", channel: "stable" },
    { path: "/usr/local/bin/code", channel: "stable" },
    { path: "/snap/bin/code", channel: "stable" },
    { path: "/var/lib/flatpak/exports/bin/com.visualstudio.code", channel: "stable" },
    { path: "/usr/bin/code-insiders", channel: "insiders" },
  ];
}

export async function resolveVsCode(
  env: ResolverEnvironment,
  configured?: string,
): Promise<VsCodeCandidate | undefined> {
  if (configured && configured.trim() !== "") {
    if (await env.exists(configured)) return { executable: configured, channel: "stable", source: "configured" };
    // A configured-but-missing path is a user error worth surfacing, not silently skipping.
    return undefined;
  }

  for (const cmd of ["code", "code-insiders"] as const) {
    const found = await env.which(cmd);
    if (found) {
      return { executable: found, channel: cmd === "code" ? "stable" : "insiders", source: "path" };
    }
  }

  for (const location of installLocations(env)) {
    if (await env.exists(location.path)) {
      return { executable: location.path, channel: location.channel, source: "install-location" };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Remote detection
// ---------------------------------------------------------------------------

export type RemoteKind = "ssh" | "wsl" | "dev-container" | "codespaces" | "web" | undefined;

/**
 * Detected from environment markers VS Code and its remote extensions set. Native GUI Mode
 * is local-only in v0.4.1, and this is what makes that a clear message rather than a
 * confusing failure deep inside the launcher.
 */
export function detectRemote(env: Record<string, string | undefined>): RemoteKind {
  if (env["CODESPACES"] === "true" || env["CODESPACE_NAME"]) return "codespaces";
  if (env["REMOTE_CONTAINERS"] === "true" || env["REMOTE_CONTAINERS_IPC"] || env["DEVCONTAINER"]) return "dev-container";
  if (env["WSL_DISTRO_NAME"] || env["WSL_INTEROP"]) return "wsl";
  if (env["SSH_CONNECTION"] || env["SSH_CLIENT"] || env["VSCODE_REMOTE_SSH"]) return "ssh";
  if (env["VSCODE_BROWSER"] === "1") return "web";
  return undefined;
}

export const REMOTE_UNSUPPORTED_MESSAGE =
  "Native GUI Mode currently supports local workspaces. Use Dynamic Terminal Mode in remote environments.";

export const WINDOWS_UNSUPPORTED_MESSAGE =
  "Native GUI Mode is not yet available on this Windows environment. Use Dynamic Terminal Mode.";

export const NO_EXECUTABLE_MESSAGE =
  "Yuhi could not find a VS Code executable to open the isolated window with. Set one in Yuhi settings, or install the `code` command from the Command Palette (Shell Command: Install 'code' command in PATH).";
