/**
 * v0.3.5 same-run revision-reuse E2E (Claude ↔ Codex).
 *
 * Proves the Progressive Context identity contract across a REAL background run and
 * TWO different agent adapters sharing the SAME prepared run:
 *
 *   1. `runBackgroundForRun` drains the private queue and publishes safe companions.
 *   2. Given the SAME prepared run + the SAME public status, the "Claude" adapter and
 *      the "Codex" adapter compute an IDENTICAL `baseContextId` AND an IDENTICAL
 *      `revisionId`, and each records the used revision in its session manifest.
 *   3. Switching agents triggers NO re-scan / re-prepare / re-processing: the second
 *      agent only READS the public status, and re-draining the queue re-runs zero
 *      completed items (zero additional provider calls, byte-identical companions).
 *
 * The agent CLIs are FAKED (createFakeAgentAdapter — no spawn); the local model is a
 * counting fake. Nothing here touches a real network, model, or binary.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BackgroundQueue,
  runBackgroundForRun,
  readPublicStatus,
  reduceProgressiveContextState,
  type PublicBackgroundItem,
  type PublicBackgroundStatus,
  type ProgressiveContextState,
} from "@yuhi/core";
import {
  createFakeAgentAdapter,
  toPublicAgentSessionManifest,
  type AgentAdapter,
  type AgentSessionManifest,
} from "@yuhi/agents";
import type { LocalModelProvider } from "@yuhi/shared";

const RUN = "run-shared";
// A valid, deterministic Context ID — the immutable base fingerprint both agents share.
const CONTEXT_ID = "sha256:" + "a".repeat(64);

let parentDir: string;
let sourceDir: string;
let preparedDir: string;

beforeEach(() => {
  parentDir = mkdtempSync(path.join(tmpdir(), "yuhi-rev-reuse-"));
  sourceDir = path.join(parentDir, "src");
  preparedDir = path.join(parentDir, "prepared-run");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(preparedDir, { recursive: true });
});

afterEach(() => {
  rmSync(parentDir, { recursive: true, force: true });
});

function putSource(rel: string, content: string): string {
  const abs = path.join(sourceDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** A counting local-model provider so we can prove "completed items are not re-run". */
function countingProvider(output: string, calls: { n: number }): LocalModelProvider {
  return {
    id: "fake",
    endpoint: "http://localhost:0",
    defaultModel: "fake",
    async health() {
      return { reachable: true, models: ["fake"] };
    },
    async listModels() {
      return ["fake"];
    },
    async generate() {
      calls.n += 1;
      return output;
    },
  } as unknown as LocalModelProvider;
}

/**
 * Project the PUBLIC status items into the reducer's public-item shape — EXACTLY what
 * an agent adapter can see (path-safe: relpath/kind/status/preparedRelpath only). This
 * is the only background surface either agent reads.
 */
function itemsFromPublicStatus(
  status: PublicBackgroundStatus,
  baseContextId: string,
): PublicBackgroundItem[] {
  return status.items.map((it) => ({
    itemId: "",
    runId: "",
    contextId: baseContextId,
    // A withheld original has no agent-visible path; its identity stands in for one.
    relpath: it.relpath ?? it.documentId ?? "",
    kind: it.kind,
    priority: 0,
    createdAt: 0,
    status: it.status,
    ...(it.preparedRelpath ? { preparedRelpath: it.preparedRelpath } : {}),
  }));
}

/**
 * Simulate what an agent adapter does at launch: prepare + launch against the SAME
 * prepared run, then record the USED Context Revision (derived ONLY from the public
 * status) into its session manifest. Returns the public (path-safe) manifest + state.
 */
async function launchAndRecordRevision(
  adapter: AgentAdapter,
  status: PublicBackgroundStatus,
): Promise<{ manifest: AgentSessionManifest; state: ProgressiveContextState }> {
  const plan = await adapter.prepare({
    contextId: CONTEXT_ID,
    workingDirectory: preparedDir,
    files: [],
  });
  const session = await adapter.launch(plan, { spawn: false, sessionId: `${adapter.id}-session` });

  // The agent computes the revision from the SAME baseContextId + the public status.
  const state = reduceProgressiveContextState({
    baseContextId: session.contextId,
    backgroundItems: itemsFromPublicStatus(status, session.contextId),
  });

  const manifest = toPublicAgentSessionManifest({
    ...session,
    revision: state.revision,
    revisionId: state.revisionId,
  });
  return { manifest, state };
}

