/**
 * v0.3 "What the AI Can See" data model — the primary v0.3 surface.
 *
 * A pure projection of disclosure records + manifest facts into two buckets
 * (available / not-available to the agent) with ACCURATE status labels. Rendering
 * (VS Code webview, CLI) consumes this; it never claims the agent has READ a file,
 * only what is AVAILABLE in the Prepared Workspace.
 */
import {
  isIncludeDecision,
  type ContextDetail,
  type DisclosureDecision,
  type DisclosureRecord,
} from "./disclosure.js";

export interface WhatAiCanSeeSource {
  record: DisclosureRecord;
  /** Local display name (the user's own view — never shared with the agent). */
  displayName: string;
  fileType: string;
  sizeBytes: number;
  /** Delivered artifact kind, when known (from the manifest). */
  deliveredArtifactType?: string;
  /** Structured identifiers transformed (tabular / document). */
  transformedIdentifiers?: number;
  /** True when this entry is a document whose original was kept local. */
  originalKeptLocal?: boolean;
  warnings?: string[];
}

export interface WhatAiCanSeeItem {
  displayName: string;
  fileType: string;
  sizeBytes: number;
  effectiveDecision: DisclosureDecision;
  /** Accurate one-line status, e.g. "Standard summary", "Excluded by user". */
  statusLabel: string;
  /** Secondary note, e.g. "Original PDF kept local". */
  note?: string;
  contextDetail?: ContextDetail;
  warnings: string[];
}

export interface WhatAiCanSeeView {
  available: WhatAiCanSeeItem[];
  notAvailable: WhatAiCanSeeItem[];
  counts: {
    available: number;
    fullSanitized: number;
    standard: number;
    compact: number;
    excludedUser: number;
    excludedPolicy: number;
    hardBlocked: number;
    pendingReview: number;
  };
  reduction: {
    sourceFiles: number;
    availableFiles: number;
    /** Conservative estimate only — NOT actual model token savings. */
    estimatedContentReductionPercent: number;
  };
}

/** Accurate, non-overclaiming status label for a decision + artifact. */
function statusLabelFor(decision: DisclosureDecision, deliveredArtifactType?: string): string {
  switch (decision) {
    case "include-full-sanitized":
      return deliveredArtifactType?.startsWith("sanitized-")
        ? "Full sanitized content"
        : "Sanitized content";
    case "include-standard":
      return "Standard summary";
    case "include-compact":
      return "Compact summary";
    case "exclude-user":
      return "Excluded by user";
    case "exclude-policy":
      return "Excluded by policy";
    case "pending-review":
      return "Pending review";
    case "blocked":
      return "Hard blocked (credential/policy)";
    default:
      return decision;
  }
}

function noteFor(src: WhatAiCanSeeSource): string | undefined {
  if (src.deliveredArtifactType === "safe-placeholder") return "Safe placeholder — original kept local";
  if (src.originalKeptLocal) return "Original kept local";
  if (src.transformedIdentifiers && src.transformedIdentifiers > 0) {
    return `${src.transformedIdentifiers} structured identifier${src.transformedIdentifiers === 1 ? "" : "s"} transformed`;
  }
  return undefined;
}

function toItem(src: WhatAiCanSeeSource): WhatAiCanSeeItem {
  const item: WhatAiCanSeeItem = {
    displayName: src.displayName,
    fileType: src.fileType,
    sizeBytes: src.sizeBytes,
    effectiveDecision: src.record.effectiveDecision,
    statusLabel: statusLabelFor(src.record.effectiveDecision, src.deliveredArtifactType),
    contextDetail: src.record.contextDetail,
    warnings: src.warnings ?? [],
  };
  const note = noteFor(src);
  if (note) item.note = note;
  return item;
}

export function buildWhatAiCanSeeView(sources: readonly WhatAiCanSeeSource[]): WhatAiCanSeeView {
  const available: WhatAiCanSeeItem[] = [];
  const notAvailable: WhatAiCanSeeItem[] = [];
  const counts = {
    available: 0, fullSanitized: 0, standard: 0, compact: 0,
    excludedUser: 0, excludedPolicy: 0, hardBlocked: 0, pendingReview: 0,
  };
  for (const src of sources) {
    const d = src.record.effectiveDecision;
    const item = toItem(src);
    if (isIncludeDecision(d)) {
      available.push(item);
      counts.available += 1;
      if (d === "include-full-sanitized") counts.fullSanitized += 1;
      else if (d === "include-standard") counts.standard += 1;
      else if (d === "include-compact") counts.compact += 1;
    } else {
      notAvailable.push(item);
      if (d === "exclude-user") counts.excludedUser += 1;
      else if (d === "exclude-policy") counts.excludedPolicy += 1;
      else if (d === "blocked") counts.hardBlocked += 1;
      else if (d === "pending-review") counts.pendingReview += 1;
    }
  }
  const sourceFiles = sources.length;
  // Conservative BYTE-based estimate of how much source content is agent-accessible.
  // Explicitly an estimate of agent-accessible content, NOT actual model token savings.
  const sourceBytes = sources.reduce((n, s) => n + Math.max(0, s.sizeBytes), 0);
  const availableBytes = sources
    .filter((s) => isIncludeDecision(s.record.effectiveDecision))
    .reduce((n, s) => n + Math.max(0, s.sizeBytes), 0);
  const estimatedContentReductionPercent =
    sourceBytes > 0 ? Math.round((1 - availableBytes / sourceBytes) * 1000) / 10 : 0;
  return {
    available,
    notAvailable,
    counts,
    reduction: { sourceFiles, availableFiles: counts.available, estimatedContentReductionPercent },
  };
}
