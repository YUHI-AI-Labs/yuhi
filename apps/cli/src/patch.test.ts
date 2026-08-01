import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { capturePatchSession } from "@yuhi/core";
import type { RunResolution } from "./launch.js";
import { patchApply, patchDiff, patchDiscard, patchStatus, patchValidate } from "./patch.js";

const ID = `sha256:${"b".repeat(64)}`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "yuhi-patch-cli-"));
  const managedBase = path.join(root, "managed");
  const sourceRoot = path.join(root, "source");
  const preparedRoot = path.join(root, "prepared");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(preparedRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "app.ts"), "export const value = 1;\n");
  await writeFile(path.join(preparedRoot, "app.ts"), "export const value = 1;\n");
  await capturePatchSession({
    managedBase,
    runId: "run-1",
    sessionId: "session-1",
    contextId: ID,
    revisionId: ID,
    preparedRoot,
    sourceRoot,
  });
  const resolution: RunResolution = {
    ok: true,
    run: { workspace: preparedRoot, session: { runId: "run-1" } as never },
  };
  const resolveRun = async () => resolution;
  return { managedBase, sourceRoot, preparedRoot, resolveRun };
}

describe("CLI Safe Patch Review", () => {
  it("returns a stable metadata-safe JSON error for an unknown run", async () => {
    const lines: string[] = [];
    const code = await patchStatus({
      json: true,
      resolveRun: async () => ({ ok: false, category: "not-found" }),
      err: (line) => lines.push(line),
    });
    expect(code).toBe(3);
    expect(JSON.parse(lines.join("\n"))).toEqual({
      schemaVersion: 1,
      command: "patch-status",
      status: "failed",
      errorCategory: "patch-session-not-found",
    });
  });

  it("status and validation expose stable metadata only", async () => {
    const f = await fixture();
    await writeFile(path.join(f.preparedRoot, "app.ts"), "export const value = 2;\n");
    const lines: string[] = [];
    expect(await patchStatus({ ...f, json: true, out: (line) => lines.push(line) })).toBe(0);
    expect(await patchValidate({ ...f, json: true, out: (line) => lines.push(line) })).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain('"patch-modified"');
    expect(output).toContain('"relpath": "app.ts"');
    expect(output).not.toContain(f.sourceRoot);
    expect(output).not.toContain("export const value");
  });

  it("masks raw secret and personal data in patch diff JSON", async () => {
    const f = await fixture();
    const secret = `sk-proj-${"x".repeat(24)}`;
    const email = "synthetic.person@example.com";
    await writeFile(path.join(f.preparedRoot, "generated.txt"), `token=${secret}\ncontact=${email}\n`);
    const lines: string[] = [];
    expect(await patchDiff({ ...f, json: true, out: (line) => lines.push(line) })).toBe(0);
    const output = lines.join("\n");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(email);
    expect(output).toContain("REDACTED SECRET");
    expect(output).toContain("REDACTED PERSONAL DATA");
    expect(output).toContain("preparedWorkingTreeId");
  });

  it("applies only explicitly selected eligible files after confirmation", async () => {
    const f = await fixture();
    await writeFile(path.join(f.preparedRoot, "app.ts"), "export const value = 2;\n");
    await writeFile(path.join(f.preparedRoot, "notes.md"), "agent note\n");
    const code = await patchApply({
      ...f,
      files: ["app.ts"],
      confirmApply: async () => true,
      out: () => {},
    });
    expect(code).toBe(0);
    expect(await readFile(path.join(f.sourceRoot, "app.ts"), "utf8")).toContain("value = 2");
    await expect(readFile(path.join(f.sourceRoot, "notes.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await patchApply({
      ...f,
      files: ["notes.md"],
      confirmApply: async () => true,
      out: () => {},
    })).toBe(0);
    expect(await readFile(path.join(f.sourceRoot, "notes.md"), "utf8")).toBe("agent note\n");
  });

  it("never applies a generated credential file", async () => {
    const f = await fixture();
    const raw = `API_KEY=sk-${"x".repeat(32)}\n`;
    await writeFile(path.join(f.preparedRoot, ".env"), raw);
    const output: string[] = [];
    expect(await patchApply({
      ...f,
      files: [".env"],
      confirmApply: async () => true,
      err: (line) => output.push(line),
    })).toBe(2);
    expect(output.join("\n")).not.toContain(raw.trim());
    await expect(readFile(path.join(f.sourceRoot, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discard restores the private baseline without changing Source", async () => {
    const f = await fixture();
    await writeFile(path.join(f.preparedRoot, "app.ts"), "agent edit\n");
    expect(await patchDiscard({ ...f, out: () => {} })).toBe(0);
    expect(await readFile(path.join(f.preparedRoot, "app.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await readFile(path.join(f.sourceRoot, "app.ts"), "utf8")).toBe("export const value = 1;\n");
  });
});
