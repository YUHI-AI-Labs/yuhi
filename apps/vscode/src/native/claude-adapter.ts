/**
 * Opening the OFFICIAL Claude Code panel, through its public surface only.
 *
 * Everything here is `getExtension` → `activate()` → `executeCommand`. No private module is
 * imported, no webview is reached into, no command id is guessed: the ids come from the
 * extension's own manifest, validated by the contract check before this runs.
 *
 * When no open command exists — a future version could rename them — the adapter says so and
 * tells the user how to open the panel by hand, rather than failing the session. The gateway
 * is already in the path at that point; the panel is presentation.
 */

import {
  OPEN_COMMAND_CANDIDATES,
  OFFICIAL_EXTENSION_ID,
  validateExtensionContract,
  type ContractResult,
} from "@yuhi/context-gateway";

export interface ExtensionHandle {
  readonly id: string;
  readonly isActive: boolean;
  readonly packageJSON: unknown;
  activate(): Promise<unknown>;
}

export interface ClaudeAdapterHost {
  getExtension(id: string): ExtensionHandle | undefined;
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  getCommands(): Promise<readonly string[]>;
  log(line: string): void;
}

export type ClaudeOpenOutcome =
  | { readonly kind: "opened"; readonly command: string; readonly version: string | undefined }
  | { readonly kind: "not-installed" }
  | { readonly kind: "contract-broken"; readonly contract: ContractResult }
  | { readonly kind: "no-open-command"; readonly version: string | undefined }
  | { readonly kind: "command-failed"; readonly command: string; readonly error: string };

export const MANUAL_OPEN_HINT =
  "Open the Claude Code panel from the Command Palette; Yuhi's gateway is already active in this window.";

export async function openOfficialClaudePanel(host: ClaudeAdapterHost): Promise<ClaudeOpenOutcome> {
  const extension = host.getExtension(OFFICIAL_EXTENSION_ID);
  if (!extension) return { kind: "not-installed" };

  const contract = validateExtensionContract(extension.packageJSON as Record<string, unknown>);
  if (!contract.ok) return { kind: "contract-broken", contract };

  if (!extension.isActive) {
    await extension.activate();
  }

  // Prefer what the manifest declared, but confirm against the live command registry: an
  // extension can declare a command and fail to register it if activation went wrong.
  const registered = new Set(await host.getCommands());
  const candidates = [contract.openCommand, ...OPEN_COMMAND_CANDIDATES].filter(
    (c): c is string => typeof c === "string",
  );
  const command = candidates.find((c) => registered.has(c));
  if (!command) return { kind: "no-open-command", version: contract.version };

  try {
    await host.executeCommand(command);
    host.log(`[native] opened the official Claude panel via ${command}`);
    return { kind: "opened", command, version: contract.version };
  } catch (err) {
    return { kind: "command-failed", command, error: err instanceof Error ? err.message : "unknown" };
  }
}

export function claudeExtensionVersion(host: Pick<ClaudeAdapterHost, "getExtension">): string | undefined {
  const pkg = host.getExtension(OFFICIAL_EXTENSION_ID)?.packageJSON;
  if (typeof pkg !== "object" || pkg === null) return undefined;
  const version = (pkg as Record<string, unknown>)["version"];
  return typeof version === "string" ? version : undefined;
}
