import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicBackgroundStatus, BackgroundRunSummary } from "@yuhi/core";
import type { CorePreparedSession } from "@yuhi/core";
import type { RunResolution } from "./launch.js";
import {
  performBackgroundStatus,
  performBackgroundStart,
  performBackgroundCancel,
  performBackgroundRetry,
  maybeWaitBackground,
  resolveBackgroundRun,
} from "./background.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RUN_ID = "run-abc123";

function makeResolution(preparedDir: string): (ref: string | undefined) => Promise<RunResolution> {
  const session = { runId: RUN_ID, summary: { runId: RUN_ID } } as unknown as CorePreparedSession;
  return async () => ({ ok: true, run: { workspace: preparedDir, session } });
}

function rejectedResolution(category = "blocked"): (ref: string | undefined) => Promise<RunResolution> {
  return async () => ({ ok: false, category });
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, opts: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

function sampleStatus(): PublicBackgroundStatus {
  return {
    schemaVersion: 1,
    counts: {
      total: 3,
      pending: 1,
      processing: 0,
      completed: 1,
      failed: 1,
      keptLocal: 0,
      cancelled: 0,
    },
    revision: 1,
    revisionId: "sha256:" + "b".repeat(64),
    items: [
      { relpath: "docs/a.pdf", kind: "document-extraction", status: "completed", reasonCode: "background-completed", preparedRelpath: "docs/a.pdf.md" },
      { relpath: "docs/b.pdf", kind: "ocr", status: "failed", reasonCode: "background-extraction-failed" },
      { relpath: "notes/c.txt", kind: "summarize-local", status: "pending", reasonCode: "background-pending" },
    ],
  };
}

describe("resolveBackgroundRun", () => {
  it("maps a launchable run to { preparedDir, runId }", async () => {
    const res = await resolveBackgroundRun(undefined, { resolveRun: makeResolution("/prepared/x") });
    expect(res).toEqual({ ok: true, run: { preparedDir: "/prepared/x", runId: RUN_ID } });
  });

  it("propagates a safe category for a stale/unknown run", async () => {
    const res = await resolveBackgroundRun("stale", { resolveRun: rejectedResolution("missing") });
    expect(res).toEqual({ ok: false, category: "missing" });
  });
});

describe("background status", () => {
  it("prints counts + revision + per-item rows from the PUBLIC status file", async () => {
    const { out, opts } = capture();
    const code = await performBackgroundStatus({
      resolveRun: makeResolution("/prepared/s"),
      readStatus: async () => sampleStatus(),
      ...opts,
    });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Revision: 1 (sha256:" + "b".repeat(64) + ")");
    expect(text).toContain("3 items");
    expect(text).toContain("completed 1");
    expect(text).toContain("docs/a.pdf  document-extraction  completed  background-completed");
    expect(text).toContain("notes/c.txt  summarize-local  pending  background-pending");
  });

  it("--json emits the PublicBackgroundStatus shape verbatim", async () => {
    const { out, opts } = capture();
    const status = sampleStatus();
    await performBackgroundStatus({
      json: true,
      resolveRun: makeResolution("/prepared/s"),
      readStatus: async () => status,
      ...opts,
    });
    expect(JSON.parse(out.join("\n"))).toEqual(status);
  });

  it("treats a missing status file as 'no background items' (empty PublicBackgroundStatus)", async () => {
    const { out, opts } = capture();
    await performBackgroundStatus({
      json: true,
      resolveRun: makeResolution("/prepared/s"),
      readStatus: async () => undefined,
      ...opts,
    });
    const parsed = JSON.parse(out.join("\n")) as PublicBackgroundStatus;
    expect(parsed).toEqual({
      schemaVersion: 1,
      counts: { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, keptLocal: 0, cancelled: 0 },
      revision: 0,
      items: [],
    });
  });

  it("reads ONLY the public status file — never the private .internal/background path", async () => {
    // Build a real managed layout: a prepared root with the public status file,
    // plus a SIBLING private dir the CLI must never open.
    const managed = mkdtempSync(path.join(tmpdir(), "yuhi-bg-"));
    roots.push(managed);
    const preparedDir = path.join(managed, RUN_ID);
    mkdirSync(path.join(preparedDir, ".yuhi"), { recursive: true });
    writeFileSync(
      path.join(preparedDir, ".yuhi", "background-status.json"),
      JSON.stringify(sampleStatus()),
    );
    mkdirSync(path.join(managed, ".internal", "background", RUN_ID), { recursive: true });
    writeFileSync(path.join(managed, ".internal", "background", RUN_ID, "queue.json"), "{}");

    const opened: string[] = [];
    const realReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, "readFile").mockImplementation((async (p: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
      opened.push(String(p));
      return (realReadFile as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFile);

    const { opts } = capture();
    // No readStatus injected → exercises the real readPublicStatus default.
    const code = await performBackgroundStatus({ resolveRun: makeResolution(preparedDir), ...opts });
    spy.mockRestore();

    expect(code).toBe(0);
    expect(opened.some((p) => p.includes(".internal"))).toBe(false);
    expect(opened.some((p) => p.endsWith(path.join(".yuhi", "background-status.json")))).toBe(true);
  });

  it("rejects a stale/unknown --run in finite time (exit 3, safe category, no abspath)", async () => {
    const { err, opts } = capture();
    const code = await performBackgroundStatus({
      runRef: "ghost",
      resolveRun: rejectedResolution("missing"),
      ...opts,
    });
    expect(code).toBe(3);
    expect(err.join("\n")).toContain("invalid-or-missing-run (missing)");
  });
});

describe("background start", () => {
  it("drives runBackgroundForRun and prints the public-safe summary", async () => {
    const { out, opts } = capture();
    let received: { runId: string; preparedDir: string } | undefined;
    const summary: BackgroundRunSummary = {
      completed: 2,
      failed: 0,
      keptLocal: 1,
      pending: 0,
      callsMade: 2,
      revision: 2,
    };
    const code = await performBackgroundStart({
      resolveRun: makeResolution("/prepared/run"),
      runBackground: async (input) => ((received = input), summary),
      ...opts,
    });
    expect(code).toBe(0);
    expect(received).toMatchObject({ runId: RUN_ID, preparedDir: "/prepared/run" });
    const text = out.join("\n");
    expect(text).toContain("completed 2");
    expect(text).toContain("kept-local 1");
    expect(text).toContain("calls made 2");
    expect(text).toContain("revision 2");
  });

  it("passes an AbortSignal into the worker (SIGINT cancellation)", async () => {
    const { opts } = capture();
    let sawSignal = false;
    await performBackgroundStart({
      resolveRun: makeResolution("/prepared/run"),
      runBackground: async (input) => {
        sawSignal = input.signal instanceof AbortSignal;
        return { completed: 0, failed: 0, keptLocal: 0, pending: 0, callsMade: 0, revision: 0 };
      },
      ...opts,
    });
    expect(sawSignal).toBe(true);
  });
});

describe("background cancel", () => {
  it("cancels the whole run when no --item is given", async () => {
    const { out, opts } = capture();
    const calls: unknown[] = [];
    const code = await performBackgroundCancel({
      resolveRun: makeResolution("/prepared/run"),
      cancel: async (input) => void calls.push(input),
      ...opts,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([{ runId: RUN_ID, preparedDir: "/prepared/run" }]);
    expect(out.join("\n")).toContain("Cancelled all pending background items");
  });

  it("cancels a single item when --item is given", async () => {
    const { out, opts } = capture();
    const calls: unknown[] = [];
    await performBackgroundCancel({
      itemId: "item-9",
      resolveRun: makeResolution("/prepared/run"),
      cancel: async (input) => void calls.push(input),
      ...opts,
    });
    expect(calls).toEqual([{ runId: RUN_ID, preparedDir: "/prepared/run", itemId: "item-9" }]);
    expect(out.join("\n")).toContain("Cancelled item item-9.");
  });
});

describe("background retry", () => {
  it("--failed-only re-queues only failed/timed-out items via retryTerminal", async () => {
    const { out, opts } = capture();
    let received: { failedOnly?: boolean } | undefined;
    const code = await performBackgroundRetry({
      failedOnly: true,
      resolveRun: makeResolution("/prepared/run"),
      retryTerminal: async (input) => ((received = input), [{}, {}]),
      ...opts,
    });
    expect(code).toBe(0);
    expect(received).toMatchObject({ runId: RUN_ID, failedOnly: true });
    expect(out.join("\n")).toContain("Re-queued 2 background items.");
  });

  it("--item targets exactly one item via retryItem", async () => {
    const { out, opts } = capture();
    let received: { itemId: string } | undefined;
    await performBackgroundRetry({
      itemId: "item-3",
      resolveRun: makeResolution("/prepared/run"),
      retryItem: async (input) => ((received = input as { itemId: string }), { itemId: "item-3" }),
      retryTerminal: async () => {
        throw new Error("must not bulk-retry when --item is given");
      },
      ...opts,
    });
    expect(received).toMatchObject({ itemId: "item-3" });
    expect(out.join("\n")).toContain("Re-queued 1 background item.");
  });

  it("reports 0 when a single retry targets a non-retriable (e.g. completed) item", async () => {
    const { out, opts } = capture();
    await performBackgroundRetry({
      itemId: "done",
      resolveRun: makeResolution("/prepared/run"),
      retryItem: async () => undefined, // core returns undefined for completed
      ...opts,
    });
    expect(out.join("\n")).toContain("Re-queued 0 background items.");
  });
});

describe("prepare --wait-background", () => {
  it("waits (invokes the runner) when the flag is set", async () => {
    const run = vi.fn(async () => ({
      completed: 1,
      failed: 0,
      keptLocal: 0,
      pending: 0,
      callsMade: 1,
      revision: 1,
    }));
    const summary = await maybeWaitBackground({
      wait: true,
      runId: RUN_ID,
      preparedDir: "/prepared/run",
      run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ runId: RUN_ID, preparedDir: "/prepared/run" });
    expect(summary).toMatchObject({ completed: 1, revision: 1 });
  });

  it("does NOT wait by default (flag unset → no runner call)", async () => {
    const run = vi.fn(async () => ({
      completed: 0,
      failed: 0,
      keptLocal: 0,
      pending: 0,
      callsMade: 0,
      revision: 0,
    }));
    const summary = await maybeWaitBackground({
      wait: false,
      runId: RUN_ID,
      preparedDir: "/prepared/run",
      run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(summary).toBeUndefined();
  });
});

describe("no absolute path leaks in any output", () => {
  it("never prints an absolute prepared path across status/start/cancel/retry", async () => {
    const abs = "/Users/secret/managed/" + RUN_ID;
    const sinks: string[] = [];
    const opts = { out: (l: string) => sinks.push(l), err: (l: string) => sinks.push(l) };
    await performBackgroundStatus({ resolveRun: makeResolution(abs), readStatus: async () => sampleStatus(), ...opts });
    await performBackgroundStatus({ json: true, resolveRun: makeResolution(abs), readStatus: async () => sampleStatus(), ...opts });
    await performBackgroundStart({
      resolveRun: makeResolution(abs),
      runBackground: async () => ({ completed: 0, failed: 0, keptLocal: 0, pending: 0, callsMade: 0, revision: 0 }),
      ...opts,
    });
    await performBackgroundCancel({ resolveRun: makeResolution(abs), cancel: async () => {}, ...opts });
    await performBackgroundRetry({ resolveRun: makeResolution(abs), retryTerminal: async () => [], ...opts });
    expect(sinks.join("\n")).not.toContain(abs);
    expect(sinks.join("\n")).not.toContain("/Users/secret");
  });
});
