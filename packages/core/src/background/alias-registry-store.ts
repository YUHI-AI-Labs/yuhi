/**
 * Private, cross-process persistence for a run's `StudentAliasContext` (the
 * name/email/… pseudonym registry built during the synchronous `prepareWorkspace()`
 * pass).
 *
 * Why this exists: `runBackgroundForRun` (document/PDF de-identification) is ALWAYS a
 * separate call from `prepareWorkspace()` — a later CLI invocation (`yuhi background
 * start`), or a fresh VS Code extension host in the Prepared Workspace window — so the
 * in-memory `StudentAliasContext` object is already gone by the time background
 * document processing needs it. Without persistence, a document could never reuse the
 * SAME `PERSON-001` token a CSV in the same run already minted.
 *
 * Security posture — same tier as `packages/core/src/patch/private-state.ts`'s
 * `source-binding.json` (an absolute path stored in plain JSON): `.internal/`-only,
 * `0600`/`0700`, atomic temp+rename, never read by the agent, never copied into
 * `manifest.json`, `background-status.json`, or any handoff document. The registry's
 * VALUES are intentionally NOT hashed — `entitiesReachableInText` and
 * `text-deidentify.ts`'s known-value substitution both need literal substring matching
 * against arbitrary document text, which a keyed hash cannot support. Confidentiality
 * comes from where the file lives and who can read it, not from obscuring its content.
 *
 * Failure handling: a missing, corrupt, or wrong-`runId` file is NOT a safety problem.
 * `readPrivateAliasRegistry` throws in every such case; callers fall back to a fresh,
 * empty `StudentAliasContext`. Document safety does not depend on this registry —
 * `text-deidentify.ts` always masks every direct identifier and CJK name-shaped
 * candidate it detects regardless of whether the registry is available, and the
 * independent `scanTextForDirectPersonalIdentifiers` verification pass in
 * `wiring.ts` runs before anything is published either way. An empty registry only
 * degrades the cross-format "same token in the CSV and the PDF" convenience, never the
 * underlying guarantee that nothing raw is published.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  deserializeStudentAliasContext,
  serializeStudentAliasContext,
  type StudentAliasContext,
} from "@yuhi/shared";

import { privateBackgroundDir } from "./status.js";

function atomicTarget(filename: string): string {
  return `${filename}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
}

/** Private path for a run's alias registry — reuses the background subsystem's own
 *  `.internal/background/<runId>/` root rather than inventing a second private tree. */
export function privateAliasRegistryPath(managedBase: string, runId: string): string {
  return path.join(privateBackgroundDir(managedBase, runId), "alias-registry.json");
}

/**
 * Persist the run's alias registry. Best-effort by convention (callers `.catch(() =>
 * {})` this, same as `writePrivateRunSourceBinding` in `prepare-workspace.ts`) — a
 * write failure must never block or delay the public report, and never falls back to
 * writing anywhere agent-visible.
 */
export async function writePrivateAliasRegistry(
  managedBase: string,
  runId: string,
  context: StudentAliasContext,
): Promise<void> {
  const directory = privateBackgroundDir(managedBase, runId);
  const filename = privateAliasRegistryPath(managedBase, runId);
  const temp = atomicTarget(filename);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(
      temp,
      JSON.stringify(serializeStudentAliasContext(context, runId)),
      { mode: 0o600 },
    );
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Load a run's alias registry. Throws on missing file, corrupt JSON, a schema
 * mismatch, or a `runId` mismatch — every failure mode collapses to the same signal
 * (`readPrivateAliasRegistry` failed), and every caller in this codebase responds by
 * falling back to a fresh, empty `StudentAliasContext` (safe — see the module doc
 * comment), never by trusting a partially-parsed result.
 */
export async function readPrivateAliasRegistry(
  managedBase: string,
  runId: string,
): Promise<StudentAliasContext> {
  const filename = privateAliasRegistryPath(managedBase, runId);
  const raw = await fs.readFile(filename, "utf8");
  return deserializeStudentAliasContext(JSON.parse(raw), runId);
}
