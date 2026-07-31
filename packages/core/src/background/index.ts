/**
 * Yuhi v0.3.5 "Progressive Context" — BackgroundPreparationQueue.
 *
 * Public API surface consumed by the CLI, VS Code, and the prepare-workspace
 * integration owner. Everything exported here is path-safe: no absolute path
 * ever crosses this boundary (they live only in internal state).
 *
 * Typical usage:
 *
 *   const queue = await BackgroundQueue.open(baseDir, clock);
 *   await queue.enqueue({ runId, contextId, relpath, kind, sourceArtifactPath,
 *                         sourceContentHash, processorVersion, policyHash });
 *   const publisher = new BackgroundPublisher({ normalizer, pseudonymizer,
 *                         inspector, policy, targets });
 *   const worker = new BackgroundWorker({ queue, clock, processors, publisher });
 *   const summary = await worker.run({ runId, signal });
 *   queue.status(itemId); queue.result(itemId); queue.list(runId);
 *   await queue.cancel(itemId); await queue.retry(itemId);
 */
export {
  type BackgroundPreparationKind,
  type BackgroundPreparationItem,
  type BackgroundPreparationStatus,
  type BackgroundPreparationResult,
  type BackgroundReasonCode,
  type IdempotencyInputs,
  type EnqueueInput,
  type PublicBackgroundItem,
  type BackgroundClock,
  BACKGROUND_PREPARATION_KINDS,
  BACKGROUND_REASON_CODES,
  systemBackgroundClock,
  defaultReasonForStatus,
} from "./types.js";

export {
  BackgroundStateStore,
  idempotencyKey,
  type BackgroundRecord,
  type EnqueueOutcome,
} from "./state-store.js";

export { BackgroundQueue } from "./queue.js";

export {
  BackgroundPublisher,
  type RawExtraction,
  type Normalizer,
  type Pseudonymizer,
  type SafetyFinding,
  type SafetyInspector,
  type PolicyEvaluator,
  type PublishTargets,
  type PublisherDeps,
  type PublishOutcome,
} from "./publisher.js";

export {
  BackgroundWorker,
  ProviderUnavailableError,
  DEFAULT_WORKER_CONFIG,
  type BackgroundProcessor,
  type ProcessorMap,
  type WorkerConfig,
  type WorkerDeps,
  type RunOptions,
  type RunSummary,
} from "./worker.js";

export {
  computeRevisionId,
  canonicalizeRevisionIdInput,
  reduceProgressiveContextState,
  toPublicProgressiveContextState,
  isRevisionId,
  REVISION_ID_ALGORITHM,
  REVISION_ID_PREFIX,
  REVISION_ID_CANONICALIZATION_VERSION,
  type DeliveredFile,
  type ProgressiveContextState,
  type ProgressiveContextInput,
  type RevisionIdInput,
} from "./revision.js";
