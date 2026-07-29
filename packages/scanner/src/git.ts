import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { toPosix } from "@yuhi/shared";

export function isGitRepo(root: string): boolean {
  return existsSync(path.join(root, ".git"));
}

/**
 * Return the set of git-tracked repo-relative POSIX paths, or null when this is
 * not a git repo / git is unavailable. Uses spawn with an argv array (never a
 * shell string) and NUL-delimited output to be filename-safe.
 */
export function trackedFiles(root: string): Set<string> | null {
  if (!isGitRepo(root)) return null;
  try {
    const res = spawnSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "buffer",
      timeout: 10_000,
      windowsHide: true,
    });
    if (res.status !== 0 || !res.stdout) return null;
    const text = res.stdout.toString("utf8");
    const set = new Set<string>();
    for (const entry of text.split("\0")) {
      if (entry) set.add(toPosix(entry));
    }
    return set;
  } catch {
    return null;
  }
}
