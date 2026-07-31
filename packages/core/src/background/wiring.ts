/**
 * v0.3.5 real-processor wiring for the BackgroundPreparationQueue.
 *
 * The queue engine (`BackgroundQueue` / `BackgroundWorker` / `BackgroundPublisher`)
 * is deliberately processor-agnostic: every heavy step and every safety primitive is
 * injected. This module supplies the REAL implementations — document/OCR extraction,
 * local summarization, and the normalize → pseudonymize → inspect → policy safety
 * gate — and exposes {@link runBackgroundForRun}: open the run's persistent queue,
 * drain it under all reliability bounds, and return a path-safe public summary.
 *
 * Security invariants preserved here:
 *  - The ORIGINAL document/source (`item.sourceArtifactPath`, an absolute internal
 *    path) is NEVER copied into the agent-visible workspace. Only the sanitized,
 *    safety-verified companion text is ever published (by the publisher).
 *  - Pre-inspection bytes are written to a private staging dir OUTSIDE the prepared
 *    (agent-visible) root, then atomically renamed in on full success only.
 *  - Providers (Ollama / OCR) are injected; when one is unavailable the processor
 *    throws {@link ProviderUnavailableError} so the item is kept local (never a
 *    best-effort raw publish), and the summarize circuit opens for the run.
 *  - The returned summary carries counts only — never an absolute path.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  classifyStudentRecordHeaders,
  parseDelimitedTable,
  type LocalModelProvider,
} from "@yuhi/shared";
import type { YuhiConfig } from "@yuhi/config";
import { createPseudonymizer, inMemoryMappingStore } from "@yuhi/processors";
import { runDetectors } from "@yuhi/scanner";
import { resolvePolicy } from "@yuhi/policy";

import { buildDocumentArtifact, type DocumentSourceType, type PdfTextExtractor } from "../document-artifact.js";
import { runLocalPreparation } from "../route-executor.js";
import { BackgroundQueue } from "./queue.js";
import {
  BackgroundPublisher,
  type Normalizer,
  type Pseudonymizer,
  type SafetyFinding,
  type SafetyInspector,
  type PolicyEvaluator,
  type RawExtraction,
} from "./publisher.js";
import {
  BackgroundWorker,
  ProviderUnavailableError,
  type BackgroundProcessor,
  type ProcessorMap,
  type WorkerConfig,
} from "./worker.js";
import { systemBackgroundClock, type BackgroundClock, type BackgroundPreparationItem } from "./types.js";

/**
 * Public, path-safe summary of a background run. Counts only — NO absolute paths, no
 * file contents, no reason strings beyond the aggregate tallies. Safe for the CLI /
 * VS Code / an agent to display.
 */
export interface BackgroundRunSummary {
  /** Items whose sanitized companion was published into the prepared workspace. */
  completed: number;
  /** Items that errored during extraction/publication (original never shared). */
  failed: number;
  /** Items withheld safely (safety-rejected, provider-unavailable, budget/circuit). */
  keptLocal: number;
  /** Items still pending after the run (e.g. cancelled batch). */
  pending: number;
  /** Provider-backed calls the worker actually started this run. */
  callsMade: number;
}

export interface RunBackgroundForRunInput {
  /** The run whose deferred items to process. */
  runId: string;
  /** Absolute path to the prepared workspace root (== PrepareReport.outDir). */
  preparedDir: string;
  /** Cooperative cancellation for the whole batch. */
  signal?: AbortSignal;
  /** Injectable clock/timer (tests drive time with no real sleeps). */
  clock?: BackgroundClock;
  /** Loaded config — supplies the real policy + scan settings for the safety gate. */
  config?: YuhiConfig;
  /**
   * Local-model provider factory for `summarize-local`. Omit (or return undefined) to
   * mark the local model UNAVAILABLE — every summarize item is then kept local with
   * zero provider calls. FAKED/injected in tests; never a real network/model here.
   */
  providerFactory?: () => LocalModelProvider | undefined;
  /**
   * PDF text / OCR extractor. Omit to mark OCR unavailable (OCR items kept local).
   * Injected in tests so no real pdftotext/OCR binary or network is used.
   */
  pdfTextExtractor?: PdfTextExtractor;
  /** Per-run worker bound overrides (per-item timeout, budget, call cap, concurrency). */
  workerConfig?: Partial<WorkerConfig>;
}

const SUMMARIZE_PIPELINE = ["summarize-local", "pseudonymize", "safety-check"] as const;

