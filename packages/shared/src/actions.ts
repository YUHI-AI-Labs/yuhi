/**
 * Policy actions and their restrictiveness ranking.
 *
 * Actions are the low-level decisions. `ROUTES` (below) is the user-facing
 * vocabulary — Yuhi doesn't just *filter* files, it gives each one a *route*
 * that prepares it for the agent (send, redact, local-AI, runtime-only, …).
 *
 * Precedence rule (ADR-0003): when multiple signals apply to one file, the
 * MOST restrictive action wins (fail safe).
 */
export const ACTIONS = [
  "allow",
  "metadata-only",
  "summarize-local",
  "redact",
  "prepare-locally",
  "inject",
  "local-only",
  "ask",
  "block",
] as const;

export type Action = (typeof ACTIONS)[number];

/** Higher number = more restrictive (for the LLM's view). */
export const ACTION_RANK: Record<Action, number> = {
  allow: 0,
  "metadata-only": 1,
  "summarize-local": 2,
  redact: 3,
  "prepare-locally": 4,
  inject: 5,
  "local-only": 6,
  ask: 7,
  block: 8,
};

/**
 * User-friendly action names accepted in yuhi.yaml, normalized to internal
 * actions. The UI only ever shows these friendly routes.
 */
export const ACTION_ALIASES: Record<string, Action> = {
  send: "allow",
  "send-directly": "allow",
  "remove-secrets": "redact",
  "prepare-locally": "prepare-locally",
  "local-ai": "summarize-local",
  "runtime-only": "inject",
  "keep-local": "local-only",
  exclude: "block",
};

/** Normalize a friendly-or-internal action name to an internal Action. */
export function normalizeAction(name: string): Action | undefined {
  if ((ACTIONS as readonly string[]).includes(name)) return name as Action;
  return ACTION_ALIASES[name];
}

/** Actions implemented and enforced in the v0.1 MVP. */
export const IMPLEMENTED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "allow",
  "redact",
  "local-only",
  "ask",
  "block",
]);

/** Accepted by the schema but not yet enforced (treated conservatively). */
export const PLANNED_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "metadata-only",
  "summarize-local",
  "inject",
]);

export type Destination = "external" | "local";

/** How a route relates to the trust boundary, for UI grouping/colour. */
export type RouteKind = "send" | "transform" | "runtime" | "local" | "exclude" | "ask";

export interface Route {
  /** Short, user-facing name. */
  label: string;
  /** One-line explanation. */
  blurb: string;
  kind: RouteKind;
}

/**
 * The canonical route vocabulary shared by the CLI, the VS Code extension, and
 * the docs/site. Keep these strings in one place so every surface agrees.
 */
export const ROUTES: Record<Action, Route> = {
  allow: { label: "Send directly", blurb: "Sent to the agent unchanged.", kind: "send" },
  redact: {
    label: "Remove secrets",
    blurb: "Detected secrets are masked in the copy (deterministic).",
    kind: "transform",
  },
  "prepare-locally": {
    label: "Prepare locally",
    blurb: "Transformed on your machine by local processors (e.g. pseudonymize) before it's sent.",
    kind: "transform",
  },
  "summarize-local": {
    label: "Local AI",
    blurb: "Summarized by a local model on your machine; only the summary is sent.",
    kind: "transform",
  },
  "metadata-only": {
    label: "Metadata only",
    blurb: "Only path, size, and type are shared — never the contents.",
    kind: "transform",
  },
  inject: {
    label: "Runtime only",
    blurb: "Value passed to the agent's process at runtime — never placed in the context it reads.",
    kind: "runtime",
  },
  "local-only": {
    label: "Keep local",
    blurb: "Kept on your machine — not shared with the external agent.",
    kind: "local",
  },
  block: { label: "Exclude", blurb: "Never enters the context.", kind: "exclude" },
  ask: { label: "Ask", blurb: "Prompts you; resolves to Exclude when non-interactive.", kind: "ask" },
};

/** The user-facing route for an action. */
export function routeOf(action: Action): Route {
  return ROUTES[action];
}

/** Return the more restrictive of two actions. */
export function mostRestrictive(a: Action, b: Action): Action {
  return ACTION_RANK[a] >= ACTION_RANK[b] ? a : b;
}

/** Is a file with this action copied into an EXTERNAL agent's workspace as a readable file? */
export function isVisibleToExternalAgent(action: Action): boolean {
  // These produce a file the external agent can read (verbatim or transformed).
  return action === "allow" || action === "redact" || action === "prepare-locally";
}
