/**
 * `yuhi background …` — the v0.3.5 Progressive Context control surface.
 *
 * Background preparation (document extraction, OCR, local summarization) keeps
 * running AFTER Yuhi Mode launches. This CLI surface lets a user observe and
 * steer that work WITHOUT ever crossing the v0.3.5 security boundary:
 *
 *  - The PRIVATE queue state (per-item records, cancel flag, staging bytes) lives
 *    OUTSIDE every agent-visible root, under `<managedBase>/.internal/background/`.
 *    This CLI NEVER opens that path and NEVER edits queue JSON directly.
 *  - The ONLY background surface this CLI reads is the PUBLIC status file
 *    (`<preparedDir>/.yuhi/background-status.json`), via `readPublicStatus`.
 *  - Every mutation goes through the `@yuhi/core` control-plane functions
 *    (`runBackgroundForRun`, `requestBackgroundCancel`, `retryBackground*`), which
 *    own the private state and keep the public status current.
 *
 * All output is public-safe by construction: repo-relative paths, `background-*`
 * reason codes, and aggregate counts only — never an absolute path, environment
 * value, secret, or raw error string.
 */
import {
  readPublicStatus,
  runBackgroundForRun,
  requestBackgroundCancel,
  retryBackgroundItem,
  retryBackgroundTerminal,
  type PublicBackgroundStatus,
  type BackgroundRunSummary,
} from "@yuhi/core";
import type { LocalModelProvider } from "@yuhi/shared";
import { loadConfig } from "@yuhi/config";
import { createLocalModelProvider } from "@yuhi/local";
import { providerConfigFromSettings } from "./local-ai.js";
import { resolveRunForLaunch, type RunResolution } from "./launch.js";

/** A background command that has resolved a launchable prepared run. */
export interface ResolvedBackgroundRun {
  preparedDir: string;
  runId: string;
}

export type BackgroundRunResolution =
  | { ok: true; run: ResolvedBackgroundRun }
  | { ok: false; category: string };

/** Injectable drivers so every command is unit-testable with fakes (no real Ollama/OCR/network). */
export interface BackgroundDeps {
  resolveRun?: (ref: string | undefined) => Promise<RunResolution>;
  readStatus?: (preparedDir: string) => Promise<PublicBackgroundStatus | undefined>;
  runBackground?: (input: {
    runId: string;
    preparedDir: string;
    signal?: AbortSignal;
  }) => Promise<BackgroundRunSummary>;
  cancel?: (input: { runId: string; preparedDir: string; itemId?: string }) => Promise<void>;
  retryItem?: (input: { runId: string; preparedDir: string; itemId: string }) => Promise<unknown>;
  retryTerminal?: (input: {
    runId: string;
    preparedDir: string;
    failedOnly?: boolean;
  }) => Promise<readonly unknown[]>;
}