/** Map a repo-relative path to a document source type (extension based). */
function documentSourceTypeOf(relpath: string): DocumentSourceType | undefined {
  const ext = relpath.slice(relpath.lastIndexOf(".")).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".docm") return "docm";
  if (ext === ".pptx") return "pptx";
  if (ext === ".pptm") return "pptm";
  return undefined;
}

/** Best-effort direct-identifier values from a delimited (CSV/TSV) table. */
function extractTabularIdentifiers(content: string): string[] {
  try {
    const table = parseDelimitedTable(content);
    const header = table.rows[0];
    if (!header) return [];
    const classification = classifyStudentRecordHeaders(header);
    const ids = new Set<string>();
    for (const row of table.rows.slice(1)) {
      for (const index of classification.directIdentifierIndexes) {
        const value = (row[index] ?? "").trim();
        if (value) ids.add(value);
      }
    }
    return [...ids];
  } catch {
    return [];
  }
}

// Email / phone / labelled-name PII the structural detectors may not flag on free text.
const PERSONAL_DATA_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+\d{1,3}[- ]?)?(?:\(\d{2,4}\)[- ]?)?\d{2,4}[- ]\d{2,4}[- ]\d{3,4}|(?:氏名|full\s*name|address|住所)\s*[:：]/i;

/**
 * Build the real safety primitives injected into the publisher. Each wraps the same
 * production module the foreground pipeline uses, so a background publish is gated by
 * the identical normalize → pseudonymize → secret/PII inspect → policy checks.
 */
function buildSafetyPrimitives(config?: YuhiConfig): {
  normalizer: Normalizer;
  pseudonymizer: Pseudonymizer;
  inspector: SafetyInspector;
  policy: PolicyEvaluator;
} {
  const entropyThreshold = config?.scan?.entropy_threshold ?? 4.0;
  const keywords = config?.scan?.keywords ?? [];
  const defaultAction = config?.defaults?.action ?? "allow";
  const rules = config?.rules ?? [];

  const normalizer: Normalizer = {
    // Canonicalize line endings + Unicode form before de-identification so detectors
    // and pseudonymization see a stable representation.
    normalize: (text) => text.replace(/\r\n?/g, "\n").normalize("NFC"),
  };

  const pseudonymizer: Pseudonymizer = {
    pseudonymize: (text) => {
      const identifiers = extractTabularIdentifiers(text);
      const result = createPseudonymizer({
        identifiers,
        store: inMemoryMappingStore(),
      }).process(text) as { output: string };
      return { text: result.output };
    },
  };

  const inspector: SafetyInspector = {
    // Inspect ALREADY-pseudonymized text. ANY secret/PII finding ⇒ keep-local.
    inspect: (text) => {
      const findings: SafetyFinding[] = runDetectors(text, {
        entropyThreshold,
        keywords,
      }).map((f) => ({ category: f.detector }));
      if (PERSONAL_DATA_PATTERN.test(text)) findings.push({ category: "personal-data" });
      return { ok: findings.length === 0, findings };
    },
  };

  const policy: PolicyEvaluator = {
    evaluate: (relpath) => {
      const evaluation = resolvePolicy(
        { defaultAction, rules, interactive: false },
        [{ relpath, findings: [] }],
      );
      const action = evaluation.decisions[0]?.action ?? defaultAction;
      // Only actions that permit external (agent) delivery may be published.
      const allowed = !(
        action === "block" ||
        action === "local-only" ||
        action === "ask" ||
        action === "inject"
      );
      return { allowed };
    },
  };

  return { normalizer, pseudonymizer, inspector, policy };
}

/**
 * Build the REAL processor map. `document-extraction` and `ocr` run the shared
 * document companion builder (original never shared); `summarize-local` runs the
 * local preparation pipeline behind an injected provider.
 */
