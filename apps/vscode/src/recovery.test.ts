import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RecoverableCommandRunner, validatePreparedWorkspace } from "./recovery.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "yuhi-recovery-"));
  const managed = path.join(root, "workspaces");
  const quarantine = path.join(root, "quarantine");
  const workspace = path.join(managed, "run-new");
  await mkdir(path.join(workspace, ".yuhi"), { recursive: true });
  await mkdir(quarantine, { recursive: true });
  await writeFile(path.join(workspace, "manifest.json"), JSON.stringify({
    runId: "new",
    files: [],
    tabularAcceptance: { launchAllowed: true, rawFallbackUsed: false },
  }));
  await writeFile(path.join(workspace, ".yuhi", "session.json"), JSON.stringify({
    schemaVersion: 2, preparedBy: "Yuhi", runId: "new", preparationResult: "complete",
  }));
  return {
    root,
    managed,
    quarantine,
    managedBase: managed,
    quarantineBase: quarantine,
    workspace,
  };
}

describe("Prepared Workspace recovery reconciliation", () => {
  it("accepts a complete direct managed child", async () => {
    const f = await fixture();
    expect(await validatePreparedWorkspace(f)).toMatchObject({ kind: "valid", runId: "new" });
    await rm(f.root, { recursive: true });
  });

  it("accepts a complete run whose unavailable files were omitted", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, "manifest.json"), JSON.stringify({
      runId: "new",
      files: [{
        relpath: "unavailable.dat",
        status: "error",
        omitted: true,
        transmission: "blocked",
      }],
      tabularAcceptance: { launchAllowed: true, rawFallbackUsed: false },
    }));
    expect(await validatePreparedWorkspace(f)).toMatchObject({ kind: "valid", runId: "new" });
    await rm(f.root, { recursive: true });
  });

  it("accepts a launchable run whose high-risk file was INCLUDED with a warning", async () => {
    // High-risk findings are informational only — an included-unverified file is the
    // intended successful outcome and must NOT trigger recovery.
    const f = await fixture();
    await writeFile(path.join(f.workspace, "manifest.json"), JSON.stringify({
      runId: "new",
      files: [{
        relpath: "records.csv",
        status: "ok",
        omitted: false,
        transmission: "approved",
        outcome: "included-unverified",
        unresolvedHighRiskCount: 4,
      }],
      tabularAcceptance: { launchAllowed: true, rawFallbackUsed: false },
    }));
    expect(await validatePreparedWorkspace(f)).toMatchObject({ kind: "valid", runId: "new" });
    await rm(f.root, { recursive: true });
  });

  it.each([
    ["deleted workspace", async (f: Awaited<ReturnType<typeof fixture>>) => rm(f.workspace, { recursive: true }), "prepared-workspace-missing"],
    ["missing manifest", async (f) => rm(path.join(f.workspace, "manifest.json")), "manifest-missing"],
    ["missing session", async (f) => rm(path.join(f.workspace, ".yuhi", "session.json")), "session-missing"],
    ["malformed manifest", async (f) => writeFile(path.join(f.workspace, "manifest.json"), "{"), "manifest-invalid"],
    ["malformed session", async (f) => writeFile(path.join(f.workspace, ".yuhi", "session.json"), "{"), "session-invalid"],
  ])("requires recovery for %s", async (_label, mutate, reason) => {
    const f = await fixture();
    await mutate(f);
    expect(await validatePreparedWorkspace(f)).toMatchObject({ kind: "recovery-required", reason });
    await rm(f.root, { recursive: true, force: true });
  });

  it("never launches a quarantined run", async () => {
    const f = await fixture();
    const moved = path.join(f.quarantine, "run-old");
    await mkdir(path.dirname(moved), { recursive: true });
    await (await import("node:fs/promises")).rename(f.workspace, moved);
    expect(await validatePreparedWorkspace({ ...f, workspace: moved }))
      .toMatchObject({ kind: "recovery-required", reason: "run-quarantined" });
    await rm(f.root, { recursive: true });
  });

  it("fails closed for a legacy run without safe launch metadata", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, "manifest.json"), JSON.stringify({
      runId: "new",
      files: [],
    }));
    expect(await validatePreparedWorkspace(f))
      .toMatchObject({ kind: "recovery-required", reason: "preparation-incomplete" });
    await rm(f.root, { recursive: true });
  });

  it("rejects incomplete, mismatched, and nested runs", async () => {
    for (const kind of ["started", "mismatch", "nested"] as const) {
      const f = await fixture();
      if (kind === "started") {
        await writeFile(path.join(f.workspace, ".yuhi", "session.json"), JSON.stringify({
          schemaVersion: 2, preparedBy: "Yuhi", runId: "new", preparationResult: "started",
        }));
      } else if (kind === "mismatch") {
        await writeFile(path.join(f.workspace, ".yuhi", "session.json"), JSON.stringify({
          schemaVersion: 2, preparedBy: "Yuhi", runId: "old", preparationResult: "complete",
        }));
      } else {
        await writeFile(path.join(f.managed, "manifest.json"), JSON.stringify({
          runId: "parent",
          files: [],
          tabularAcceptance: { launchAllowed: true, rawFallbackUsed: false },
        }));
      }
      expect((await validatePreparedWorkspace(f)).kind).toBe("recovery-required");
      await rm(f.root, { recursive: true });
    }
  });
});

describe("RecoverableCommandRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("rejects duplicate clicks and clears after completion", async () => {
    const runner = new RecoverableCommandRunner();
    let finish!: () => void;
    const first = runner.run(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { kind: "success" };
    });
    expect(await runner.run(async () => ({ kind: "success" }))).toEqual({ kind: "already-running" });
    finish();
    expect(await first).toEqual({ kind: "success" });
    expect(runner.isRunning).toBe(false);
  });

  it("clears the in-flight guard after deterministic cancellation and permits retry", async () => {
    const runner = new RecoverableCommandRunner();
    const controller = new AbortController();
    let started!: () => void;
    const checkpoint = new Promise<void>((resolve) => { started = resolve; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const first = runner.run(async () => {
        started();
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { kind: "cancelled" };
      });
      await checkpoint;
      expect(runner.isRunning).toBe(true);
      expect(await runner.run(async () => ({ kind: "success" })))
        .toEqual({ kind: "already-running" });
      controller.abort();
      expect(await first).toEqual({ kind: "cancelled" });
      expect(runner.isRunning).toBe(false);
      expect(await runner.run(async () => ({ kind: "success" }))).toEqual({ kind: "success" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("clears after failure and virtual-time timeout so retry remains possible", async () => {
    const runner = new RecoverableCommandRunner();
    expect(await runner.run(async () => { throw new Error("synthetic"); }))
      .toEqual({ kind: "failed", category: "unexpected-error" });
    vi.useFakeTimers();
    const timed = runner.run(async () => new Promise(() => undefined), 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await timed).toEqual({ kind: "timeout" });
    expect(runner.isRunning).toBe(false);
    expect(await runner.run(async () => ({ kind: "success" }))).toEqual({ kind: "success" });
  });
});