describe("same-run Claude ↔ Codex revision reuse (E2E)", () => {
  it("both adapters compute an identical baseContextId + revisionId and record it; switching re-runs nothing", async () => {
    // --- 1. Prepare a small fixture run + enqueue background items --------------------
    const memo = putSource("memo.md", "Meeting agenda and next actions.\n");
    const notes = putSource("notes.md", "Design notes for the new module.\n");
    const queue = await BackgroundQueue.open(path.join(parentDir, ".internal", "background", RUN));
    for (const rel of ["memo.md", "notes.md"]) {
      await queue.enqueue({
        runId: RUN,
        contextId: CONTEXT_ID,
        relpath: rel,
        // Both originals were DELIVERED to the agent, so the companion replaces the
        // file at its own agent-visible path (see `metadata-boundary.ts`).
        publicRelpath: rel,
        kind: "summarize-local",
        sourceArtifactPath: path.join(sourceDir, rel),
        sourceContentHash: `hash-${rel}`,
        processorVersion: "test@1",
        policyHash: "policy-1",
      });
    }

    // --- 2. Drain the queue once → publish safe companions ---------------------------
    const calls = { n: 0 };
    const summary = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      providerFactory: () => countingProvider("A benign, clean summary of the file.", calls),
    });
    expect(summary.completed).toBe(2);
    expect(summary.revision).toBe(2);
    expect(calls.n).toBe(2); // exactly one provider call per item
    const callsAfterFirstRun = calls.n;

    const status = await readPublicStatus(preparedDir);
    expect(status).toBeDefined();
    expect(status!.counts.completed).toBe(2);
    const companionBytesBefore = {
      memo: readFileSync(path.join(preparedDir, "memo.md"), "utf8"),
      notes: readFileSync(path.join(preparedDir, "notes.md"), "utf8"),
    };

    // --- 3. Two DIFFERENT agent adapters, SAME prepared run --------------------------
    const claude = createFakeAgentAdapter({ id: "claude", displayName: "Claude Code" });
    const codex = createFakeAgentAdapter({ id: "codex", displayName: "Codex" });

    const claudeOut = await launchAndRecordRevision(claude, status!);
    const codexOut = await launchAndRecordRevision(codex, status!);

    // Identical base id AND identical revisionId — agent-invariant.
    expect(codexOut.state.baseContextId).toBe(claudeOut.state.baseContextId);
    expect(claudeOut.state.baseContextId).toBe(CONTEXT_ID);
    expect(codexOut.state.revisionId).toBe(claudeOut.state.revisionId);
    expect(codexOut.state.revision).toBe(claudeOut.state.revision);

    // The revisionId also matches what the worker wrote into the public status file.
    expect(claudeOut.state.revisionId).toBe(status!.revisionId);
    expect(claudeOut.state.revision).toBe(status!.revision);

    // Each session manifest RECORDS the used revision (path-safe, agent-tagged distinctly).
    expect(claudeOut.manifest.agent.id).toBe("claude");
    expect(codexOut.manifest.agent.id).toBe("codex");
    expect(claudeOut.manifest.revision).toBe(2);
    expect(claudeOut.manifest.revisionId).toBe(status!.revisionId);
    expect(codexOut.manifest.revision).toBe(claudeOut.manifest.revision);
    expect(codexOut.manifest.revisionId).toBe(claudeOut.manifest.revisionId);
    // The manifest is path-safe — no absolute path leaks through the projection.
    expect(JSON.stringify(codexOut.manifest)).not.toContain(parentDir);

    // --- 4. Switching agents re-runs NOTHING -----------------------------------------
    // Reading the status for the second agent made zero provider calls.
    expect(calls.n).toBe(callsAfterFirstRun);

    // Re-draining the queue (as a second-agent "background start" would) re-runs ZERO
    // completed items: no new provider calls, companions byte-identical, still completed.
    const rerun = await runBackgroundForRun({
      runId: RUN,
      preparedDir,
      providerFactory: () => countingProvider("SHOULD NOT BE CALLED AGAIN", calls),
    });
    expect(calls.n).toBe(callsAfterFirstRun); // completed items were not re-processed
    expect(rerun.callsMade).toBe(0); // no provider work happened on the re-drain
    expect(rerun.completed).toBe(2); // the two items stay completed (projection, not re-run)
    expect(rerun.revision).toBe(2); // revision is stable across the agent switch
    expect(readFileSync(path.join(preparedDir, "memo.md"), "utf8")).toBe(companionBytesBefore.memo);
    expect(readFileSync(path.join(preparedDir, "notes.md"), "utf8")).toBe(companionBytesBefore.notes);

    // The private queue still shows both items completed (not re-queued / duplicated).
    const finalQueue = await BackgroundQueue.open(path.join(parentDir, ".internal", "background", RUN));
    const finalItems = finalQueue.list(RUN);
    expect(finalItems).toHaveLength(2);
    expect(finalItems.every((i) => i.status === "completed")).toBe(true);

    // The private queue state is NOT reachable from the agent-visible prepared root.
    expect(existsSync(path.join(preparedDir, ".internal"))).toBe(false);
  });
});
