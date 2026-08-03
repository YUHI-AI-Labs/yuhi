/**
 * Reversible private object store (spec §9, architecture §5).
 *
 * Invariants:
 *  - Original bytes NEVER become public. They live here; callers get opaque ids.
 *  - `get*` is authorized per session. An id leaked from one session cannot read
 *    another session's objects — an opaque id is not a capability.
 *  - Content-addressed: identical bytes are one object, so ids are stable across
 *    runs. That stability is what makes delivered-prefix stability achievable
 *    (architecture §2, "prefix stability").
 *  - `gc()` never deletes an object that an evidence record still references; the
 *    ledger must stay verifiable.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { applyJsonPath, parseJsonPath } from "./json-path.js";
import {
  ContextStoreError,
  asObjectId,
  objectIdFromSha,
  type ContentKind,
  type ObjectId,
  type RawRef,
  type SessionId,
} from "./types.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface StoredObject extends RawRef {
  readonly sha256: string;
  readonly createdAt: string;
}

export interface SearchMatch {
  /** 1-indexed line number within the object. */
  readonly line: number;
  /** 0-indexed column of the match start within that line. */
  readonly column: number;
  readonly length: number;
}

export interface StoreStats {
  readonly objects: number;
  readonly bytes: number;
  readonly sessions: number;
}

export interface ContextStoreOptions {
  /** Root directory, e.g. `<prepared>/.yuhi/context`. */
  readonly root: string;
  /** Injected clock — never `Date.now()` inline, so ledger output stays testable. */
  readonly now?: () => string;
}

export class ContextStore {
  private readonly root: string;
  private readonly now: () => string;

  private constructor(opts: ContextStoreOptions) {
    this.root = opts.root;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  static async open(opts: ContextStoreOptions): Promise<ContextStore> {
    const store = new ContextStore(opts);
    for (const dir of ["objects", "sessions", "history", "evidence"]) {
      await mkdir(join(store.root, dir), { recursive: true, mode: DIR_MODE });
    }
    return store;
  }

  // ---------------------------------------------------------------- write path

  async put(
    session: SessionId,
    content: string | Buffer,
    kind: ContentKind,
    opts: { revision?: number } = {},
  ): Promise<StoredObject> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const objectId = objectIdFromSha(sha256);
    const revision = opts.revision ?? 0;
    const createdAt = this.now();

    const path = this.objectPath(objectId);
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    // Content-addressed: rewriting the same bytes is a no-op by construction, so
    // an unconditional write stays idempotent.
    await writeFile(path, bytes, { mode: FILE_MODE });

    const record: StoredObject = { objectId, revision, bytes: bytes.byteLength, kind, sha256, createdAt };
    await writeFile(`${path}.meta.json`, JSON.stringify(record), { mode: FILE_MODE });
    await this.appendJsonl(this.historyPath(objectId), { revision, sha256, createdAt, kind });
    await this.authorize(session, objectId);
    return record;
  }

  /** Grant an existing object to a session (used when replaying evidence). */
  async authorize(session: SessionId, objectId: ObjectId): Promise<void> {
    const index = this.sessionIndexPath(session);
    await mkdir(dirname(index), { recursive: true, mode: DIR_MODE });
    const existing = await this.sessionObjectIds(session);
    if (existing.has(objectId)) return;
    await this.appendJsonl(index, { objectId, at: this.now() });
  }

  // ----------------------------------------------------------------- read path

  async get(session: SessionId, objectId: ObjectId): Promise<Buffer> {
    await this.assertAuthorized(session, objectId);
    try {
      return await readFile(this.objectPath(objectId));
    } catch {
      throw new ContextStoreError("not-found", "Object is not present in the store");
    }
  }

  async meta(session: SessionId, objectId: ObjectId): Promise<StoredObject> {
    await this.assertAuthorized(session, objectId);
    try {
      const raw = await readFile(`${this.objectPath(objectId)}.meta.json`, "utf8");
      return JSON.parse(raw) as StoredObject;
    } catch {
      throw new ContextStoreError("not-found", "Object metadata is not present in the store");
    }
  }

