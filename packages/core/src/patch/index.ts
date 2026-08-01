export * from "./types.js";
export * from "./snapshot.js";
export * from "./diff.js";
export * from "./provenance.js";
export * from "./validator.js";
// Source writes are intentionally exposed only through the session-scoped
// trusted Apply boundary. The lower-level mutation primitive remains internal
// to this package so callers cannot supply forged PatchChange metadata.
export {
  discardPreparedChanges,
  patchHistory,
  undoPatch,
  type PatchHistoryEntry,
  type PatchOperationResult,
  type UndoPatchTestHooks,
} from "./apply.js";
export * from "./private-state.js";
export * from "./session.js";
export * from "./hunks.js";
export * from "./review-diff.js";
export * from "./trusted-apply.js";
