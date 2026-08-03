/**
 * Branded identifiers and content kinds for the v0.4.0 Repository Virtualization
 * Runtime (docs/design/V0_4_0_ARCHITECTURE.md §2, §5).
 *
 * The brands are load-bearing, not cosmetic: `RawRef` is the ONLY way a
 * `ContextEvent` refers to original bytes, and only the store can resolve one.
 * A plain string can therefore never be mistaken for deliverable content.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Opaque, content-addressed object id. Opaque to the agent; NOT a capability. */
export type ObjectId = Brand<string, "ObjectId">;
/** Session scope. Authorization for every `get` is per session. */
export type SessionId = Brand<string, "SessionId">;

/**
 * A reference to original bytes held privately by the store. Deliberately carries
 * no content: the type system stops raw bytes from reaching a delivery surface.
 */
export interface RawRef {
  readonly objectId: ObjectId;
  readonly revision: number;
  readonly bytes: number;
  readonly kind: ContentKind;
}

export type ContentKind =
  | "source"
  | "html"
  | "json"
  | "xml"
  | "csv"
  | "tsv"
  | "markdown"
  | "log"
  | "test-output"
  | "shell-output"
  | "git-diff"
  | "pdf-companion"
  | "text";

export const CONTENT_KINDS: readonly ContentKind[] = [
  "source",
  "html",
  "json",
  "xml",
  "csv",
  "tsv",
  "markdown",
  "log",
  "test-output",
  "shell-output",
  "git-diff",
  "pdf-companion",
  "text",
];

export function asSessionId(raw: string): SessionId {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(raw)) {
    throw new ContextStoreError("invalid-session-id", "Session id must be 1-128 chars of [A-Za-z0-9._-]");
  }
  return raw as SessionId;
}

/** Object ids are derived from content, so identical bytes are one object. */
export function objectIdFromSha(sha256hex: string): ObjectId {
  if (!/^[0-9a-f]{64}$/.test(sha256hex)) {
    throw new ContextStoreError("invalid-object-id", "Object id must derive from a sha256 hex digest");
  }
  return `obj_${sha256hex.slice(0, 32)}` as ObjectId;
}

export function asObjectId(raw: string): ObjectId {
  if (!/^obj_[0-9a-f]{32}$/.test(raw)) {
    throw new ContextStoreError("invalid-object-id", "Malformed object id");
  }
  return raw as ObjectId;
}

export type ContextStoreErrorCode =
  | "invalid-session-id"
  | "invalid-object-id"
  | "unauthorized"
  | "not-found"
  | "invalid-range"
  | "invalid-json"
  | "invalid-path";

/**
 * Store errors never carry content — only a code and a static message. An error
 * path must not become a disclosure path (THREAT_MODEL: failure ⇒ withheld).
 */
export class ContextStoreError extends Error {
  constructor(
    readonly code: ContextStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContextStoreError";
  }
}
