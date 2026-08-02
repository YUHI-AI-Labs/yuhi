import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface PrivateRunSourceBinding {
  schemaVersion: 1;
  runId: string;
  sourceRoot: string;
  sourceWorkspaceId: string;
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("invalid-private-state-id");
  return value;
}

function atomicTarget(filename: string): string {
  return `${filename}.${process.pid}.tmp`;
}

export function privatePatchRunDir(managedBase: string, runId: string): string {
  return path.join(path.resolve(managedBase), ".internal", "patches", safeId(runId));
}

export function privatePatchSessionDir(
  managedBase: string,
  runId: string,
  sessionId: string,
): string {
  return path.join(privatePatchRunDir(managedBase, runId), "sessions", safeId(sessionId));
}

export async function writePrivateRunSourceBinding(
  managedBase: string,
  runId: string,
  sourceRoot: string,
): Promise<PrivateRunSourceBinding> {
  const resolvedSource = await fs.realpath(sourceRoot);
  const info = await fs.lstat(resolvedSource);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid-source-root");
  const binding: PrivateRunSourceBinding = {
    schemaVersion: 1,
    runId,
    sourceRoot: resolvedSource,
    sourceWorkspaceId: createHash("sha256").update(resolvedSource).digest("hex").slice(0, 24),
  };
  const directory = privatePatchRunDir(managedBase, runId);
  const filename = path.join(directory, "source-binding.json");
  const temp = atomicTarget(filename);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temp, JSON.stringify(binding), { mode: 0o600 });
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
  return binding;
}

export async function readPrivateRunSourceBinding(
  managedBase: string,
  runId: string,
): Promise<PrivateRunSourceBinding> {
  const filename = path.join(privatePatchRunDir(managedBase, runId), "source-binding.json");
  const parsed = JSON.parse(await fs.readFile(filename, "utf8")) as Partial<PrivateRunSourceBinding>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.runId !== runId ||
    typeof parsed.sourceRoot !== "string" ||
    typeof parsed.sourceWorkspaceId !== "string"
  ) throw new Error("invalid-source-binding");
  const sourceRoot = await fs.realpath(parsed.sourceRoot);
  const info = await fs.lstat(sourceRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid-source-root");
  return { ...parsed, sourceRoot } as PrivateRunSourceBinding;
}
