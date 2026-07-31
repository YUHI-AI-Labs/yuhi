import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BackgroundQueue,
  BackgroundStateStore,
  BackgroundPublisher,
  BackgroundWorker,
  ProviderUnavailableError,
  type BackgroundClock,
  type BackgroundProcessor,
  type EnqueueInput,
  type ProcessorMap,
  type PublisherDeps,
  type RawExtraction,
} from "./index.js";

// ── Fake clock: records timers, fires them one at a time on demand ───────────
class FakeClock implements BackgroundClock {
  current = 0;
  private timers: { due: number; cb: () => void; cancelled: boolean }[] = [];
  now(): number {
    return this.current;
  }
  setTimer(cb: () => void, ms: number): () => void {
    const t = { due: this.current + ms, cb, cancelled: false };
    this.timers.push(t);
    return () => {
      t.cancelled = true;
    };
  }
  hasTimers(): boolean {
    return this.timers.some((t) => !t.cancelled);
  }
  fireNext(): void {
    const active = this.timers.filter((t) => !t.cancelled).sort((a, b) => a.due - b.due);
    const t = active[0];
    if (!t) return;
    t.cancelled = true;
    this.current = Math.max(this.current, t.due);
    t.cb();
  }
}

/** Flush pending real fs I/O + microtasks without firing any fake timer. */
async function flushIO(ticks = 30): Promise<void> {
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
}

/** Flush I/O until `cond()` holds (or a cap is hit). No timers fired, no sleeps. */
async function waitFor(cond: () => boolean, max = 1000): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) await new Promise((r) => setImmediate(r));
}

/** A processor that blocks in `run` until manually released. Tracks concurrency. */
function gateProcessor(tracker: { active: number; max: number }) {
  const releases: (() => void)[] = [];
  return {
    processor: {
      async run(item: { relpath: string }): Promise<RawExtraction> {
        tracker.active += 1;
        tracker.max = Math.max(tracker.max, tracker.active);
        await new Promise<void>((res) => releases.push(res));
        tracker.active -= 1;
        return { text: "x", preparedRelpath: `${item.relpath}.md` };
      },
    } satisfies BackgroundProcessor,
    releaseAll(): void {
      while (releases.length) releases.shift()?.();
    },
  };
}

/** Drive a gate-based run to completion by repeatedly flushing I/O + releasing. */
async function driveGate(p: Promise<unknown>, gate: { releaseAll(): void }): Promise<void> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 100000 && !settled; i++) {
    await new Promise((r) => setImmediate(r));
    if (settled) break;
    gate.releaseAll();
  }
  await p;
}

/**
 * Drive an async worker run to completion: flush real fs I/O with setImmediate,
 * then fire the earliest fake timer, repeat until the promise settles. No real
 * sleeps.
 */
async function drive<T>(clock: FakeClock, p: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = p.then(
    (v) => {
      settled = true;
      return v;
    },
    (e) => {
      settled = true;
      throw e;
    },
  );
  for (let i = 0; i < 200000 && !settled; i++) {
    await new Promise((r) => setImmediate(r));
    if (settled) break;
    if (clock.hasTimers()) clock.fireNext();
  }
  return wrapped;
}

const roots: string[] = [];

interface Env {
  root: string;
  baseDir: string;
  publisherDeps: PublisherDeps;
  clock: FakeClock;
}

function makeEnv(): Env {
  const root = mkdtempSync(path.join(tmpdir(), "yuhi-bg-queue-"));
  roots.push(root);
  const agentVisibleRoot = path.join(root, "ws");
  const stagingDir = path.join(root, "private", "staging");
  mkdirSync(agentVisibleRoot, { recursive: true });
  return {
    root,
    baseDir: path.join(root, ".yuhi", "background"),
    clock: new FakeClock(),
    publisherDeps: {
      normalizer: { normalize: (t) => t },
      pseudonymizer: { pseudonymize: (t) => ({ text: t }) },
      inspector: { inspect: () => ({ ok: true, findings: [] }) },
      policy: { evaluate: () => ({ allowed: true }) },
      targets: { agentVisibleRoot, stagingDir },
    },
  };
}

