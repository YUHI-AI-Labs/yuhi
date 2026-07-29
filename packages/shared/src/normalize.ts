import { LocalModelError } from "./local-model.js";

/**
 * Provider-neutral normalizer for local-model responses.
 *
 * Reasoning models (e.g. Qwen3) may prefix a `<think>…</think>` block before the
 * final answer. That thinking must NEVER become prepared context — it is stripped
 * here and only the final answer is kept. The raw response should be discarded by
 * the caller after normalization.
 *
 * Rules (explicit boundary handling — NOT a single greedy regex):
 *  - A LEADING `<think>` (after trimming leading whitespace) starts a reasoning block.
 *    Keep only the text after its first matching `</think>`.
 *  - A leading `<think>` with no `</think>` → MALFORMED_RESPONSE (unclosed).
 *  - If the resulting final answer is empty → EMPTY_RESPONSE.
 *  - `<think>`-like substrings that are NOT at the start are treated as ordinary
 *    content and left untouched.
 */
const OPEN = "<think>";
const CLOSE = "</think>";

export function normalizeModelResponse(raw: string): string {
  let text = typeof raw === "string" ? raw : "";

  // Strip consecutive LEADING <think>…</think> blocks (handles one or several).
  // A `<think>` that is not at the start is ordinary content and left untouched.
  for (;;) {
    const lead = text.replace(/^\s+/, "");
    if (lead.slice(0, OPEN.length).toLowerCase() !== OPEN) {
      const answer = lead.trim();
      if (answer.length === 0) {
        throw new LocalModelError("EMPTY_RESPONSE", "Model returned an empty response.");
      }
      return answer;
    }
    const closeIdx = indexOfCaseInsensitive(lead, CLOSE, OPEN.length);
    if (closeIdx === -1) {
      throw new LocalModelError(
        "MALFORMED_RESPONSE",
        "Model response opened a <think> block that was never closed.",
      );
    }
    text = lead.slice(closeIdx + CLOSE.length);
  }
}

function indexOfCaseInsensitive(haystack: string, needle: string, from: number): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), from);
}
