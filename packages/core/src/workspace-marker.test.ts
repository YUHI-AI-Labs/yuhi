import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_MARKER_FILE,
  isSafelyYuhiManaged,
  readWorkspaceMarker,
  writeWorkspaceMarker,
  type WorkspaceMarker,
} from "./workspace-marker.js";

const validMarker: WorkspaceMarker = {
  managedBy: "yuhi",
  schemaVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  runId: "run-abc",
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "yuhi-marker-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace marker", () => {
  it("writes then reads back a valid marker (0600)", async () => {
    await writeWorkspaceMarker(root, validMarker);
    const result = await readWorkspaceMarker(root);
    expect(result.status).toBe("valid");
    expect(result.marker).toEqual(validMarker);
    expect(await isSafelyYuhiManaged(root)).toBe(true);
  });

  it("reports missing when no marker file exists", async () => {
    expect(await readWorkspaceMarker(root)).toEqual({ status: "missing" });
    expect(await isSafelyYuhiManaged(root)).toBe(false);
  });

  it("reports invalid for bad JSON without throwing", async () => {
    await writeFile(path.join(root, WORKSPACE_MARKER_FILE), "{ not json ", "utf8");
    const result = await readWorkspaceMarker(root);
    expect(result.status).toBe("invalid");
    expect(result.marker).toBeUndefined();
    expect(await isSafelyYuhiManaged(root)).toBe(false);
  });

  it("reports invalid when managedBy is wrong", async () => {
    await writeFile(
      path.join(root, WORKSPACE_MARKER_FILE),
      JSON.stringify({ ...validMarker, managedBy: "someone-else" }),
      "utf8",
    );
    expect((await readWorkspaceMarker(root)).status).toBe("invalid");
    expect(await isSafelyYuhiManaged(root)).toBe(false);
  });

  it("reports invalid when required fields are missing", async () => {
    await writeFile(
      path.join(root, WORKSPACE_MARKER_FILE),
      JSON.stringify({ managedBy: "yuhi" }),
      "utf8",
    );
    expect((await readWorkspaceMarker(root)).status).toBe("invalid");
    expect(await isSafelyYuhiManaged(root)).toBe(false);
  });

  it("returns false for a symlinked workspace even with a valid marker", async () => {
    const realDir = path.join(root, "real");
    await mkdir(realDir, { recursive: true });
    await writeWorkspaceMarker(realDir, validMarker);
    expect(await isSafelyYuhiManaged(realDir)).toBe(true);

    const linkDir = path.join(root, "link");
    await symlink(realDir, linkDir, "dir");
    // Reading through the link still parses the marker...
    expect((await readWorkspaceMarker(linkDir)).status).toBe("valid");
    // ...but the safety gate refuses a symlinked path.
    expect(await isSafelyYuhiManaged(linkDir)).toBe(false);
  });

  it("returns false when the path does not exist", async () => {
    expect(await isSafelyYuhiManaged(path.join(root, "nope"))).toBe(false);
  });
});