function input(over: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    runId: "run-1",
    contextId: "ctx-1",
    relpath: over.relpath ?? "docs/a.pdf",
    kind: over.kind ?? "document-extraction",
    sourceArtifactPath: over.sourceArtifactPath ?? "/abs/secret/path/docs/a.pdf",
    sourceContentHash: over.sourceContentHash ?? "hash-a",
    processorVersion: "pv1",
    policyHash: "ph1",
    ...over,
  };
}

/** A processor that succeeds immediately, publishing to `<relpath>.md`. */
function okProcessor(onRun?: (relpath: string) => void): BackgroundProcessor {
  return {
    async run(item): Promise<RawExtraction> {
      onRun?.(item.relpath);
      return { text: `extracted:${item.relpath}`, preparedRelpath: `${item.relpath}.md` };
    },
  };
}

function makeWorker(env: Env, queue: BackgroundQueue, processors: ProcessorMap): BackgroundWorker {
  return new BackgroundWorker({
    queue,
    clock: env.clock,
    processors,
    publisher: new BackgroundPublisher(env.publisherDeps),
  });
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("BackgroundStateStore", () => {
  it("dedupes an identical enqueue to a single item", async () => {
    const env = makeEnv();
    const store = await BackgroundStateStore.load(env.baseDir, env.clock);
    const a = await store.enqueue(input());
    const b = await store.enqueue(input());
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.record.item.itemId).toBe(a.record.item.itemId);
    expect(store.all()).toHaveLength(1);
  });

  it("recovers pending items across a restart", async () => {
    const env = makeEnv();
    const s1 = await BackgroundStateStore.load(env.baseDir, env.clock);
    await s1.enqueue(input({ relpath: "a.pdf", sourceContentHash: "h1" }));
    await s1.enqueue(input({ relpath: "b.pdf", sourceContentHash: "h2" }));
    const s2 = await BackgroundStateStore.load(env.baseDir, env.clock);
    expect(s2.pending()).toHaveLength(2);
  });

  it("resets a stale `processing` item to `pending` on recovery", async () => {
    const env = makeEnv();
    const s1 = await BackgroundStateStore.load(env.baseDir, env.clock);
    const { record } = await s1.enqueue(input());
    await s1.update(record.item.itemId, { status: "processing", reasonCode: "background-processing" });
    const s2 = await BackgroundStateStore.load(env.baseDir, env.clock);
    expect(s2.get(record.item.itemId)?.status).toBe("pending");
  });

  it("falls back safely on a corrupt state file (kept-local, state-corrupt, no throw)", async () => {
    const env = makeEnv();
    mkdirSync(path.join(env.baseDir, "items"), { recursive: true });
    writeFileSync(path.join(env.baseDir, "items", "broken.json"), "{ this is : not json");
    const store = await BackgroundStateStore.load(env.baseDir, env.clock);
    const rec = store.get("broken");
    expect(rec?.status).toBe("kept-local");
    expect(rec?.reasonCode).toBe("background-state-corrupt");
  });

  it("keeps the idempotency key stable for the documented inputs", async () => {
    const env = makeEnv();
    const store = await BackgroundStateStore.load(env.baseDir, env.clock);
    const a = await store.enqueue(input({ processorVersion: "pv1" }));
    // Same file, different processorVersion → different key → new item.
    const b = await store.enqueue(input({ processorVersion: "pv2" }));
    expect(b.deduped).toBe(false);
    expect(b.record.item.itemId).not.toBe(a.record.item.itemId);
  });
});

