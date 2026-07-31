import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Marker written into a Yuhi-prepared workspace so that cleanup routines can
 * positively identify directories that Yuhi created and manages. The goal is
 * safety: cleanup must NEVER delete a directory that Yuhi did not prepare, so a
 * missing/corrupt/foreign marker always resolves to "not safely managed".
 */
export interface WorkspaceMarker {
  managedBy: "yuhi";
  schemaVersion: number;
  createdAt: string;
  runId: string;
}

/** Filename of the marker placed at the root of a managed workspace. */
export const WORKSPACE_MARKER_FILE = ".yuhi-managed.json";

/** Result of attempting to read/parse a workspace marker. Never throws. */
export interface ReadWorkspaceMarkerResult {
  status: "valid" | "missing" | "invalid";
  marker?: WorkspaceMarker;
}

function isValidMarker(value: unknown): value is WorkspaceMarker {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m.managedBy === "yuhi" &&
    typeof m.schemaVersion === "number" &&
    Number.isFinite(m.schemaVersion) &&
    typeof m.createdAt === "string" &&
    typeof m.runId === "string"
  );
}

/**
 * Write the marker file to `${workspaceDir}/.yuhi-managed.json` with 0600
 * permissions (owner read/write only).
 */
export async function writeWorkspaceMarker(
  workspaceDir: string,
  marker: WorkspaceMarker,
): Promise<void> {
  const target = path.join(workspaceDir, WORKSPACE_MARKER_FILE);
  const body = JSON.stringify(marker, null, 2) + "\n";
  await writeFile(target, body, { encoding: "utf8", mode: 0o600 });
}

/**
 * Read and parse the marker. Never throws for expected failure modes:
 * - file absent -> { status: "missing" }
 * - unreadable / bad JSON / wrong shape / wrong managedBy -> { status: "invalid" }
 * - well-formed Yuhi marker -> { status: "valid", marker }
 */
export async function readWorkspaceMarker(
  workspaceDir: string,
): Promise<ReadWorkspaceMarkerResult> {
  const target = path.join(workspaceDir, WORKSPACE_MARKER_FILE);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { status: "missing" };
    }
    // Any other read error (permissions, is-a-directory, etc.) is treated as
    // invalid rather than propagated, so cleanup skips the directory safely.
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid" };
  }

  if (!isValidMarker(parsed)) {
    return { status: "invalid" };
  }

  return { status: "valid", marker: parsed };
}

/**
 * Returns true ONLY when `workspaceDir` carries a valid Yuhi marker
 * (managedBy === "yuhi"). Returns false for missing/invalid markers AND when
 * the path itself is a symlink (checked via lstat), so cleanup can never be
 * tricked into following a symlink into a foreign directory.
 */
export async function isSafelyYuhiManaged(workspaceDir: string): Promise<boolean> {
  try {
    const info = await lstat(workspaceDir);
    if (info.isSymbolicLink()) return false;
  } catch {
    // Path does not exist or cannot be stat'd -> not safely managed.
    return false;
  }

  const result = await readWorkspaceMarker(workspaceDir);
  return result.status === "valid" && result.marker?.managedBy === "yuhi";
}
