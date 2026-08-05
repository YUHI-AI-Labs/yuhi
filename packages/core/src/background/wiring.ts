/**
 * v0.3.5 real-processor wiring for the BackgroundPreparationQueue.
 *
 * The queue engine (`BackgroundQueue` / `BackgroundWorker` / `BackgroundPublisher`)
 * is deliberately processor-agnostic: every heavy step and every safety primitive is
 * injected. This module supplies the REAL implementations — document/OCR extraction,
 * local summarization, and the normalize → pseudonymize → inspect → policy safety
 * gate — and exposes {@link runBackgroundForRun}: open the run's PRIVATE persistent
 * queue, drain it under all reliability bounds, publish safe companions atomically
 * into the agent-visible root, and keep a PUBLIC path-safe status file current.
 *
 * Boundaries preserved here:
 *  - PRIVATE state (queue records, cancel flag, pre-inspection staging) lives OUTSIDE
 *    every agent-visible root, under `<managedBase>/.internal/background/<runId>/`.
 *    Absolute `sourceArtifactPath`s, staging paths, provider details, and raw errors
 *    never leave that private dir.
 *  - The agent reads ONLY `<preparedDir>/.yuhi/background-status.json` (counts +
 *    path-safe per-item fields + revision) — never the private state.
 *  - Background publication adds only sanitized, safety-verified companions. Whether
 *    Balanced exposed an original with a warning is recorded separately by the queue.
 *  - document-extraction → OCR is a DEPENDENT fallback: OCR runs only when text
 *    extraction recovered too little; a successful extraction never triggers OCR, and
 *    the two never double-publish the same artifact.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  classifyStudentRecordHeaders,
  createStudentAliasContext,
  deidentifyText,
  directPersonalValueTokens,
  parseDelimitedTable,
  scanTextForDirectPersonalIdentifiers,
  type LocalModelProvider,
  type StudentAliasContext,
} from "@yuhi/shared";
import type { YuhiConfig } from "@yuhi/config";
import { createPseudonymizer, inMemoryMappingStore } from "@yuhi/processors";
import { runDetectors } from "@yuhi/scanner";
import { resolvePolicy } from "@yuhi/policy";

import { buildDocumentArtifact, type DocumentSourceType, type PdfTextExtractor } from "../document-artifact.js";
import { runLocalPreparation } from "../route-executor.js";
import { documentIdFor, withheldDisplayName } from "../metadata-boundary.js";
import type { PreparedFileEntry } from "../prepare-workspace.js";
import type { PublicPreparedContextSummary } from "../public-prepared-summary.js";
import { buildYuhiModeSummary, renderYuhiModeHandoff } from "../yuhi-mode-summary.js";
import { readPrivateAliasRegistry } from "./alias-registry-store.js";
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
  KeepLocalError,
  ProviderUnavailableError,
  type BackgroundProcessor,
  type ProcessorMap,
  type WorkerConfig,
} from "./worker.js";
import { CancelStore } from "./cancel-store.js";
import {
  buildPublicStatus,
  privateBackgroundDir,
  privateStagingDir,
  writePublicStatus,
} from "./status.js";
import { reduceProgressiveContextState } from "./revision.js";
import {
  systemBackgroundClock,
  type BackgroundClock,
  type BackgroundPreparationItem,
  type BackgroundReasonCode,
  type PublicBackgroundItem,
} from "./types.js";

/**
 * Human-readable, public-safe text for `document-index.md`'s "kept local" section.
 * Deliberately generic for `background-safety-rejected` — it never distinguishes a
 * secret finding from a residual-identifier finding, because THAT distinction is
 * itself sensitive (it would hint at what kind of content the document contains).
 */
function humanReasonText(reasonCode: BackgroundReasonCode | undefined): string {
  switch (reasonCode) {
    case "background-safety-rejected":
      return "Could not be safely verified for delivery.";
    case "background-ocr-unavailable":
      return "Scanned document; OCR is not available in this environment.";
    case "background-ocr-deferred":
      return "Handed off for OCR (insufficient extracted text).";
    case "background-extraction-failed":
      return "Could not be extracted (unsupported or malformed file).";
    case "background-provider-unavailable":
      return "Local model unavailable.";
    case "background-timeout":
      return "Timed out during processing.";
    case "background-cancelled":
      return "Cancelled.";
    case "background-publication-failed":
      return "Publication failed.";
    case "background-state-corrupt":
      return "Internal state could not be read.";
    default:
      return "Not delivered.";
  }
}

