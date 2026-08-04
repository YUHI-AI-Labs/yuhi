/**
 * Merging Yuhi's endpoint into the isolated profile's `claudeCode.environmentVariables`.
 *
 * Three facts from the feasibility probe shape this file:
 *
 * 1. The setting is `"scope": "machine"`, so it cannot come from workspace settings. It goes
 *    into the isolated profile's USER settings, inside the session's `--user-data-dir`.
 * 2. The official extension writes to that same file itself (`claudeCode.preferredLocation`
 *    when the panel opens). So this is a merge, never a rewrite — an overwrite would silently
 *    revert the extension's own state.
 * 3. Its item schema is exactly `{ name: string, value: string }`, both required, read from
 *    the 2.1.221 manifest rather than assumed.
 *
 * Only the keys Yuhi owns are replaced. A user's own entries in that array survive, and a
 * duplicate name is normalised to one entry (last definition wins, matching how a shell
 * would resolve it) so the extension is never handed an ambiguous list.
 */

import { readFile, writeFile } from "node:fs/promises";

import { YUHI_MANAGED_ENV_KEYS, type NativeGuiEnvironment } from "./types.js";

export interface EnvironmentVariableEntry {
  readonly name: string;
  readonly value: string;
}

export const CLAUDE_ENV_SETTING_KEY = "claudeCode.environmentVariables";

/** Settings Yuhi sets for its own profile. Deliberately few, and none of them personal. */
export function yuhiProfileDefaults(accentColour: string): Record<string, unknown> {
  return {
    "window.restoreWindows": "none",
    "window.openFoldersInNewWindow": "on",
    "workbench.colorCustomizations": {
      "titleBar.activeBackground": accentColour,
      "titleBar.inactiveBackground": accentColour,
    },
  };
}

export function isEnvEntry(value: unknown): value is EnvironmentVariableEntry {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw["name"] === "string" && typeof raw["value"] === "string";
}

/**
 * Replace Yuhi-managed entries, preserve everything else, and collapse duplicates.
 *
 * Order is stable for the entries the user already had, because a settings file that
 * reshuffles itself on every launch produces a confusing diff for anyone inspecting it.
 */
export function mergeEnvironmentVariables(
  existing: unknown,
  managed: NativeGuiEnvironment,
): EnvironmentVariableEntry[] {
  const managedNames = new Set<string>(YUHI_MANAGED_ENV_KEYS as readonly string[]);
  const foreign: EnvironmentVariableEntry[] = [];
  const seen = new Map<string, number>();

  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (!isEnvEntry(item)) continue;
      if (managedNames.has(item.name)) continue; // ours: about to be re-emitted from `managed`
      const at = seen.get(item.name);
      if (at === undefined) {
        seen.set(item.name, foreign.length);
        foreign.push(item);
      } else {
        foreign[at] = item; // duplicate user key: last definition wins, single entry kept
      }
    }
  }

  const mine = YUHI_MANAGED_ENV_KEYS.map((name) => ({ name, value: String(managed[name]) }));
  return [...foreign, ...mine];
}

/**
 * Read → merge → write. Unparseable settings are replaced rather than propagated: this file
 * lives in a Yuhi-owned session directory, so there is no user content to lose, and refusing
 * to launch because the extension crashed mid-write would be the wrong trade.
 */
export async function applyManagedSettings(input: {
  settingsFile: string;
  managed: NativeGuiEnvironment;
  defaults?: Record<string, unknown>;
  /**
   * Applied AFTER the existing file, unlike `defaults`. Session-scoped values must not be
   * inherited from a previous launch — a stale control endpoint would point the isolated
   * window at a gateway that no longer exists.
   */
  overrides?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(input.settingsFile, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or corrupt — start from the defaults below
  }

  const next: Record<string, unknown> = { ...input.defaults, ...current, ...input.overrides };
  next[CLAUDE_ENV_SETTING_KEY] = mergeEnvironmentVariables(current[CLAUDE_ENV_SETTING_KEY], input.managed);

  await writeFile(input.settingsFile, `${JSON.stringify(next, null, 4)}\n`, "utf8");
  return next;
}

/** Strip Yuhi's entries on shutdown so a stale endpoint cannot be reused by a later launch. */
export async function clearManagedSettings(settingsFile: string): Promise<void> {
  let current: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    current = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const managedNames = new Set<string>(YUHI_MANAGED_ENV_KEYS as readonly string[]);
  const remaining = Array.isArray(current[CLAUDE_ENV_SETTING_KEY])
    ? (current[CLAUDE_ENV_SETTING_KEY] as unknown[]).filter((e) => isEnvEntry(e) && !managedNames.has(e.name))
    : [];
  if (remaining.length === 0) delete current[CLAUDE_ENV_SETTING_KEY];
  else current[CLAUDE_ENV_SETTING_KEY] = remaining;
  await writeFile(settingsFile, `${JSON.stringify(current, null, 4)}\n`, "utf8");
}

/**
 * How the isolated window learns it is a Native GUI window.
 *
 * Under the primary integration path only the `claude` child receives Yuhi's environment —
 * the isolated extension host deliberately receives none of it. So the Yuhi extension in
 * that window cannot discover the session from `process.env`, and this setting is the
 * channel instead. It carries an id and a loopback URL; the bootstrap token stays 0o600 in
 * `private/` and is read from disk, never from settings.
 */
export const NATIVE_SESSION_SETTING = "yuhi.nativeSession";

export interface NativeSessionSettingValue {
  readonly sessionId: string;
  readonly sessionRoot: string;
  readonly controlUrl?: string;
}