describe("BackgroundWorker lifecycle", () => {
  it("pending → processing → completed on success", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    const { record } = await queue.enqueue(input());
    const worker = makeWorker(env, queue, { "document-extraction": okProcessor() });
    await drive(env.clock, worker.run());
    const r = queue.result(record.item.itemId);
    expect(r?.status).toBe("completed");
    expect(r?.reasonCode).toBe("background-completed");
    expect(r?.preparedRelpath).toBe(path.normalize("docs/a.pdf.md"));
  });

  it("marks an item failed when the processor throws (extraction-failed)", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    const { record } = await queue.enqueue(input());
    const worker = makeWorker(env, queue, {
      "document-extraction": {
        async run() {
          throw new Error("boom");
        },
      },
    });
    await drive(env.clock, worker.run());
    const r = queue.result(record.item.itemId);
    expect(r?.status).toBe("failed");
    expect(r?.reasonCode).toBe("background-extraction-failed");
  });

  it("times out a hanging provider and still terminates the queue", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    const a = await queue.enqueue(input({ relpath: "a.pdf", sourceContentHash: "h1" }));
    const b = await queue.enqueue(input({ relpath: "b.pdf", sourceContentHash: "h2" }));
    const worker = makeWorker(env, queue, {
      "document-extraction": { run: () => new Promise<RawExtraction>(() => {}) },
    });
    await drive(env.clock, worker.run());
    expect(queue.result(a.record.item.itemId)?.status).toBe("timed-out");
    expect(queue.result(a.record.item.itemId)?.reasonCode).toBe("background-timeout");
    expect(queue.result(b.record.item.itemId)?.status).toBe("timed-out");
  });

  it("cancels remaining pending items when the signal is aborted", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    const a = await queue.enqueue(input({ relpath: "a.pdf", sourceContentHash: "h1" }));
    const worker = makeWorker(env, queue, { "document-extraction": okProcessor() });
    const ac = new AbortController();
    ac.abort();
    await drive(env.clock, worker.run({ signal: ac.signal }));
    expect(queue.result(a.record.item.itemId)?.status).toBe("cancelled");
    expect(queue.result(a.record.item.itemId)?.reasonCode).toBe("background-cancelled");
  });

  it("does not re-run a completed item on a repeat enqueue", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    await queue.enqueue(input());
    let runs = 0;
    const worker = makeWorker(env, queue, { "document-extraction": okProcessor(() => (runs += 1)) });
    await drive(env.clock, worker.run());
    expect(runs).toBe(1);
    const again = await queue.enqueue(input());
    expect(again.deduped).toBe(true);
    await drive(env.clock, worker.run());
    expect(runs).toBe(1); // completed item was not processed again
  });

  it("one item's failure does not stop the others", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    const bad = await queue.enqueue(input({ relpath: "bad.pdf", sourceContentHash: "hb" }));
    const good = await queue.enqueue(input({ relpath: "good.pdf", sourceContentHash: "hg" }));
    const worker = makeWorker(env, queue, {
      "document-extraction": {
        async run(item): Promise<RawExtraction> {
          if (item.relpath === "bad.pdf") throw new Error("nope");
          return { text: "ok", preparedRelpath: `${item.relpath}.md` };
        },
      },
    });
    await drive(env.clock, worker.run());
    expect(queue.result(bad.record.item.itemId)?.status).toBe("failed");
    expect(queue.result(good.record.item.itemId)?.status).toBe("completed");
  });

  it("retry resets a terminal item back to pending", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    const { record } = await queue.enqueue(input());
    const worker = makeWorker(env, queue, {
      "document-extraction": {
        async run() {
          throw new Error("boom");
        },
      },
    });
    await drive(env.clock, worker.run());
    expect(queue.result(record.item.itemId)?.status).toBe("failed");
    const retried = await queue.retry(record.item.itemId);
    expect(retried?.status).toBe("pending");
  });
});

