/**
 * What Yuhi requires of the official Claude Code extension — checked, not assumed.
 *
 * The tested build is 2.1.221, but pinning it forever would break Native GUI Mode the first
 * time a user updates. So the gate is a CONTRACT, validated from the installed manifest:
 * publisher, id, the documented environment setting, and the public open command. Any
 * version that still satisfies all four is accepted; one that does not is reported honestly
 * instead of being worked around.
 *
 * No private module is imported and no webview is inspected. The only things read are
 * `contributes.configuration` and `contributes.commands`, which are public manifest surface.
 */

export const OFFICIAL_EXTENSION_ID = "Anthropic.claude-code";
export const OFFICIAL_EXTENSION_PUBLISHER = "Anthropic";
export const OFFICIAL_EXTENSION_NAME = "claude-code";
/** The build the v0.4.1 feasibility gate was proven against. */
export const TESTED_EXTENSION_VERSION = "2.1.221";

export const REQUIRED_SETTING = "claudeCode.environmentVariables";
export const REQUIRED_OPEN_COMMAND = "claude-vscode.sidebar.open";
/** Tried in order by the adapter; the first that exists is used. */
export const OPEN_COMMAND_CANDIDATES = [
  "claude-vscode.sidebar.open",
  "claude-vscode.window.open",
  "claude-vscode.editor.open",
] as const;

export type ContractFailure =
  | "not-installed"
  | "wrong-publisher"
  | "missing-environment-setting"
  | "environment-setting-wrong-shape"
  | "missing-open-command";

export interface ContractResult {
  readonly ok: boolean;
  readonly version: string | undefined;
  readonly openCommand: string | undefined;
  readonly failures: readonly ContractFailure[];
  /** True when the manifest matches the exact build the gate was proven against. */
  readonly isTestedVersion: boolean;
}

export interface ExtensionManifest {
  readonly publisher?: unknown;
  readonly name?: unknown;
  readonly version?: unknown;
  readonly contributes?: unknown;
}

function configurationProperties(contributes: unknown): Record<string, unknown> {
  if (typeof contributes !== "object" || contributes === null) return {};
  const config = (contributes as Record<string, unknown>)["configuration"];
  const blocks = Array.isArray(config) ? config : [config];
  const merged: Record<string, unknown> = {};
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const props = (block as Record<string, unknown>)["properties"];
    if (typeof props === "object" && props !== null) Object.assign(merged, props);
  }
  return merged;
}

function commandIds(contributes: unknown): Set<string> {
  const ids = new Set<string>();
  if (typeof contributes !== "object" || contributes === null) return ids;
  const commands = (contributes as Record<string, unknown>)["commands"];
  if (!Array.isArray(commands)) return ids;
  for (const entry of commands) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as Record<string, unknown>)["command"];
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/**
 * The array-of-`{name,value}` shape matters as much as the key's presence: a future version
 * that kept the name but changed the shape would silently drop our endpoint, and the session
 * would look healthy while Claude talked straight past the gateway.
 */
function environmentSettingShapeIsUsable(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const raw = schema as Record<string, unknown>;
  if (raw["type"] !== "array") return false;
  const items = raw["items"];
  if (typeof items !== "object" || items === null) return false;
  const itemProps = (items as Record<string, unknown>)["properties"];
  if (typeof itemProps !== "object" || itemProps === null) return false;
  const props = itemProps as Record<string, unknown>;
  return "name" in props && "value" in props;
}

export function validateExtensionContract(manifest: ExtensionManifest | undefined): ContractResult {
  if (!manifest) {
    return { ok: false, version: undefined, openCommand: undefined, failures: ["not-installed"], isTestedVersion: false };
  }

  const failures: ContractFailure[] = [];
  const version = typeof manifest.version === "string" ? manifest.version : undefined;

  const publisher = typeof manifest.publisher === "string" ? manifest.publisher : "";
  const name = typeof manifest.name === "string" ? manifest.name : "";
  if (publisher.toLowerCase() !== OFFICIAL_EXTENSION_PUBLISHER.toLowerCase() || name !== OFFICIAL_EXTENSION_NAME) {
    failures.push("wrong-publisher");
  }

  const props = configurationProperties(manifest.contributes);
  if (!(REQUIRED_SETTING in props)) failures.push("missing-environment-setting");
  else if (!environmentSettingShapeIsUsable(props[REQUIRED_SETTING])) failures.push("environment-setting-wrong-shape");

  const commands = commandIds(manifest.contributes);
  const openCommand = OPEN_COMMAND_CANDIDATES.find((id) => commands.has(id));
  if (!openCommand) failures.push("missing-open-command");

  return {
    ok: failures.length === 0,
    version,
    openCommand,
    failures,
    isTestedVersion: version === TESTED_EXTENSION_VERSION,
  };
}

export const CONTRACT_BROKEN_MESSAGE =
  "Installed Claude Code extension is incompatible with Yuhi Native GUI Mode.";

export const CONTRACT_BROKEN_CHOICES = [
  "Install tested version",
  "Use Dynamic Terminal Mode",
  "Cancel",
] as const;

export type ContractBrokenChoice = (typeof CONTRACT_BROKEN_CHOICES)[number];

export function describeContractFailure(result: ContractResult): string {
  const detail: Record<ContractFailure, string> = {
    "not-installed": "the extension is not present in the isolated Yuhi profile",
    "wrong-publisher": "the installed extension is not published by Anthropic",
    "missing-environment-setting": `it no longer contributes ${REQUIRED_SETTING}`,
    "environment-setting-wrong-shape": `${REQUIRED_SETTING} no longer accepts { name, value } entries`,
    "missing-open-command": "it exposes none of the public commands Yuhi uses to open the panel",
  };
  const reasons = result.failures.map((f) => detail[f]).join("; ");
  const seen = result.version ? ` (found version ${result.version})` : "";
  return `${CONTRACT_BROKEN_MESSAGE}${seen}: ${reasons}.`;
}
