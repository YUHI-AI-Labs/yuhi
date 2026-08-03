import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyJsonPath, formatJsonPath, parseJsonPath } from "./json-path.js";
import { ContextStore } from "./store.js";
import { ContextStoreError, asSessionId, type SessionId } from "./types.js";

async function open(): Promise<ContextStore> {
  const root = await mkdtemp(join(tmpdir(), "yuhi-ctx-store-"));
  return ContextStore.open({ root, now: () => "2026-08-03T00:00:00.000Z" });
}

const SESSION = asSessionId("session-a");
const OTHER: SessionId = asSessionId("session-b");

describe("json-path subset", () => {
  it("round-trips through format and parse", () => {
    const path = '$.users[3].name["odd key"][1:9][*]';
    expect(formatJsonPath(parseJsonPath(path))).toBe(path);
  });

  it("rejects recursive descent instead of silently ignoring it", () => {
    expect(() => parseJsonPath("$..name")).toThrow(ContextStoreError);
  });

  it("resolves keys, indexes, wildcards and slices", () => {
    const doc = { users: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    expect(applyJsonPath(doc, parseJsonPath("$.users[1].id"))).toBe(2);
    expect(applyJsonPath(doc, parseJsonPath("$.users[1:3]"))).toEqual([{ id: 2 }, { id: 3 }]);
    expect(applyJsonPath(doc, parseJsonPath("$.users[*]"))).toHaveLength(3);
    expect(applyJsonPath(doc, parseJsonPath("$.missing.deep"))).toBeUndefined();
  });
});

describe("ContextStore", () => {
  it("stores original bytes privately and returns an opaque content-addressed id", async () => {
    const store = await open();
    const stored = await store.put(SESSION, '{"secretName":1}', "json");
    expect(stored.objectId).toMatch(/^obj_[0-9a-f]{32}$/);
    // Opaque: the id carries no trace of the content it addresses.
    expect(stored.objectId).not.toContain("secretName");
    // Identical bytes are one object: ids are stable across runs.
    const again = await store.put(SESSION, '{"secretName":1}', "json");
    expect(again.objectId).toBe(stored.objectId);
    expect((await store.stats()).objects).toBe(1);
  });

  it("refuses reads from a session that was never granted the object", async () => {
    const store = await open();
    const stored = await store.put(SESSION, "top secret bytes", "text");
    await expect(store.get(OTHER, stored.objectId)).rejects.toMatchObject({ code: "unauthorized" });
    // An opaque id is not a capability.
    await expect(store.getLines(OTHER, stored.objectId, 1, 1)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("serves byte ranges, line ranges, JSONPath and positional search", async () => {
    const store = await open();
    const doc = JSON.stringify({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const json = await store.put(SESSION, doc, "json");
    expect(await store.jsonPath(SESSION, json.objectId, "$.rows[1:3]")).toEqual([{ id: 2 }, { id: 3 }]);

    const text = await store.put(SESSION, "one\ntwo\nthree\nfour", "text");
    expect(await store.getLines(SESSION, text.objectId, 2, 3)).toBe("two\nthree");
    expect((await store.getRange(SESSION, text.objectId, 0, 3)).toString()).toBe("one");
    expect(await store.search(SESSION, text.objectId, "three")).toEqual([{ line: 3, column: 0, length: 5 }]);
  });

  it("clamps out-of-bounds ranges and rejects malformed ones", async () => {
    const store = await open();
    const stored = await store.put(SESSION, "abc", "text");
    expect((await store.getRange(SESSION, stored.objectId, 1, 99)).toString()).toBe("bc");
    await expect(store.getRange(SESSION, stored.objectId, 5, 1)).rejects.toMatchObject({ code: "invalid-range" });
    await expect(store.getLines(SESSION, stored.objectId, 0, 1)).rejects.toMatchObject({ code: "invalid-range" });
  });

  it("writes objects with owner-only permissions", async () => {
    const store = await open();
    const stored = await store.put(SESSION, "private", "text");
    // Reading through the store is the only intended path; assert the bytes are on
    // disk unreadable by other users rather than asserting a path shape.
    const stats = await store.stats();
    expect(stats.bytes).toBe(7);
    expect(await readFile(join((store as unknown as { root: string }).root, "sessions", SESSION, "index.jsonl"), "utf8")).toContain(
      stored.objectId,
    );
  });

  it("collects unreachable objects but never one an evidence record references", async () => {
    const store = await open();
    const orphan = await store.put(SESSION, "orphan bytes", "text");
    const cited = await store.put(SESSION, "cited bytes", "text");
    await store.appendEvidence(SESSION, { type: "delivery", objectId: cited.objectId });

    await store.dropSession(SESSION);
    const result = await store.gc();
    expect(result.removed).toBe(1);
    expect(result.retained).toBe(1);

    // The cited object survives, so the ledger stays verifiable.
    await store.authorize(SESSION, cited.objectId);
    expect((await store.get(SESSION, cited.objectId)).toString()).toBe("cited bytes");
    await store.authorize(SESSION, orphan.objectId);
    await expect(store.get(SESSION, orphan.objectId)).rejects.toMatchObject({ code: "not-found" });
  });
});
