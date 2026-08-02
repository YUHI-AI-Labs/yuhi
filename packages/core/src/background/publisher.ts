/**
 * Safety-gated atomic publisher — the security core of the background queue.
 *
 * A processor produces raw extracted text from a source artifact (PDF/DOCX/OCR/
 * summary). That text is UNTRUSTED and UNVERIFIED. The publisher is the only
 * component allowed to place anything into the agent-visible workspace, and it
 * does so under a FIXED, non-negotiable order:
 *
 *   1. (input) extract / OCR / summarize      — done by the worker's processor
 *   2. normalize                              — canonicalize text
 *   3. pseudonymize / redact                  — strip identifiers
 *   4. secret + PII inspection                — reject on any finding
 *   5. policy evaluation                      — reject on any block
 *   6. write TEMP artifact in a PRIVATE dir   — never under the agent root
 *   7. atomic rename to publish               — ONLY on full success
 *
 * Hard prohibitions (enforced by construction here):
 *  - No pre-inspection / pre-pseudonymize bytes are ever written under the
 *    agent-visible root. The temp file lives in `stagingDir`, which the caller
 *    guarantees is outside `agentVisibleRoot` (e.g. under `.yuhi/`).
 *  - Never publish on summarize-success alone: inspection AND policy must pass.
 *  - No best-effort publish when a safety check fails → keep-local.
 *  - No partial file left at the publish target on failure (rename is atomic;
 *    the temp is always cleaned up).
 *  - The original PDF/DOCX is never copied or exposed — only the sanitized,
 *    verified companion text is published.
 *
 * All safety primitives are INJECTED so this module stays testable and does not
 * pull the whole @yuhi/processors + @yuhi/scanner pipeline. Real wiring happens
 * at the integration layer.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  BackgroundPreparationItem,
  BackgroundReasonCode,
} from "./types.js";

/** Raw extraction handed to the publisher. Untrusted, unverified content. */
export interface RawExtraction {
  /** The extracted / summarized text. */
  text: string;
  /** Repo-relative path the sanitized companion should be published to. */
  preparedRelpath: string;
}

/** Canonicalize text before de-identification (injected). */
export interface Normalizer {
  normalize(text: string): string;
}

/** Strip / tokenize identifiers (injected — real impl wraps @yuhi/processors). */
export interface Pseudonymizer {
  pseudonymize(text: string): { text: string };
}

/** A single secret/PII finding. Only a category label crosses boundaries. */
export interface SafetyFinding {
  category: string;
}

/** Secret + PII inspection (injected — real impl wraps @yuhi/scanner). */
export interface SafetyInspector {
  /** Inspect ALREADY-pseudonymized text; `ok:false` ⇒ keep-local. */
  inspect(text: string): { ok: boolean; findings: SafetyFinding[] };
}

/** Policy evaluation for the publish decision (injected — wraps @yuhi/policy). */
export interface PolicyEvaluator {
  evaluate(relpath: string, text: string): { allowed: boolean };
}

/** Where sanitized output is published vs. where untrusted temp bytes live. */
export interface PublishTargets {
  /** Agent-visible workspace root. Published artifacts land under here. */
  agentVisibleRoot: string;
  /**
   * Private staging dir OUTSIDE `agentVisibleRoot` (e.g. `<run>/.yuhi/background/staging`).
   * Pre-inspection temp bytes are written here and never seen by the agent.
   */
  stagingDir: string;
}

export interface PublisherDeps {
  normalizer: Normalizer;
  pseudonymizer: Pseudonymizer;
  inspector: SafetyInspector;
  policy: PolicyEvaluator;
  targets: PublishTargets;
}

export type PublishOutcome =
  | { status: "published"; preparedRelpath: string }
  | { status: "rejected"; reasonCode: BackgroundReasonCode }
  | { status: "failed"; reasonCode: BackgroundReasonCode };

/** True when `child` is inside `parent` (path-contained). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export class BackgroundPublisher {
  constructor(private readonly deps: PublisherDeps) {
    // Fail closed at construction if staging is inside the agent root: that would
    // let pre-inspection bytes become agent-visible.
    if (isInside(deps.targets.agentVisibleRoot, deps.targets.stagingDir)) {
      throw new Error(
        "BackgroundPublisher: stagingDir must be OUTSIDE agentVisibleRoot (pre-inspection bytes must never be agent-visible)",
      );
    }
  }

  /**
   * Run the fixed safety pipeline for one item and publish atomically on full
   * success. Returns a path-safe outcome; never throws for expected failures.
   */
  async publish(
    _item: BackgroundPreparationItem,
    extraction: RawExtraction,
  ): Promise<PublishOutcome> {
    const relpath = normalizePublishRelpath(extraction.preparedRelpath);
    if (!relpath) return { status: "failed", reasonCode: "background-publication-failed" };

    // Stages 2–5 run under a fail-closed guard: if any injected safety primitive
    // throws, we CANNOT verify the content, so we keep it local (never publish).
    let pseudonymized: string;
    try {
      // 2. normalize → 3. pseudonymize/redact.
      const normalized = this.deps.normalizer.normalize(extraction.text);
      pseudonymized = this.deps.pseudonymizer.pseudonymize(normalized).text;

      // 4. secret + PII inspection (on the de-identified text).
      const inspection = this.deps.inspector.inspect(pseudonymized);
      if (!inspection.ok || inspection.findings.length > 0) {
        return { status: "rejected", reasonCode: "background-safety-rejected" };
      }

      // 5. policy evaluation.
      const decision = this.deps.policy.evaluate(relpath, pseudonymized);
      if (!decision.allowed) {
        return { status: "rejected", reasonCode: "background-safety-rejected" };
      }
    } catch {
      // Could not verify safety → fail closed to keep-local. No raw error leaks.
      return { status: "rejected", reasonCode: "background-safety-rejected" };
    }

    // 6. write TEMP in the PRIVATE staging dir (never under the agent root).
    const target = path.join(this.deps.targets.agentVisibleRoot, relpath);
    if (!isInside(this.deps.targets.agentVisibleRoot, target)) {
      // A traversal-y relpath tried to escape the workspace — refuse.
      return { status: "failed", reasonCode: "background-publication-failed" };
    }
    const tmp = path.join(
      this.deps.targets.stagingDir,
      `pub-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      await fs.mkdir(this.deps.targets.stagingDir, { recursive: true });
      await fs.writeFile(tmp, pseudonymized, "utf8");
      // 7. atomic rename to publish — ONLY reached after all checks passed.
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(tmp, target);
      return { status: "published", preparedRelpath: relpath };
    } catch {
      // Publication failed → leave NO partial file anywhere. rename is atomic, so
      // the target is untouched on failure; clean up the private temp.
      await fs.rm(tmp, { force: true }).catch(() => {});
      return { status: "failed", reasonCode: "background-publication-failed" };
    }
  }
}

/** Reject absolute paths and traversal; return a clean relative path or "". */
function normalizePublishRelpath(relpath: string): string {
  if (!relpath || path.isAbsolute(relpath)) return "";
  const norm = path.normalize(relpath);
  if (norm.startsWith("..") || path.isAbsolute(norm)) return "";
  return norm;
}
