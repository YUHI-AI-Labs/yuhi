import { sha256, type Processor, type ProcessorResult } from "@yuhi/shared";

/** A local store for the pseudonym → original mapping. Kept on the user's machine. */
export interface MappingStore {
  set(pseudonym: string, original: string): void;
  get(pseudonym: string): string | undefined;
  entries(): [string, string][];
}

export function inMemoryMappingStore(): MappingStore {
  const m = new Map<string, string>();
  return {
    set: (p, o) => void m.set(p, o),
    get: (p) => m.get(p),
    entries: () => [...m.entries()],
  };
}

export interface PseudonymizeOptions {
  /** Exact identifier values to replace (names, IDs). */
  identifiers: string[];
  /** Salt so tokens are stable per-project but not guessable across projects. */
  salt?: string;
  /** Token prefix. */
  prefix?: string;
  /** Where the reversible mapping is kept (LOCAL only — never sent). */
  store?: MappingStore;
}

/** Stable pseudonym for a value: same input + salt → same token. */
export function stableToken(value: string, salt: string, prefix: string): string {
  return `${prefix}-${sha256(salt + "\0" + value).slice(0, 6).toUpperCase()}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deterministic pseudonymizer. Replaces each configured identifier with a stable
 * token and records the reversible mapping in a LOCAL store. The audit contains
 * only counts — never the original values.
 */
export function createPseudonymizer(options: PseudonymizeOptions): Processor {
  const salt = options.salt ?? "yuhi";
  const prefix = options.prefix ?? "Subject";
  const store = options.store ?? inMemoryMappingStore();
  // Longest-first so overlapping identifiers replace correctly.
  const ids = [...new Set(options.identifiers)].filter(Boolean).sort((a, b) => b.length - a.length);

  return {
    id: "pseudonymize",
    version: "1.0.0",
    kind: "rule-based",
    inputType: "text/plain",
    outputType: "text/plain",
    process(input: string): ProcessorResult {
      let output = input;
      let changed = 0;
      for (const value of ids) {
        const token = stableToken(value, salt, prefix);
        const re = new RegExp(escapeRe(value), "g");
        let hit = false;
        output = output.replace(re, () => {
          hit = true;
          changed++;
          return token;
        });
        if (hit) store.set(token, value);
      }
      return {
        output,
        safePreview: `${changed} identifier occurrence(s) replaced with stable pseudonyms`,
        externalTransmissionAllowed: true,
        audit: {
          processorId: "pseudonymize",
          version: "1.0.0",
          kind: "rule-based",
          itemsChanged: changed,
          note: `${store.entries().length} unique identifier(s) mapped (mapping kept local)`,
        },
      };
    },
  };
}
