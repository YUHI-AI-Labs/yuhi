/**
 * Where a Native GUI session keeps its state, and what is allowed to be in each half.
 *
 * `public/` is anything a UI, log or diagnostics export may read. `private/` holds the
 * bootstrap token, the source binding, the context store and the evidence ledger, and is
 * created with owner-only permissions. The split is not cosmetic: the security tests in
 * `security.test.ts` byte-scan every public file for canary values, so putting something in
 * the wrong half fails the build rather than shipping.
 *
 * Sessions live under the existing Yuhi home (`~/.yuhi`, overridable with `YUHI_HOME`)
 * rather than a second platform-specific application-data root. One home keeps `yuhi
 * dynamic sessions`, recovery and cleanup looking in a single place on every OS.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { yuhiHome } from "@yuhi/shared";

export const NATIVE_SESSIONS_DIRNAME = "native-sessions";

export function nativeSessionsRoot(): string {
  return join(yuhiHome(), NATIVE_SESSIONS_DIRNAME);
}

export interface SessionLayout {
  readonly sessionId: string;
  readonly root: string;
  /** Public — safe to read into a UI or an exported diagnostic. */
  readonly sessionRecord: string;
  readonly statsRecord: string;
  readonly lifecycleLog: string;
  readonly ownerRecord: string;
  readonly lockFile: string;
  /** VS Code isolation. */
  readonly vscodeDir: string;
  readonly userDataDir: string;
  readonly extensionsDir: string;
  readonly profileSettings: string;
  /** Private — never surfaced. */
  readonly privateDir: string;
  readonly bootstrapTokenFile: string;
  readonly sourceBindingDir: string;
  readonly gatewayDir: string;
  readonly contextStoreDir: string;
  readonly prefixStateDir: string;
  readonly evidenceDir: string;
  readonly authStateDir: string;
}

export function sessionLayout(sessionId: string, root = nativeSessionsRoot()): SessionLayout {
  const base = join(root, sessionId);
  const vscodeDir = join(base, "vscode");
  const privateDir = join(base, "private");
  return {
    sessionId,
    root: base,
    sessionRecord: join(base, "session.public.json"),
    statsRecord: join(base, "stats.public.json"),
    lifecycleLog: join(base, "lifecycle.jsonl"),
    ownerRecord: join(base, "owner.json"),
    lockFile: join(base, "lock.json"),
    vscodeDir,
    userDataDir: join(vscodeDir, "user-data"),
    extensionsDir: join(vscodeDir, "extensions"),
    profileSettings: join(vscodeDir, "profile-settings.json"),
    privateDir,
    bootstrapTokenFile: join(privateDir, "bootstrap-token"),
    sourceBindingDir: join(privateDir, "source-binding"),
    gatewayDir: join(privateDir, "gateway"),
    contextStoreDir: join(privateDir, "context-store"),
    prefixStateDir: join(privateDir, "prefix-state"),
    evidenceDir: join(privateDir, "evidence"),
    authStateDir: join(privateDir, "auth-state"),
  };
}

/** Create the tree. `private/` is 0o700 so another local user cannot read the token. */
export async function createSessionTree(layout: SessionLayout): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  await mkdir(layout.vscodeDir, { recursive: true });
  await mkdir(layout.userDataDir, { recursive: true });
  await mkdir(layout.extensionsDir, { recursive: true });
  await mkdir(layout.privateDir, { recursive: true, mode: 0o700 });
  for (const dir of [
    layout.sourceBindingDir,
    layout.gatewayDir,
    layout.contextStoreDir,
    layout.prefixStateDir,
    layout.evidenceDir,
    layout.authStateDir,
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Opaque session id. Not derived from the path — a session id appears in public records and
 * in the isolated window's environment, and a hashed path there would still leak the fact
 * that two sessions share a repository.
 */
export function newSessionId(): string {
  return `ngui_${randomBytes(12).toString("hex")}`;
}

/**
 * Stable, non-reversible identifier for a workspace path. Used for lock ownership and for
 * "is this the same repository?" without ever writing the path itself into a public record.
 */
export function workspaceHash(workspacePath: string): string {
  return createHash("sha256").update(resolve(workspacePath)).digest("hex").slice(0, 32);
}

/** 256 bits from the CSPRNG. Written 0o600 and never logged, echoed, or put in diagnostics. */
export function newBootstrapToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function writeBootstrapToken(layout: SessionLayout, token: string): Promise<void> {
  await writeFile(layout.bootstrapTokenFile, token, { encoding: "utf8", mode: 0o600 });
}