/**
 * Public, path-safe summary of a background run. Counts only — NO absolute paths, no
 * file contents, no reason strings beyond the aggregate tallies.
 */
export interface BackgroundRunSummary {
  completed: number;
  failed: number;
  keptLocal: number;
  pending: number;
  callsMade: number;
  /** Revision after this run (== number of safely-published artifacts). */
  revision: number;
}

export interface RunBackgroundForRunInput {
  /** The run whose deferred items to process. */
  runId: string;
  /** Absolute path to the prepared workspace root (== PrepareReport.outDir). */
  preparedDir: string;
  /**
   * Managed base that CONTAINS the prepared root (== the dir prepare-workspace uses).
   * Private state lives under `<managedBase>/.internal/...`, never under `preparedDir`.
   * Defaults to `dirname(preparedDir)` (the prepared root is `<managedBase>/<runId>`).
   */
  managedBase?: string;
  /** Cooperative cancellation for the whole batch. */
  signal?: AbortSignal;
  /** Injectable clock/timer (tests drive time with no real sleeps). */
  clock?: BackgroundClock;
  /** Loaded config — supplies the real policy + scan settings for the safety gate. */
  config?: YuhiConfig;
  /**
   * Local-model provider factory for `summarize-local`. Omit (or return undefined) to
   * mark the local model UNAVAILABLE (summarize items kept local, zero calls).
   */
  providerFactory?: () => LocalModelProvider | undefined;
  /**
   * PDF text extractor for `document-extraction` (pdf-text). Omit → document text
   * extraction unavailable (PDF documents keep local / fall back to OCR if possible).
   */
  pdfTextExtractor?: PdfTextExtractor;
  /**
   * OCR extractor for the DEPENDENT `ocr` fallback. Omit → OCR unavailable (a scanned
   * PDF that yielded no text is kept local with reason `background-ocr-unavailable`).
   */
  ocrExtractor?: PdfTextExtractor;
  /** Per-run worker bound overrides. */
  workerConfig?: Partial<WorkerConfig>;
}

const SUMMARIZE_PIPELINE = ["summarize-local", "pseudonymize", "safety-check"] as const;
const OCR_FALLBACK_PROCESSOR_VERSION = "ocr-fallback@1:extraction-insufficient";

function documentSourceTypeOf(relpath: string): DocumentSourceType | undefined {
  const ext = relpath.slice(relpath.lastIndexOf(".")).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".docm") return "docm";
  if (ext === ".pptx") return "pptx";
  if (ext === ".pptm") return "pptm";
  return undefined;
}

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

/**
 * `config` supplies scan/policy settings; `aliasContext` is this run's pseudonym
 * registry (loaded from the private, cross-process store — `readPrivateAliasRegistry`
 * — or a fresh empty one; see `runBackgroundForRun` and `alias-registry-store.ts`'s
 * doc comment for why an empty context is still safe).
 *
 * Fixes issue #21 (P0): the pseudonymizer used to call `extractTabularIdentifiers`
 * only, which throws on non-tabular text (any PDF/DOCX/PPTX extraction), so document
 * prose was published completely unmasked. It now ALSO runs `deidentifyText` — the
 * SAME taxonomy and registry the synchronous tabular pass uses (0.4.7,
 * `docs/design/0.4.7_document_privacy.md`) — which masks every direct identifier and
 * CJK name-shaped candidate it detects unconditionally (linked to an existing entity
 * when a same-document strong key confirms it, a fresh unlinked token otherwise; see
 * `text-deidentify.ts`).
 *
 * The independent verification stays a SEPARATE stage, not a self-report from
 * pseudonymize: `inspector.inspect` re-scans the ALREADY-pseudonymized text with
 * `scanTextForDirectPersonalIdentifiers`, mirroring how 0.4.6 verifies tabular output
 * independently of the transform that produced it (`docs/HANDOFF.md` §4, decision 1).
 * Either check finding anything routes through the publisher's existing "any finding →
 * rejected → kept local" logic (`publisher.ts`) — no publisher changes needed.
 */
