/**
 * Test fixture: an adapter module with a TOP-LEVEL side effect (a load marker).
 *
 * The registry lazy-loading contract test dynamically imports this module from a
 * factory and asserts the marker is absent until `registry.get(id)` runs — proving
 * adapter-specific modules do not load on registry construction / package import.
 */
import { createFakeAgentAdapter } from "../testing.js";
import type { AgentAdapter } from "../adapter.js";

// Top-level side effect: records that this module was actually evaluated.
const g = globalThis as unknown as { __yuhiSideEffectAdapterLoads?: number };
g.__yuhiSideEffectAdapterLoads = (g.__yuhiSideEffectAdapterLoads ?? 0) + 1;

export function sideEffectAdapterLoadCount(): number {
  return g.__yuhiSideEffectAdapterLoads ?? 0;
}

export function createSideEffectAdapter(): AgentAdapter {
  return createFakeAgentAdapter({ id: "side-effect", displayName: "Side Effect Agent" });
}