export interface BackgroundCommonOptions extends BackgroundDeps {
  runRef?: string;
  json?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** The public-safe empty status used when no background status file exists yet. */
function emptyStatus(): PublicBackgroundStatus {
  return {
    schemaVersion: 1,
    counts: {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      keptLocal: 0,
      companionUnavailable: 0,
      cancelled: 0,
    },
    revision: 0,
    items: [],
  };
}

/**
 * Resolve the prepared run a background command targets. Reuses the launch
 * run-resolution (latest launchable / explicit `--run`; a stale/unknown/blocked
 * reference is REJECTED with a safe category in finite time — never hangs).
 */
export async function resolveBackgroundRun(
  ref: string | undefined,
  deps?: Pick<BackgroundDeps, "resolveRun">,
): Promise<BackgroundRunResolution> {
  const resolveRun = deps?.resolveRun ?? ((r) => resolveRunForLaunch(r));
  const resolution = await resolveRun(ref);
  if (!resolution.ok) return { ok: false, category: resolution.category };
  return {
    ok: true,
    run: { preparedDir: resolution.run.workspace, runId: resolution.run.session.runId },
  };
}

/** Emit the safe, finite run-resolution failure and return exit code 3. */
function reportUnresolved(
  command: string,
  category: string,
  opts: Pick<BackgroundCommonOptions, "json" | "out" | "err">,
): number {
  const out = opts.out ?? ((l: string) => console.log(l));
  const err = opts.err ?? ((l: string) => console.error(l));
  if (opts.json) out(JSON.stringify({ command, error: "invalid-or-missing-run", category }, null, 2));
  else err(`Recovery required\n\nSafe error category: invalid-or-missing-run (${category})`);
  return 3;
}

function formatCounts(counts: PublicBackgroundStatus["counts"]): string {
  return [
    `pending ${counts.pending}`,
    `processing ${counts.processing}`,
    `completed ${counts.completed}`,
    `failed ${counts.failed}`,
    `kept-local ${counts.keptLocal}`,
    `companion-unavailable ${counts.companionUnavailable}`,
    `cancelled ${counts.cancelled}`,
  ].join(" · ");
}

/**
 * `yuhi background status` — read the PUBLIC status file and print counts by
 * status, per-item `{relpath, kind, status, reasonCode}`, and revision/revisionId.
 * A missing status file is reported as "no background items". `--json` emits the
 * `PublicBackgroundStatus` shape verbatim (already public-safe).
 */
export async function performBackgroundStatus(opts: BackgroundCommonOptions): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const readStatus = opts.readStatus ?? readPublicStatus;

  const resolution = await resolveBackgroundRun(opts.runRef, opts);
  if (!resolution.ok) return reportUnresolved("background status", resolution.category, opts);

  const status = (await readStatus(resolution.run.preparedDir)) ?? emptyStatus();

  if (opts.json) {
    out(JSON.stringify(status, null, 2));
    return 0;
  }

  out("Background status");
  const rev = status.revisionId ? `${status.revision} (${status.revisionId})` : String(status.revision);
  out(`  Revision: ${rev}`);
  out(`  ${status.counts.total} items — ${formatCounts(status.counts)}`);
  if (status.items.length === 0) {
    out("  (no background items)");
    return 0;
  }
  for (const item of status.items) {
    const reason = item.reasonCode ? `  ${item.reasonCode}` : "";
    // A withheld original is listed by its public label, never by its filename.
    const label = item.relpath ?? item.displayName ?? item.documentId ?? "(document)";
    out(`  ${label}  ${item.kind}  ${item.status}${reason}`);
  }
  return 0;
}

/** Best-effort default runner: wires the local provider + config from the prepared run. */
async function defaultRunBackground(input: {
  runId: string;
  preparedDir: string;
  signal?: AbortSignal;
}): Promise<BackgroundRunSummary> {
  let config: Awaited<ReturnType<typeof loadConfig>>["config"] | undefined;
  let providerFactory: (() => LocalModelProvider | undefined) | undefined;
  try {
    const loaded = await loadConfig(input.preparedDir);
    config = loaded.config;
    providerFactory = () =>
      createLocalModelProvider(providerConfigFromSettings(loaded.config.local_model));
  } catch {
    // No usable config next to the prepared run → local model treated as unavailable
    // (summarize items are kept local; document extraction still runs).
  }
  return runBackgroundForRun({
    runId: input.runId,
    preparedDir: input.preparedDir,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(config ? { config } : {}),
    ...(providerFactory ? { providerFactory } : {}),
  });
}

/**
 * `yuhi prepare --wait-background` opt-in: when `wait` is set, run the run's
 * background queue to completion before prepare returns. Default (`wait === false`)
 * is a no-op — prepare enqueues only and returns immediately. Returns the summary
 * when it waited, or `undefined` when it did not.
 */
export async function maybeWaitBackground(opts: {
  wait: boolean;
  runId: string;
  preparedDir: string;
  run?: (input: {
    runId: string;
    preparedDir: string;
    signal?: AbortSignal;
  }) => Promise<BackgroundRunSummary>;
}): Promise<BackgroundRunSummary | undefined> {
  if (!opts.wait) return undefined;
  const run = opts.run ?? defaultRunBackground;
  return run({ runId: opts.runId, preparedDir: opts.preparedDir });
}

