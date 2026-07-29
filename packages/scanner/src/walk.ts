import { readFileSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { toPosix } from "@yuhi/shared";

/** Directories always skipped regardless of ignore files. */
const ALWAYS_SKIP_DIRS = new Set([".git", "node_modules", ".yuhi"]);

/** Ignore files honored by `yuhi init`/`scan` (in addition to explicit rules). */
const IGNORE_FILES = [".gitignore", ".dockerignore", ".npmignore", ".ignore"];

export interface WalkEntry {
  /** repo-relative POSIX path */
  relpath: string;
  absPath: string;
  size: number;
  isSymlink: boolean;
  symlinkTarget?: string;
}

export interface WalkResult {
  entries: WalkEntry[];
  warnings: string[];
}

function loadIgnores(root: string): Ignore {
  const ig = ignore();
  for (const name of IGNORE_FILES) {
    try {
      const content = readFileSync(path.join(root, name), "utf8");
      ig.add(content);
    } catch {
      /* file absent — fine */
    }
  }
  return ig;
}

/**
 * Enumerate files under `root`, honoring ignore files and never following
 * symlinks (symlinks are reported, not traversed). Purely lexical + lstat; no
 * shell, no path escaping.
 */
export function walkRepo(root: string): WalkResult {
  const absRoot = path.resolve(root);
  const ig = loadIgnores(absRoot);
  const entries: WalkEntry[] = [];
  const warnings: string[] = [];

  const stack: string[] = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      warnings.push(`Could not read directory: ${toPosix(path.relative(absRoot, dir))}`);
      continue;
    }
    for (const dirent of dirents) {
      const abs = path.join(dir, dirent.name);
      const rel = toPosix(path.relative(absRoot, abs));
      if (rel === "") continue;

      // lstat so we never dereference symlinks.
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        warnings.push(`Could not stat: ${rel}`);
        continue;
      }

      if (st.isSymbolicLink()) {
        // Record the symlink target for reporting; do NOT follow it.
        let target: string | undefined;
        try {
          target = readlinkSync(abs);
        } catch {
          target = undefined;
        }
        entries.push({
          relpath: rel,
          absPath: abs,
          size: 0,
          isSymlink: true,
          ...(target !== undefined ? { symlinkTarget: target } : {}),
        });
        continue;
      }

      if (st.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(dirent.name)) continue;
        // ignore matching (append "/" so dir globs match)
        if (ig.ignores(rel + "/") || ig.ignores(rel)) continue;
        stack.push(abs);
        continue;
      }

      if (st.isFile()) {
        if (ig.ignores(rel)) continue;
        entries.push({
          relpath: rel,
          absPath: abs,
          size: st.size,
          isSymlink: false,
        });
      }
      // other types (fifo, socket, device) are skipped silently
    }
  }

  entries.sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
  return { entries, warnings };
}
