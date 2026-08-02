import { createHash } from "node:crypto";
import * as path from "node:path";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import type {
  PreparedRepresentation,
  PreparedSnapshot,
  PreparedSnapshotFile,
} from "./types.js";

export interface CapturePreparedSnapshotOptions {
  contextId: string;
  revisionId: string;
  createdFromRunId: string;
  representationFor?: (relpath: string) => PreparedRepresentation;
  /** Review scans retain colliding entries so validator can report them as blocked. */
  allowPathCollisions?: boolean;
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function publicSafeRelpath(relpath: string): boolean {
  if (!relpath || path.posix.isAbsolute(relpath)) return false;
  return relpath.split("/").every((segment) => {
    if (!segment || segment === "." || segment === ".." || segment.includes(":")) return false;
    if (WINDOWS_RESERVED.test(segment) || /[. ]$/.test(segment)) return false;
    return [...segment].every((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    });
  });
}

/** Reject aliases before they reach an identity-bearing snapshot. */
export function assertNoPreparedPathCollisions(relpaths: readonly string[]): void {
  const aliases = new Set<string>();
  for (const relpath of relpaths) {
    if (!publicSafeRelpath(relpath)) throw new Error("unsafe-prepared-relpath");
    const alias = relpath.normalize("NFC").toLocaleLowerCase("en-US").normalize("NFC");
    if (aliases.has(alias)) throw new Error("prepared-path-collision");
    aliases.add(alias);
  }
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  return sample.includes(0);
}

async function scan(root: string, relativeDir: string, options: CapturePreparedSnapshotOptions): Promise<PreparedSnapshotFile[]> {
  const absoluteDir = relativeDir ? path.join(root, ...relativeDir.split("/")) : root;
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  entries.sort((a, b) => comparePath(a.name, b.name));
  const files: PreparedSnapshotFile[] = [];

  for (const entry of entries) {
    const relpath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const absolute = path.join(absoluteDir, entry.name);
    const info = await lstat(absolute);
    // A symlink (or device/FIFO/socket) is itself an agent-authored change. Silently
    // skipping it would make the review claim that the workspace is unchanged.
    // Fail closed instead; v0.3.6 does not support applying these entry types.
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      files.push({
        relpath,
        sha256: createHash("sha256").update(target).digest("hex"),
        sizeBytes: 0,
        representation: options.representationFor?.(relpath) ?? "full",
        mode: info.mode & 0o777,
        binary: true,
        unsafeType: "symlink",
      });
      continue;
    }
    if (info.isDirectory()) {
      files.push(...await scan(root, relpath, options));
      continue;
    }
    if (!info.isFile()) {
      files.push({
        relpath,
        sha256: createHash("sha256").update(`special:${info.mode}`).digest("hex"),
        sizeBytes: 0,
        representation: options.representationFor?.(relpath) ?? "full",
        mode: info.mode & 0o777,
        binary: true,
        unsafeType: "special",
      });
      continue;
    }
    // O_NOFOLLOW closes the lstat→open symlink-swap window. fstat then binds all
    // hashed metadata to the descriptor actually read, not to an earlier pathname.
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.dev !== info.dev || openedInfo.ino !== info.ino) {
        throw new Error("prepared-file-changed-during-snapshot");
      }
      const bytes = await handle.readFile();
      files.push({
        relpath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        representation: options.representationFor?.(relpath) ?? "full",
        mode: openedInfo.mode & 0o777,
        binary: isBinary(bytes),
      });
    } finally {
      await handle.close();
    }
  }
  return files;
}

/** Capture only stable, repository-relative file facts. The caller persists this in private state. */
export async function capturePreparedSnapshot(
  preparedRoot: string,
  options: CapturePreparedSnapshotOptions,
): Promise<PreparedSnapshot> {
  const rootInfo = await lstat(preparedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("invalid-prepared-root");
  const files = await scan(preparedRoot, "", options);
  if (options.allowPathCollisions) {
    for (const file of files) {
      if (!publicSafeRelpath(file.relpath)) throw new Error("unsafe-prepared-relpath");
    }
  } else {
    assertNoPreparedPathCollisions(files.map((file) => file.relpath));
  }
  return {
    contextId: options.contextId,
    revisionId: options.revisionId,
    createdFromRunId: options.createdFromRunId,
    files,
  };
}