function buildSafetyPrimitives(
  config: YuhiConfig | undefined,
  aliasContext: StudentAliasContext,
): {
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
    normalize: (text) => text.replace(/\r\n?/g, "\n").normalize("NFC"),
  };

  const pseudonymizer: Pseudonymizer = {
    pseudonymize: (text) => {
      // Tabular content, if any reaches this path: table-scoped identifiers first.
      const tabularIdentifiers = extractTabularIdentifiers(text);
      const working =
        tabularIdentifiers.length > 0
          ? (createPseudonymizer({
              identifiers: tabularIdentifiers,
              store: inMemoryMappingStore(),
            }).process(text) as { output: string }).output
          : text;
      // Prose (PDF/DOCX/PPTX extractions, and any tabular remnants/preamble): SAME
      // taxonomy + registry as the tabular pass. Always masks what it detects — see
      // `deidentifyText`'s own doc comment for the identity linkage policy.
      const deidentified = deidentifyText(working, aliasContext);
      return { text: deidentified.text };
    },
  };

  const inspector: SafetyInspector = {
    inspect: (text) => {
      const findings: SafetyFinding[] = runDetectors(text, { entropyThreshold, keywords }).map(
        (f) => ({ category: f.detector }),
      );
      // (0.4.7) The former crude `PERSONAL_DATA_PATTERN` check is removed, not kept as
      // defense-in-depth: its email/phone-shape half is a strict subset of
      // `scanTextForDirectPersonalIdentifiers`'s PATTERNS below, and its label-word
      // half (`氏名|address|住所\s*[:：]`) matched the LABEL ITSELF — which
      // `deidentifyText` intentionally preserves (`CJK_LABELS`) — so it would keep
      // flagging a document as unsafe forever, even after the actual value next to
      // that label was correctly masked. That would have silently defeated this
      // fix's whole purpose for the most common real case (a Japanese form with a
      // 氏名 column).
      // Independent re-verification of the ALREADY-pseudonymized text (issue #21's
      // fix): a bug in `deidentifyText` must not silently pass just because
      // pseudonymize claims success. `knownDirectValues` catches a registry-linked
      // value the substitution step should have replaced but didn't; the shape/CJK
      // checks are self-contained and need no context.
      const verification = scanTextForDirectPersonalIdentifiers(
        text,
        directPersonalValueTokens(aliasContext).keys(),
      );
      if (verification.residual > 0) {
        findings.push({ category: "residual-direct-personal-identifier" });
      }
      if (verification.residualRisk) {
        findings.push({ category: "residual-personal-name-risk" });
      }
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
 * The agent-visible path a published companion must take.
 *
 * When the original was delivered, the companion sits beside it under the same
 * (already de-identified) name. When the original was WITHHELD, deriving the
 * companion name from the source path would republish the very filename the
 * withholding was meant to protect, so the companion is published under the
 * document's public identity instead.
 */
function companionRelpath(item: BackgroundPreparationItem): string {
  if (item.publicRelpath) return `${item.publicRelpath}.md`;
  const documentId = item.documentId ?? documentIdFor(item.relpath, item.contextId);
  return `.yuhi/context/companions/${withheldDisplayName(item.relpath, documentId)}.md`;
}

/** Cheap, stable idempotency seed for a source file — never loads it into memory. */
async function sourceSeed(absPath: string, relpath: string): Promise<string> {
  try {
    const stat = await fs.stat(absPath);
    return `${relpath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return `${relpath}:missing`;
  }
}

/**
 * Build the REAL processor map. `document-extraction` runs the shared companion
 * builder with the text extractor; on insufficient text for a PDF it ENQUEUES a
 * dependent `ocr` item (keeping this item local, publishing nothing). `ocr` runs the
 * companion builder with the OCR extractor. `summarize-local` runs the local
 * preparation pipeline behind an injected provider.
 */
function buildProcessors(input: RunBackgroundForRunInput, queue: BackgroundQueue): ProcessorMap {
  const { providerFactory, pdfTextExtractor, ocrExtractor, config } = input;
  const mode = config?.budget?.reduction_mode ?? "balanced";
  const policyHash = config?.scan ? "cfg" : "default";

  const extractWith = async (
    item: BackgroundPreparationItem,
    extractor: PdfTextExtractor | undefined,
  ): Promise<{ text: string; kind: "companion" | "placeholder" }> => {
    const sourceType = documentSourceTypeOf(item.relpath) ?? "pdf";
    const stat = await fs.stat(item.sourceArtifactPath);
    const artifact = await buildDocumentArtifact({
      sourceType,
      absPath: item.sourceArtifactPath,
      sizeBytes: stat.size,
      readBuffer: () => fs.readFile(item.sourceArtifactPath),
      ...(extractor ? { extractPdfText: extractor } : {}),
    });
    return { text: artifact.markdown, kind: artifact.kind };
  };

  const documentExtraction: BackgroundProcessor = {
    run: async (item): Promise<RawExtraction> => {
      const { text, kind } = await extractWith(item, pdfTextExtractor);
      if (kind === "companion") {
        // Sufficient text recovered → publish the sanitized companion. No OCR.
        return { text, preparedRelpath: companionRelpath(item) };
      }
      // Insufficient text (scanned / image-only / no extractor). For a PDF, hand off
      // to a DEPENDENT OCR item; this item publishes nothing and is kept local.
      const sourceType = documentSourceTypeOf(item.relpath);
      if (sourceType === "pdf") {
        await queue.enqueue({
          runId: item.runId,
          contextId: item.contextId,
          relpath: item.relpath,
          // The dependent item inherits the SAME metadata boundary as its parent.
          ...(item.publicRelpath ? { publicRelpath: item.publicRelpath } : {}),
          ...(item.documentId ? { documentId: item.documentId } : {}),
          kind: "ocr",
          sourceArtifactPath: item.sourceArtifactPath,
          // The OCR item's idempotency key includes the source seed AND the
          // extractor-result condition (via processorVersion), so it is DISTINCT from
          // the extraction item (which also differs by `kind`).
          sourceContentHash: await sourceSeed(item.sourceArtifactPath, item.relpath),
          processorVersion: OCR_FALLBACK_PROCESSOR_VERSION,
          policyHash,
          priority: item.priority,
          originalSharedWithWarning: item.originalSharedWithWarning,
        });
        throw new KeepLocalError("background-ocr-deferred");
      }
      // A non-PDF that could not be extracted (unsupported/malformed Office doc) →
      // keep local; OCR would not help.
      throw new KeepLocalError("background-extraction-failed");
    },
  };

  const summarizeLocal: BackgroundProcessor = {
    run: async (item, signal): Promise<RawExtraction> => {
      const provider = providerFactory?.();
      if (!provider) throw new ProviderUnavailableError("local model provider unavailable");
      const content = await fs.readFile(item.sourceArtifactPath, "utf8");
      const prepared = await runLocalPreparation(content, [...SUMMARIZE_PIPELINE], {
        provider,
        mode,
        signal,
      });
      if (prepared.status === "error") {
        throw new ProviderUnavailableError(prepared.error ?? "local preparation error");
      }
      // The summary replaces the DELIVERED file when the agent already has it; for a
      // withheld original it is published under the document's public identity.
      return { text: prepared.output, preparedRelpath: item.publicRelpath ?? companionRelpath(item) };
    },
  };

  const processors: ProcessorMap = { "document-extraction": documentExtraction };
  // OCR is always wired; when the OCR extractor is absent it throws
  // ProviderUnavailableError, which the worker records as a kept-local item with the
  // distinct reason `background-ocr-unavailable`.
  processors.ocr = {
    run: async (item): Promise<RawExtraction> => {
      if (!ocrExtractor) throw new ProviderUnavailableError("OCR extractor unavailable");
      const { text, kind } = await extractWith(item, ocrExtractor);
      if (kind !== "companion") throw new KeepLocalError("background-extraction-failed");
      return { text, preparedRelpath: companionRelpath(item) };
    },
  };
  if (providerFactory) processors["summarize-local"] = summarizeLocal;
  return processors;
}

/**
 * Derive the revision (published-artifact count) + revisionId for the public status.
 * The immutable `baseContextId` is taken from the items' own `contextId` (all items
 * in a run share it), so the revisionId written here is identical to the one the VS
 * Code / CLI surfaces recompute for the same run and the same delivered set.
 */
function revisionOf(items: readonly PublicBackgroundItem[]): { revision: number; revisionId: string } {
  const baseContextId = items.find((it) => typeof it.contextId === "string" && it.contextId !== "")?.contextId ?? "";
  const state = reduceProgressiveContextState({
    baseContextId,
    backgroundItems: items,
  });
  return { revision: state.revision, revisionId: state.revisionId };
}

/** Resolve the managed base that contains the prepared root. */
function resolveManagedBase(input: { preparedDir: string; managedBase?: string }): string {
  return path.resolve(input.managedBase ?? path.dirname(path.resolve(input.preparedDir)));
}

/**
 * Open the run's PRIVATE queue, wire the REAL processors + safety-gated publisher,
 * drain the queue under all reliability bounds, keep the PUBLIC status current, and
 * return a path-safe summary. Private state (records, staging, cancel flag) lives
 * outside the agent-visible root; the agent sees only the public status file.
 */
export async function runBackgroundForRun(
  input: RunBackgroundForRunInput,
): Promise<BackgroundRunSummary> {
  const { runId, signal } = input;
  const clock = input.clock ?? systemBackgroundClock;
  const agentVisibleRoot = path.resolve(input.preparedDir);
  const managedBase = resolveManagedBase(input);
  const privateDir = privateBackgroundDir(managedBase, runId);
  const stagingDir = privateStagingDir(managedBase, runId);

  const queue = await BackgroundQueue.open(privateDir, clock);
  const cancelStore = new CancelStore(privateDir);
  // Missing, corrupt, or wrong-runId registry -> fresh empty context. Safe: masking
  // and independent verification below do not depend on this registry, only
  // cross-format ("same token in the CSV and the PDF") reuse does — see
  // `alias-registry-store.ts`'s doc comment.
  const aliasContext = await readPrivateAliasRegistry(managedBase, runId).catch(() =>
    createStudentAliasContext(),
  );
  const { normalizer, pseudonymizer, inspector, policy } = buildSafetyPrimitives(
    input.config,
    aliasContext,
  );
  const publisher = new BackgroundPublisher({
    normalizer,
    pseudonymizer,
    inspector,
    policy,
    targets: { agentVisibleRoot, stagingDir },
  });

  const refreshStatus = async (): Promise<void> => {
    const items = queue.list(runId);
    const status = buildPublicStatus(items, revisionOf(items));
    await writePublicStatus(agentVisibleRoot, status);
    const handoffPath = path.join(agentVisibleRoot, ".yuhi", "context", "AGENT_HANDOFF.md");
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(agentVisibleRoot, "manifest.json"), "utf8"),
      ) as {
        files?: PreparedFileEntry[];
        publicSummary?: PublicPreparedContextSummary;
        launchAllowed?: boolean;
        yuhiModeSummary?: { contextEfficiency?: { compressionMode?: "off" | "auto" | "on"; initialAgentContextTokens?: number | null } };
      };
      if (!manifest.files || !manifest.publicSummary) return;
      const mode = buildYuhiModeSummary({
        files: manifest.files,
        prepared: manifest.publicSummary,
        background: status,
        launchAllowed: manifest.launchAllowed !== false,
        compressionMode: manifest.yuhiModeSummary?.contextEfficiency?.compressionMode ??
          (manifest.publicSummary.compressionEnabled ? "auto" : "off"),
        initialAgentContextTokens:
          manifest.yuhiModeSummary?.contextEfficiency?.initialAgentContextTokens ?? null,
      });
      const completedItems = status.items.filter(
        (item) => item.status === "completed" && item.preparedRelpath,
      );
      const keptLocalItems = status.items.filter(
        (item) => item.status === "kept-local" || item.status === "failed",
      );
      const index = [
        "# Yuhi Document Context",
        "",
        "Generated locally by Yuhi. Extracted document text is not stored.",
        "",
        `Context revision: ${status.revision}`,
        "",
        "## Document companions",
        "",
        // Each line here means a document made it all the way through
        // extraction, de-identification, and independent verification — never a
        // synonym for "a companion file exists"; see `alias-registry-store.ts` and
        // `text-deidentify.ts` for what each stage actually checks.
        ...(completedItems.length > 0
          ? completedItems.flatMap((item) => [
              `- ${item.preparedRelpath}`,
              "  - Extracted: Yes",
              "  - Direct identifiers transformed: Yes",
              "  - Verification: Passed",
              "  - Delivery: Available",
            ])
          : ["- None yet"]),
        "",
        "## Documents kept local (not delivered)",
        "",
        ...(keptLocalItems.length > 0
          ? keptLocalItems.flatMap((item) => [
              `- ${item.relpath ?? item.displayName ?? item.documentId ?? "(withheld)"}`,
              "  - Delivery: Local only",
              `  - Reason: ${humanReasonText(item.reasonCode)}`,
            ])
          : ["- None"]),
        "",
        "Original documents marked inspection-pending remain available with warnings.",
        "",
      ].join("\n");
      const writes = [
        [handoffPath, renderYuhiModeHandoff(mode)],
        [path.join(agentVisibleRoot, ".yuhi", "context", "document-index.md"), index],
        [path.join(agentVisibleRoot, ".yuhi", "yuhi-mode-summary.json"), JSON.stringify(mode, null, 2) + "\n"],
      ] as const;
      for (const [target, content] of writes) {
        const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(tmp, content, "utf8");
        await fs.rename(tmp, target);
      }
    } catch {
      // Older/minimal runs without a handoff remain processable.
    }
  };

  const worker = new BackgroundWorker({
    queue,
    clock,
    processors: buildProcessors(input, queue),
    publisher,
    cancelStore,
    onSettled: refreshStatus,
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
    await refreshStatus();
    return {
      completed,
      failed,
      keptLocal,
      pending,
      callsMade: summary.callsMade,
      revision: revisionOf(summary.results).revision,
    };
  } finally {
    // Private staging is transient; never leave pre-inspection bytes around.
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Common inputs for the cancel/retry control-plane APIs. */
export interface BackgroundControlInput {
  runId: string;
  preparedDir: string;
  managedBase?: string;
  clock?: BackgroundClock;
}

/**
 * Persistently request cancellation so the worker (this process or another) aborts
 * promptly and any late provider result is discarded. Also updates the item/run
 * status and refreshes the public status. Pass `itemId` for a single item; omit for
 * a whole-run cancel.
 */
export async function requestBackgroundCancel(
  input: BackgroundControlInput & { itemId?: string },
): Promise<void> {
  const managedBase = resolveManagedBase(input);
  const privateDir = privateBackgroundDir(managedBase, input.runId);
  const cancelStore = new CancelStore(privateDir);
  const queue = await BackgroundQueue.open(privateDir, input.clock ?? systemBackgroundClock);
  if (input.itemId) {
    await cancelStore.requestItem(input.itemId);
    await queue.cancel(input.itemId);
  } else {
    await cancelStore.requestRun();
    for (const item of queue.list(input.runId)) {
      if (item.status === "pending" || item.status === "processing") {
        await queue.cancel(item.itemId);
      }
    }
  }
  const items = queue.list(input.runId);
  await writePublicStatus(path.resolve(input.preparedDir), buildPublicStatus(items, revisionOf(items)));
}

/**
 * Retry a single terminal item, keeping its SAME itemId + idempotency key (no
 * duplicate). A `completed` item is never retried (returns it unchanged).
 */
export async function retryBackgroundItem(
  input: BackgroundControlInput & { itemId: string },
): Promise<PublicBackgroundItem | undefined> {
  const managedBase = resolveManagedBase(input);
  const privateDir = privateBackgroundDir(managedBase, input.runId);
  const queue = await BackgroundQueue.open(privateDir, input.clock ?? systemBackgroundClock);
  const result = await queue.retry(input.itemId);
  const items = queue.list(input.runId);
  await writePublicStatus(path.resolve(input.preparedDir), buildPublicStatus(items, revisionOf(items)));
  return result;
}

/**
 * Bulk-retry terminal items, keeping each item's SAME itemId + idempotency key.
 * `failedOnly: true` restricts to `failed` / `timed-out`; `completed` is never retried.
 */
export async function retryBackgroundTerminal(
  input: BackgroundControlInput & { failedOnly?: boolean },
): Promise<PublicBackgroundItem[]> {
  const managedBase = resolveManagedBase(input);
  const privateDir = privateBackgroundDir(managedBase, input.runId);
  const queue = await BackgroundQueue.open(privateDir, input.clock ?? systemBackgroundClock);
  const requeued = await queue.retryTerminal({
    runId: input.runId,
    ...(input.failedOnly !== undefined ? { failedOnly: input.failedOnly } : {}),
  });
  const items = queue.list(input.runId);
  await writePublicStatus(path.resolve(input.preparedDir), buildPublicStatus(items, revisionOf(items)));
  return requeued;
}