function buildProcessors(input: RunBackgroundForRunInput): ProcessorMap {
  const { providerFactory, pdfTextExtractor, config } = input;
  const mode = config?.budget?.reduction_mode ?? "balanced";

  const extractDocument = async (
    item: BackgroundPreparationItem,
    forceExtractor: PdfTextExtractor | undefined,
  ): Promise<RawExtraction> => {
    const sourceType = documentSourceTypeOf(item.relpath) ?? "pdf";
    const stat = await fs.stat(item.sourceArtifactPath);
    const artifact = await buildDocumentArtifact({
      sourceType,
      absPath: item.sourceArtifactPath,
      sizeBytes: stat.size,
      readBuffer: () => fs.readFile(item.sourceArtifactPath),
      ...(forceExtractor ? { extractPdfText: forceExtractor } : {}),
    });
    // The sanitized companion (or safe placeholder) markdown — never the original.
    return { text: artifact.markdown, preparedRelpath: `${item.relpath}.md` };
  };

  const documentExtraction: BackgroundProcessor = {
    run: (item) => extractDocument(item, pdfTextExtractor),
  };

  const summarizeLocal: BackgroundProcessor = {
    run: async (item, signal) => {
      const provider = providerFactory?.();
      // Provider vanished between build and run ⇒ keep local; the worker (summarize
      // path) treats ProviderUnavailableError as kept-local and opens the circuit.
      if (!provider) throw new ProviderUnavailableError("local model provider unavailable");
      const content = await fs.readFile(item.sourceArtifactPath, "utf8");
      const prepared = await runLocalPreparation(content, [...SUMMARIZE_PIPELINE], {
        provider,
        mode,
        signal,
      });
      // A provider outage surfaces as an error result (runLocalPreparation never
      // throws it) — translate to unavailable so the item is kept local, not "failed".
      if (prepared.status === "error") {
        throw new ProviderUnavailableError(prepared.error ?? "local preparation error");
      }
      // On any other non-approved outcome, return the (unverified) text and let the
      // publisher's safety gate reject it → keep-local. Never a best-effort publish.
      return { text: prepared.output, preparedRelpath: item.relpath };
    },
  };

  const processors: ProcessorMap = { "document-extraction": documentExtraction };
  // OCR is only wired when an extractor is configured. When it is absent, the worker
  // finds no processor for the `ocr` kind and keeps the item local (never "failed"):
  // an unavailable OCR provider must be a safe keep-local, not an error.
  if (pdfTextExtractor) {
    processors.ocr = { run: (item) => extractDocument(item, pdfTextExtractor) };
  }
  // Likewise summarize-local is only wired when a provider factory is supplied; absent,
  // the worker keeps each summarize item local and opens the circuit — zero calls.
  if (providerFactory) {
    processors["summarize-local"] = summarizeLocal;
  }
  return processors;
}

/**
 * Open the run's persistent queue, wire the REAL processors + safety-gated publisher,
 * drain the queue under all reliability bounds, and return a path-safe public summary.
 *
 * The queue state lives under `<preparedDir>/.yuhi/background`. Pre-inspection bytes
 * are staged in a private dir OUTSIDE the agent-visible root (a sibling of
 * `preparedDir`, same filesystem so the publish rename is atomic) and cleaned up
 * afterwards.
 */
export async function runBackgroundForRun(
  input: RunBackgroundForRunInput,
): Promise<BackgroundRunSummary> {
  const { runId, preparedDir, signal, config } = input;
  const clock = input.clock ?? systemBackgroundClock;

  const agentVisibleRoot = path.resolve(preparedDir);
  const baseDir = path.join(agentVisibleRoot, ".yuhi", "background");
  // Staging MUST be outside the agent-visible root (the publisher fails closed if it
  // is inside). A sibling under the same parent keeps it on the same filesystem so the
  // publish `rename` stays atomic (no cross-device EXDEV).
  const stagingDir = path.join(
    path.dirname(agentVisibleRoot),
    `.yuhi-bg-staging-${path.basename(agentVisibleRoot)}`,
  );

  const queue = await BackgroundQueue.open(baseDir, clock);
  const { normalizer, pseudonymizer, inspector, policy } = buildSafetyPrimitives(config);
  const publisher = new BackgroundPublisher({
    normalizer,
    pseudonymizer,
    inspector,
    policy,
    targets: { agentVisibleRoot, stagingDir },
  });
  const worker = new BackgroundWorker({
    queue,
    clock,
    processors: buildProcessors(input),
    publisher,
    ...(input.workerConfig ? { config: input.workerConfig } : {}),
  });

  try {
    const summary = await worker.run({
      runId,
      ...(signal ? { signal } : {}),
      ...(input.workerConfig ? { config: input.workerConfig } : {}),
    });

    let completed = 0;
    let failed = 0;
    let keptLocal = 0;
    let pending = 0;
    for (const item of summary.results) {
      switch (item.status) {
        case "completed":
          completed += 1;
          break;
        case "failed":
          failed += 1;
          break;
        case "kept-local":
        case "timed-out":
        case "cancelled":
          keptLocal += 1;
          break;
        case "pending":
        case "processing":
          pending += 1;
          break;
      }
    }

    return { completed, failed, keptLocal, pending, callsMade: summary.callsMade };
  } finally {
    // Private staging is transient; never leave pre-inspection bytes around.
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
