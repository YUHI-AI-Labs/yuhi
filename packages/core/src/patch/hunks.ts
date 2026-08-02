import { createHash } from "node:crypto";

export interface TextPatchHunk {
  hunkId: string;
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  /** Runtime-only candidate material. Never persist in manifest/audit/session. */
  replacementLines: string[];
}

type Operation = {
  kind: "equal" | "delete" | "insert";
  beforePos: number;
  afterPos: number;
};

function lines(bytes: string | Uint8Array): string[] {
  return (typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")).split("\n");
}

function oneHunk(before: string[], after: string[]): TextPatchHunk[] {
  if (before.length === after.length && before.every((line, index) => line === after[index])) return [];
  const material = JSON.stringify([0, before.length, after]);
  return [{
    hunkId: `sha256:${createHash("sha256").update(material).digest("hex")}`,
    beforeStart: 0,
    beforeCount: before.length,
    afterStart: 0,
    afterCount: after.length,
    replacementLines: after,
  }];
}

/** Deterministic line hunks. Large inputs safely degrade to one selectable hunk. */
export function buildTextPatchHunks(
  beforeBytes: string | Uint8Array,
  afterBytes: string | Uint8Array,
): TextPatchHunk[] {
  const before = lines(beforeBytes);
  const after = lines(afterBytes);
  if (before.length * after.length > 1_000_000) return oneHunk(before, after);
  const width = after.length + 1;
  const table = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = before[i] === after[j]
        ? 1 + table[(i + 1) * width + j + 1]!
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const operations: Operation[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      operations.push({ kind: "equal", beforePos: i, afterPos: j }); i += 1; j += 1;
    } else if (j < after.length && (i === before.length || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) {
      operations.push({ kind: "insert", beforePos: i, afterPos: j }); j += 1;
    } else {
      operations.push({ kind: "delete", beforePos: i, afterPos: j }); i += 1;
    }
  }
  const changed = operations.map((operation, index) => operation.kind === "equal" ? -1 : index).filter((index) => index >= 0);
  if (changed.length === 0) return [];
  const groups: Array<{ start: number; end: number }> = [];
  let start = changed[0]!;
  let previous = start;
  for (const index of changed.slice(1)) {
    if (index - previous > 6) { groups.push({ start, end: previous }); start = index; }
    previous = index;
  }
  groups.push({ start, end: previous });
  return groups.map((group) => {
    const first = operations[group.start]!;
    const last = operations[group.end]!;
    const beforeStart = first.beforePos;
    const afterStart = first.afterPos;
    const beforeEnd = last.beforePos + (last.kind === "delete" ? 1 : 0);
    const afterEnd = last.afterPos + (last.kind === "insert" ? 1 : 0);
    const replacementLines = after.slice(afterStart, afterEnd);
    const material = JSON.stringify([beforeStart, beforeEnd - beforeStart, replacementLines]);
    return {
      hunkId: `sha256:${createHash("sha256").update(material).digest("hex")}`,
      beforeStart,
      beforeCount: beforeEnd - beforeStart,
      afterStart,
      afterCount: afterEnd - afterStart,
      replacementLines,
    };
  });
}

export function applyTextPatchHunks(
  beforeBytes: string | Uint8Array,
  hunks: readonly TextPatchHunk[],
  selectedHunkIds: readonly string[],
): Buffer {
  const output = lines(beforeBytes);
  const selected = new Set(selectedHunkIds);
  for (const hunk of [...hunks].filter((item) => selected.has(item.hunkId)).sort((a, b) => b.beforeStart - a.beforeStart)) {
    output.splice(hunk.beforeStart, hunk.beforeCount, ...hunk.replacementLines);
  }
  return Buffer.from(output.join("\n"));
}
