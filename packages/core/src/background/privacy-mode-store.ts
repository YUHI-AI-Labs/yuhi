/**
 * Private, cross-process persistence for the run's resolved `PrivacyMode` — the same
 * cross-process problem `alias-registry-store.ts` solves, for a different value.
 * `runBackgroundForRun` (document/PDF de-identification) is always a separate process
 * from `prepareWorkspace()`, so the mode chosen for the synchronous tabular pass would
 * otherwise be lost by the time the async document pipeline runs, silently defaulting
 * to `DEFAULT_PRIVACY_MODE` regardless of what the user actually selected.
 *
 * Kept as its own tiny file rather than folded into `alias-registry-store.ts`: that
 * module's serialized shape is specific to `StudentAliasContext`'s fields, and a
 * `PrivacyMode` string is a different, unrelated value with the same lifetime and the
 * same failure-handling contract (missing/corrupt/wrong-run -> caller falls back to
 * `DEFAULT_PRIVACY_MODE`, never a thrown error the caller must remember to catch).
 *
 * Same posture as `alias-registry-store.ts`: `.internal/`-only, `0600`/`0700`, atomic
 * write, `runId`-checked on read.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { DEFAULT_PRIVACY_MODE, isPrivacyMode, type PrivacyMode } from "@yuhi/shared";

import { privateBackgroundDir } from "./status.js";

function atomicTarget(filename: string): string {
  return `${filename}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
}

export function privatePrivacyModePath(managedBase: string, runId: string): string {
  return path.join(privateBackgroundDir(managedBase, runId), "privacy-mode.json");
}

interface SerializedPrivacyMode {
  schemaVersion: 1;
  runId: string;
  mode: PrivacyMode;
}

/** Best-effort by convention (callers `.catch(() => {})` this) — a write failure must
 *  never block or delay the public report. */
export async function writePrivatePrivacyMode(
  managedBase: string,
  runId: string,
  mode: PrivacyMode,
): Promise<void> {
  const directory = privateBackgroundDir(managedBase, runId);
  const filename = privatePrivacyModePath(managedBase, runId);
  const temp = atomicTarget(filename);
  const payload: SerializedPrivacyMode = { schemaVersion: 1, runId, mode };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Read a run's Privacy Mode. Throws on missing file, corrupt JSON, a schema mismatch,
 * a `runId` mismatch, or an unrecognized mode string — every caller responds by
 * falling back to `DEFAULT_PRIVACY_MODE` (safe: this only affects whether a document
 * reuses a table's exact token / whether identifiers are transformed at all; the
 * independent verification pipeline runs regardless — see `alias-registry-store.ts`'s
 * doc comment for the parallel reasoning).
 */
export async function readPrivatePrivacyMode(managedBase: string, runId: string): Promise<PrivacyMode> {
  const filename = privatePrivacyModePath(managedBase, runId);
  const raw = JSON.parse(await fs.readFile(filename, "utf8")) as Partial<SerializedPrivacyMode>;
  if (raw.schemaVersion !== 1 || raw.runId !== runId || !isPrivacyMode(raw.mode)) {
    throw new Error("invalid-privacy-mode-record");
  }
  return raw.mode;
}

/** Convenience wrapper for call sites that just want a safe value, never a throw. */
export async function readPrivatePrivacyModeOrDefault(
  managedBase: string,
  runId: string,
): Promise<PrivacyMode> {
  return readPrivatePrivacyMode(managedBase, runId).catch(() => DEFAULT_PRIVACY_MODE);
}
