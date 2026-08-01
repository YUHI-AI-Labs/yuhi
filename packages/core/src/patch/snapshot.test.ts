import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assertNoPreparedPathCollisions, capturePreparedSnapshot } from "./snapshot.js";
import { computePreparedSnapshotId } from "./provenance.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("prepared patch snapshot", () => {
  it("captures sorted relative content facts and representation without absolute paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yuhi-patch-snapshot-"));
    roots.push(root);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "z.bin"), Buffer.from([1, 0, 2]));
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await chmod(path.join(root, "src", "a.ts"), 0o755);

    const snapshot = await capturePreparedSnapshot(root, {
      contextId: "context",
      revisionId: "revision",
      createdFromRunId: "run-one",
      representationFor: (relpath) => relpath.endsWith(".ts") ? "compressed" : "full",
    });

    expect(snapshot.files.map((file) => file.relpath)).toEqual(["src/a.ts", "z.bin"]);
    expect(snapshot.files[0]).toMatchObject({ representation: "compressed", mode: 0o755, binary: false });
    expect(snapshot.files[1]).toMatchObject({ sizeBytes: 3, binary: true });
    expect(JSON.stringify(snapshot)).not.toContain(root);
  });

  it("keeps baseline identity independent of run id and file order", async () => {
    const files = [
      { relpath: "b", sha256: "bb", sizeBytes: 2, representation: "full" as const, mode: 0o644, binary: false },
      { relpath: "a", sha256: "aa", sizeBytes: 1, representation: "full" as const, mode: 0o644, binary: false },
    ];
    const first = { contextId: "c", revisionId: "r", createdFromRunId: "run-a", files };
    const second = { contextId: "c", revisionId: "r", createdFromRunId: "run-b", files: [...files].reverse() };
    expect(computePreparedSnapshotId(first)).toBe(computePreparedSnapshotId(second));
  });

  it("records a symlink as an unsafe entry without following it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "yuhi-patch-snapshot-"));
    roots.push(root);
    await writeFile(path.join(root, "target.txt"), "safe");
    await symlink("target.txt", path.join(root, "agent-link.txt"));
    const snapshot = await capturePreparedSnapshot(root, {
      contextId: "context", revisionId: "revision", createdFromRunId: "run",
    });
    expect(snapshot.files.find((file) => file.relpath === "agent-link.txt"))
      .toMatchObject({ unsafeType: "symlink", binary: true, sizeBytes: 0 });
  });

  it("fails closed on case and Unicode path aliases", () => {
    expect(() => assertNoPreparedPathCollisions(["src/App.ts", "src/app.ts"]))
      .toThrow("prepared-path-collision");
    expect(() => assertNoPreparedPathCollisions(["caf\u00e9.txt", "cafe\u0301.txt"]))
      .toThrow("prepared-path-collision");
  });

  it("rejects unsafe names before they can enter public patch output", () => {
    expect(() => assertNoPreparedPathCollisions(["src/line\nbreak.ts"]))
      .toThrow("unsafe-prepared-relpath");
    expect(() => assertNoPreparedPathCollisions(["aux.txt"]))
      .toThrow("unsafe-prepared-relpath");
    expect(() => assertNoPreparedPathCollisions(["file.txt:stream"]))
      .toThrow("unsafe-prepared-relpath");
  });
});