/**
 * `yuhi background start` — drain the run's queue to completion, printing a final
 * public-safe summary. Cancellable via SIGINT (an AbortController is signalled and
 * threaded into the core worker, which discards any late provider result).
 */
export async function performBackgroundStart(opts: BackgroundCommonOptions): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const runBackground = opts.runBackground ?? defaultRunBackground;

  const resolution = await resolveBackgroundRun(opts.runRef, opts);
  if (!resolution.ok) return reportUnresolved("background start", resolution.category, opts);

  if (!opts.json) out("Starting background preparation…");

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once("SIGINT", onSigint);
  let summary: BackgroundRunSummary;
  try {
    summary = await runBackground({
      runId: resolution.run.runId,
      preparedDir: resolution.run.preparedDir,
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  if (opts.json) {
    out(JSON.stringify({ command: "background start", ...summary }, null, 2));
    return 0;
  }
  out("Background preparation complete");
  out(`  completed ${summary.completed}`);
  out(`  failed ${summary.failed}`);
  out(`  kept-local ${summary.keptLocal}`);
  out(`  pending ${summary.pending}`);
  out(`  calls made ${summary.callsMade}`);
  out(`  revision ${summary.revision}`);
  return 0;
}

/**
 * `yuhi background cancel` — persistently request cancellation of a single item
 * (`--item`) or the whole run. The core call updates status + refreshes the public
 * status file; this CLI never touches the private cancel flag directly.
 */
export async function performBackgroundCancel(
  opts: BackgroundCommonOptions & { itemId?: string },
): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const cancel = opts.cancel ?? requestBackgroundCancel;

  const resolution = await resolveBackgroundRun(opts.runRef, opts);
  if (!resolution.ok) return reportUnresolved("background cancel", resolution.category, opts);

  await cancel({
    runId: resolution.run.runId,
    preparedDir: resolution.run.preparedDir,
    ...(opts.itemId ? { itemId: opts.itemId } : {}),
  });

  const scope = opts.itemId ? "item" : "run";
  if (opts.json) {
    out(
      JSON.stringify(
        { command: "background cancel", cancelled: scope, ...(opts.itemId ? { itemId: opts.itemId } : {}) },
        null,
        2,
      ),
    );
    return 0;
  }
  out(opts.itemId ? `Cancelled item ${opts.itemId}.` : "Cancelled all pending background items for this run.");
  return 0;
}

/**
 * `yuhi background retry` — re-queue a single terminal item (`--item`) or every
 * terminal item (`--failed-only` restricts to failed / timed-out). A `completed`
 * item is never retried — that invariant is enforced in core.
 */
export async function performBackgroundRetry(
  opts: BackgroundCommonOptions & { itemId?: string; failedOnly?: boolean },
): Promise<number> {
  const out = opts.out ?? ((l: string) => console.log(l));

  const resolution = await resolveBackgroundRun(opts.runRef, opts);
  if (!resolution.ok) return reportUnresolved("background retry", resolution.category, opts);

  let requeued: number;
  if (opts.itemId) {
    const retryItem = opts.retryItem ?? retryBackgroundItem;
    const result = await retryItem({
      runId: resolution.run.runId,
      preparedDir: resolution.run.preparedDir,
      itemId: opts.itemId,
    });
    requeued = result ? 1 : 0;
  } else {
    const retryTerminal = opts.retryTerminal ?? retryBackgroundTerminal;
    const result = await retryTerminal({
      runId: resolution.run.runId,
      preparedDir: resolution.run.preparedDir,
      ...(opts.failedOnly !== undefined ? { failedOnly: opts.failedOnly } : {}),
    });
    requeued = result.length;
  }

  if (opts.json) {
    out(JSON.stringify({ command: "background retry", requeued }, null, 2));
    return 0;
  }
  out(`Re-queued ${requeued} background ${requeued === 1 ? "item" : "items"}.`);
  return 0;
}
