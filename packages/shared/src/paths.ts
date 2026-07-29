import os from "node:os";
import path from "node:path";

/** Root under the user's home for all Yuhi runtime data. */
export function yuhiHome(): string {
  const override = process.env.YUHI_HOME;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(os.homedir(), ".yuhi");
}

export function workspacesDir(): string {
  return path.join(yuhiHome(), "workspaces");
}

export function auditDir(): string {
  return path.join(yuhiHome(), "audit");
}

/** Where per-project context snapshots live (for `yuhi status` / `yuhi diff`). */
export function stateDir(): string {
  return path.join(yuhiHome(), "state");
}

/** Convert any OS path to a POSIX-style repo-relative path (for globbing/display). */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Safely resolve `relative` under `root`, guaranteeing the result stays inside
 * `root`. Throws-caller should treat a null return as an attempted escape.
 *
 * This is a pure lexical check (defense against `..` and absolute paths). Symlink
 * escapes are handled separately by the workspace copier (it never follows links).
 */
export function confineWithin(root: string, relative: string): string | null {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, target);
  if (rel === "") return target; // equals root itself
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

/** True when `p` looks like an absolute path on the current platform. */
export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p);
}
