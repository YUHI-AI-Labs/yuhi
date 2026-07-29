import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { YuhiError, workspacesDir, type WorkspaceManifest } from "@yuhi/shared";

export interface WorkspaceSummary {
  id: string;
  createdAt: string;
  agent: string;
  sourcePath: string;
  counts: WorkspaceManifest["counts"];
  baseDir: string;
}

function manifestPath(id: string): string {
  return path.join(workspacesDir(), id, "manifest.json");
}

export function readManifest(id: string): WorkspaceManifest {
  const p = manifestPath(id);
  if (!existsSync(p)) {
    throw new YuhiError("WORKSPACE_NOT_FOUND", `No workspace with id "${id}".`, {
      hint: "Run `yuhi workspace list` to see available workspaces.",
    });
  }
  return JSON.parse(readFileSync(p, "utf8")) as WorkspaceManifest;
}

export function listWorkspaces(): WorkspaceSummary[] {
  const dir = workspacesDir();
  if (!existsSync(dir)) return [];
  const out: WorkspaceSummary[] = [];
  for (const entry of readdirSync(dir)) {
    const base = path.join(dir, entry);
    try {
      if (!statSync(base).isDirectory()) continue;
      const m = readManifest(entry);
      out.push({
        id: m.id,
        createdAt: m.createdAt,
        agent: m.agent,
        sourcePath: m.source.path,
        counts: m.counts,
        baseDir: base,
      });
    } catch {
      /* skip incomplete/corrupt workspace dirs */
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export function inspectWorkspace(id: string): WorkspaceManifest {
  return readManifest(id);
}

/** Remove one workspace by id. Only ever deletes under ~/.yuhi/workspaces. */
export function cleanWorkspace(id: string): void {
  const base = path.join(workspacesDir(), id);
  const resolved = path.resolve(base);
  const root = path.resolve(workspacesDir());
  if (!resolved.startsWith(root + path.sep)) {
    throw new YuhiError("PATH_ESCAPE", `Refusing to delete outside workspaces dir: ${id}`);
  }
  if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true });
}

/** Remove all workspaces. Returns the number removed. */
export function cleanAllWorkspaces(): number {
  const list = listWorkspaces();
  for (const w of list) cleanWorkspace(w.id);
  return list.length;
}
