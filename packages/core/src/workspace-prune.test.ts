import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneManagedWorkspaces, KEEP_RECENT_WORKSPACES, WORKSPACE_MAX_AGE_MS } from "./prepare-workspace.js";
import { WORKSPACE_MARKER_FILE } from "./workspace-marker.js";

const DAY = 24 * 60 * 60 * 1000;

describe("pruneManagedWorkspaces", () => {
  it("keeps newest N + recent runs, deletes old ones beyond N, never touches current", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "yuhi-prune-"));
    const now = 1_000_000_000_000; // fixed clock
    // Create runs with controlled ages (mtime). Newest first by design.
    const mk = (name: string, ageMs: number) => {
      const d = path.join(base, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, "manifest.json"), "{}");
      writeFileSync(path.join(d, WORKSPACE_MARKER_FILE), JSON.stringify({ managedBy: "yuhi", schemaVersion: 1, createdAt: new Date(0).toISOString(), runId: name }));
      const t = (now - ageMs) / 1000;
      utimesSync(d, t, t);
    };
    mk("current", 0);
    mk("r1", 1 * DAY);   // recent
    mk("r2", 2 * DAY);   // recent
    mk("r3", 3 * DAY);   // recent — this is the 3rd-newest non-current
    mk("r4-recent", 4 * DAY);   // beyond N but < 7d → KEPT
    mk("old1", 10 * DAY);       // beyond N and > 7d → DELETED
    mk("old2", 30 * DAY);       // beyond N and > 7d → DELETED

    const removed = await pruneManagedWorkspaces(base, "current", now);

    expect(existsSync(path.join(base, "current"))).toBe(true); // never touched
    expect(existsSync(path.join(base, "r1"))).toBe(true);
    expect(existsSync(path.join(base, "r2"))).toBe(true);
    expect(existsSync(path.join(base, "r3"))).toBe(true);
    expect(existsSync(path.join(base, "r4-recent"))).toBe(true); // < 7 days → kept
    expect(existsSync(path.join(base, "old1"))).toBe(false);     // deleted
    expect(existsSync(path.join(base, "old2"))).toBe(false);     // deleted
    expect(removed.sort()).toEqual(["old1", "old2"]);
    expect(KEEP_RECENT_WORKSPACES).toBe(3);
    expect(WORKSPACE_MAX_AGE_MS).toBe(7 * DAY);
  });

  it("never deletes an old directory that is not safely Yuhi-managed (no/invalid marker)", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "yuhi-prune2-"));
    const now = 1_000_000_000_000;
    const mkOld = (name: string, marker: string | null) => {
      const d = path.join(base, name);
      mkdirSync(d, { recursive: true });
      if (marker !== null) writeFileSync(path.join(d, WORKSPACE_MARKER_FILE), marker);
      const t = (now - 30 * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(d, t, t);
    };
    mkOld("no-marker", null);                       // not Yuhi-managed
    mkOld("bad-marker", "{ not json");              // invalid marker
    mkOld("wrong-owner", JSON.stringify({ managedBy: "someone-else" }));
    mkOld("valid", JSON.stringify({ managedBy: "yuhi", schemaVersion: 1, createdAt: new Date(0).toISOString(), runId: "valid" }));
    // Fill the newest-3 slots with recent valid runs so the old ones are pruning candidates.
    for (const n of ["r1", "r2", "r3"]) mkOld(n, JSON.stringify({ managedBy: "yuhi", schemaVersion: 1, createdAt: new Date(0).toISOString(), runId: n }));
    for (const n of ["r1", "r2", "r3"]) { const t = now / 1000; utimesSync(path.join(base, n), t, t); }
    const removed = await pruneManagedWorkspaces(base, "current", now);
    expect(existsSync(path.join(base, "no-marker"))).toBe(true);    // untouched
    expect(existsSync(path.join(base, "bad-marker"))).toBe(true);   // untouched
    expect(existsSync(path.join(base, "wrong-owner"))).toBe(true);  // untouched
    expect(existsSync(path.join(base, "valid"))).toBe(false);       // deleted (marked + old)
    expect(removed).toContain("valid");
    expect(removed).not.toContain("no-marker");
  });

  it("never throws on a missing base dir", async () => {
    const removed = await pruneManagedWorkspaces(path.join(tmpdir(), "yuhi-does-not-exist-xyz"), "x", 0);
    expect(removed).toEqual([]);
  });
});