describe("BackgroundWorker reliability bounds", () => {
  it("respects the document-extraction concurrency limit (2)", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    for (let i = 0; i < 6; i++) {
      await queue.enqueue(input({ relpath: `f${i}.pdf`, sourceContentHash: `h${i}` }));
    }
    const tracker = { active: 0, max: 0 };
    const gate = gateProcessor(tracker);
    const worker = makeWorker(env, queue, { "document-extraction": gate.processor });
    const run = worker.run({ config: { maxCalls: 100 } });
    await waitFor(() => tracker.active >= 2);
    // Exactly the concurrency limit is in flight; the rest wait.
    expect(tracker.active).toBe(2);
    await flushIO(); // give the pump a chance to (wrongly) exceed the limit
    expect(tracker.max).toBe(2);
    await driveGate(run, gate);
    expect(queue.list().every((i) => i.status === "completed")).toBe(true);
  });

  it("runs Ollama/summarize-local at concurrency 1", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    for (let i = 0; i < 4; i++) {
      await queue.enqueue(
        input({ kind: "summarize-local", relpath: `s${i}.txt`, sourceContentHash: `h${i}` }),
      );
    }
    const tracker = { active: 0, max: 0 };
    const gate = gateProcessor(tracker);
    const worker = makeWorker(env, queue, { "summarize-local": gate.processor });
    const run = worker.run({ config: { maxCalls: 100 } });
    await waitFor(() => tracker.active >= 1);
    expect(tracker.active).toBe(1);
    await flushIO(); // ensure the pump never launches a second summarize concurrently
    expect(tracker.max).toBe(1);
    await driveGate(run, gate);
    expect(tracker.max).toBe(1);
    expect(queue.list().every((i) => i.status === "completed")).toBe(true);
  });

  it("opens the circuit on the first summarize failure — zero further provider calls", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    for (let i = 0; i < 5; i++) {
      await queue.enqueue(
        input({ kind: "summarize-local", relpath: `s${i}.txt`, sourceContentHash: `h${i}` }),
      );
    }
    let calls = 0;
    const worker = makeWorker(env, queue, {
      "summarize-local": {
        async run(): Promise<RawExtraction> {
          calls += 1;
          throw new ProviderUnavailableError();
        },
      },
    });
    const summary = await drive(env.clock, worker.run());
    expect(calls).toBe(1); // circuit opened; no further provider calls
    expect(summary.summarizeCircuitOpened).toBe(true);
    const items = queue.list();
    expect(items).toHaveLength(5);
    expect(items.every((i) => i.status === "kept-local")).toBe(true);
    expect(items.every((i) => i.reasonCode === "background-provider-unavailable")).toBe(true);
  });

  it("sheds work to kept-local once the call-count budget is spent", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    for (let i = 0; i < 5; i++) {
      await queue.enqueue(input({ relpath: `f${i}.pdf`, sourceContentHash: `h${i}` }));
    }
    const worker = makeWorker(env, queue, { "document-extraction": okProcessor() });
    await drive(env.clock, worker.run({ config: { maxCalls: 2 } }));
    const items = queue.list();
    const completed = items.filter((i) => i.status === "completed");
    const shed = items.filter((i) => i.status === "kept-local");
    expect(completed.length).toBe(2);
    expect(shed.length).toBe(3);
    expect(shed.every((i) => i.reasonCode === "background-provider-unavailable")).toBe(true);
  });

  it("completes 100 items under bounded concurrency", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    for (let i = 0; i < 100; i++) {
      await queue.enqueue(input({ relpath: `docs/f${i}.pdf`, sourceContentHash: `h${i}` }));
    }
    const worker = makeWorker(env, queue, { "document-extraction": okProcessor() });
    await drive(
      env.clock,
      worker.run({ config: { maxCalls: 1000, totalBudgetMs: 10_000_000 } }),
    );
    const items = queue.list();
    expect(items).toHaveLength(100);
    expect(items.every((i) => i.status === "completed")).toBe(true);
  });

  it("never leaks an absolute path into public projections", async () => {
    const env = makeEnv();
    const queue = await BackgroundQueue.open(env.baseDir, env.clock);
    const { record } = await queue.enqueue(
      input({ sourceArtifactPath: path.join(env.root, "secret", "orig.pdf") }),
    );
    const worker = makeWorker(env, queue, { "document-extraction": okProcessor() });
    await drive(env.clock, worker.run());
    const blob = JSON.stringify([
      queue.list(),
      queue.status(record.item.itemId),
      queue.result(record.item.itemId),
    ]);
    expect(blob).not.toContain(env.root);
    expect(blob).not.toContain("secret");
  });
});