  /** Byte range, end-exclusive. Reads only the requested window. */
  async getRange(session: SessionId, objectId: ObjectId, start: number, end: number): Promise<Buffer> {
    await this.assertAuthorized(session, objectId);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new ContextStoreError("invalid-range", "Byte range must be integers with 0 <= start <= end");
    }
    const handle = await open(this.objectPath(objectId), "r").catch(() => {
      throw new ContextStoreError("not-found", "Object is not present in the store");
    });
    try {
      const size = (await handle.stat()).size;
      const from = Math.min(start, size);
      const to = Math.min(end, size);
      const length = to - from;
      if (length <= 0) return Buffer.alloc(0);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, from);
      return buf;
    } finally {
      await handle.close();
    }
  }

  /** 1-indexed, inclusive line range. */
  async getLines(session: SessionId, objectId: ObjectId, from: number, to: number): Promise<string> {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      throw new ContextStoreError("invalid-range", "Line range must be integers with 1 <= from <= to");
    }
    const text = (await this.get(session, objectId)).toString("utf8");
    return text.split("\n").slice(from - 1, to).join("\n");
  }

  /** Resolve a JSONPath against a stored JSON object. */
  async jsonPath(session: SessionId, objectId: ObjectId, path: string): Promise<unknown> {
    const segments = parseJsonPath(path);
    const text = (await this.get(session, objectId)).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ContextStoreError("invalid-json", "Stored object is not valid JSON");
    }
    return applyJsonPath(parsed, segments);
  }

  /** Literal substring search. Returns positions only — never surrounding content. */
  async search(
    session: SessionId,
    objectId: ObjectId,
    query: string,
    opts: { maxMatches?: number } = {},
  ): Promise<SearchMatch[]> {
    if (query.length === 0) return [];
    const max = opts.maxMatches ?? 200;
    const text = (await this.get(session, objectId)).toString("utf8");
    const matches: SearchMatch[] = [];
    const lines = text.split("\n");
    for (let li = 0; li < lines.length && matches.length < max; li++) {
      const line = lines[li] ?? "";
      let col = line.indexOf(query);
      while (col >= 0 && matches.length < max) {
        matches.push({ line: li + 1, column: col, length: query.length });
        col = line.indexOf(query, col + query.length);
      }
    }
    return matches;
  }

  // ------------------------------------------------------------- housekeeping

  async stats(): Promise<StoreStats> {
    let objects = 0;
    let bytes = 0;
    for (const file of await this.objectFiles()) {
      objects++;
      bytes += (await stat(file)).size;
    }
    const sessions = (await this.listDir(join(this.root, "sessions"))).length;
    return { objects, bytes, sessions };
  }

  async dropSession(session: SessionId): Promise<void> {
    await rm(join(this.root, "sessions", session), { recursive: true, force: true });
  }

  /**
   * Reachability-based collection. An object survives when a live session index or
   * an evidence record references it. Evidence wins: a delivered payload must stay
   * explainable even after its session is dropped.
   */
  async gc(): Promise<{ removed: number; retained: number }> {
    const reachable = new Set<string>();
    for (const session of await this.listDir(join(this.root, "sessions"))) {
      for (const id of await this.sessionObjectIds(session as SessionId)) reachable.add(id);
    }
    for (const file of await this.listDir(join(this.root, "evidence"))) {
      for (const row of await this.readJsonl(join(this.root, "evidence", file))) {
        for (const id of collectObjectIds(row)) reachable.add(id);
      }
    }
    let removed = 0;
    let retained = 0;
    for (const file of await this.objectFiles()) {
      const id = file.slice(file.lastIndexOf("/") + 1);
      if (reachable.has(id)) {
        retained++;
        continue;
      }
      await rm(file, { force: true });
      await rm(`${file}.meta.json`, { force: true });
      removed++;
    }
    return { removed, retained };
  }

  /** Append an evidence row. Kept here so the ledger shares the store's gc roots. */
  async appendEvidence(session: SessionId, row: unknown): Promise<void> {
    await this.appendJsonl(join(this.root, "evidence", `${session}.jsonl`), row);
  }

  async readEvidence(session: SessionId): Promise<unknown[]> {
    return this.readJsonl(join(this.root, "evidence", `${session}.jsonl`));
  }

  // ------------------------------------------------------------------ internals

  private objectPath(objectId: ObjectId): string {
    // Two-char fan-out keeps directory sizes sane on large repositories.
    const body = objectId.slice("obj_".length);
    return join(this.root, "objects", body.slice(0, 2), objectId);
  }

  private historyPath(objectId: ObjectId): string {
    return join(this.root, "history", `${objectId}.jsonl`);
  }

  private sessionIndexPath(session: SessionId): string {
    return join(this.root, "sessions", session, "index.jsonl");
  }

  private async assertAuthorized(session: SessionId, objectId: ObjectId): Promise<void> {
    asObjectId(objectId);
    const ids = await this.sessionObjectIds(session);
    if (!ids.has(objectId)) {
      throw new ContextStoreError("unauthorized", "Object is not authorized for this session");
    }
  }

  private async sessionObjectIds(session: SessionId): Promise<Set<string>> {
    const rows = await this.readJsonl(this.sessionIndexPath(session));
    const out = new Set<string>();
    for (const row of rows) {
      const id = (row as { objectId?: unknown }).objectId;
      if (typeof id === "string") out.add(id);
    }
    return out;
  }

  private async objectFiles(): Promise<string[]> {
    const base = join(this.root, "objects");
    const out: string[] = [];
    for (const shard of await this.listDir(base)) {
      for (const entry of await this.listDir(join(base, shard))) {
        if (entry.endsWith(".meta.json")) continue;
        out.push(join(base, shard, entry));
      }
    }
    return out.sort();
  }

  private async listDir(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((e) => e !== ".DS_Store").sort();
    } catch {
      return [];
    }
  }

  private async appendJsonl(path: string, row: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    await appendFile(path, `${JSON.stringify(row)}\n`, { mode: FILE_MODE });
  }

  private async readJsonl(path: string): Promise<unknown[]> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    const out: unknown[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A truncated tail (crash mid-append) must not make the whole log unreadable.
      }
    }
    return out;
  }
}

/** Every `obj_…` id anywhere in an evidence row counts as a gc root. */
function collectObjectIds(value: unknown, depth = 0): string[] {
  if (depth > 12) return [];
  if (typeof value === "string") return /^obj_[0-9a-f]{32}$/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((v) => collectObjectIds(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((v) => collectObjectIds(v, depth + 1));
  }
  return [];
}
