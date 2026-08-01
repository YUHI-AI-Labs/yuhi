import { describe, it, expect } from "vitest";
import { resolvePolicy } from "@yuhi/policy";
import { ACTION_RANK } from "@yuhi/shared";
import {
  applySafetyMode,
  SAFETY_MODES,
  escalatesUnverified,
  requiresZeroFindings,
  safetyModeLabel,
  type EffectivePolicy,
} from "./safety-mode.js";

const base: EffectivePolicy = {
  defaultAction: "allow",
  rules: [
    {
      name: "block-env",
      match: { paths: ["**/.env", "**/.env.*", "!**/.env.example"] },
      action: "block",
    },
    { name: "redact-secrets", match: { detectors: ["api-key", "private-key"] }, action: "redact" },
  ],
};

describe("applySafetyMode (escalate-only policy transform)", () => {
  it("Balanced returns the base policy unchanged", () => {
    const eff = applySafetyMode(base, "balanced");
    expect(eff.defaultAction).toBe(base.defaultAction);
    expect(eff.rules).toEqual(base.rules);
  });

  it("Strict and Maximum Privacy preserve the base rules as a prefix (never remove/reorder)", () => {
    for (const mode of ["strict", "maximum-privacy"] as const) {
      const eff = applySafetyMode(base, mode);
      expect(eff.rules.slice(0, base.rules.length)).toEqual(base.rules);
      expect(eff.rules.length).toBeGreaterThan(base.rules.length);
      expect(eff.defaultAction).toBe(base.defaultAction); // default never weakened
    }
  });

  it("every appended rule only escalates (action is local-only — never allow/redact-down)", () => {
    for (const mode of ["strict", "maximum-privacy"] as const) {
      const appended = applySafetyMode(base, mode).rules.slice(base.rules.length);
      for (const r of appended) expect(r.action).toBe("local-only");
    }
  });

  it("Maximum Privacy adds strictly more rules than Strict", () => {
    expect(applySafetyMode(base, "maximum-privacy").rules.length).toBeGreaterThan(
      applySafetyMode(base, "strict").rules.length,
    );
  });
});

// Minimal MatchableFile fixtures for resolvePolicy integration.
const file = (relpath: string, detectors: string[] = []) => ({
  relpath,
  findings: detectors.map((detector) => ({
    detector,
    path: relpath,
    severity: "high" as const,
    line: 1,
    maskedPreview: "[x]",
    description: detector,
  })),
});

const decideAll = (mode: (typeof SAFETY_MODES)[number], files: ReturnType<typeof file>[]) => {
  const evaluation = resolvePolicy(
    { ...applySafetyMode(base, mode), interactive: false },
    files,
  );
  const byPath = new Map(evaluation.decisions.map((d) => [d.relpath, d.action]));
  return byPath;
};

describe("Safety Mode changes real decisions (via resolvePolicy)", () => {
  const files = [
    file("src/index.ts"),
    file(".env"),
    file("data/people.csv", ["tabular-direct-identifier-column"]),
    file("assets/logo.png"),
    file("keys/id_rsa", ["private-key"]),
  ];

  it("each mode produces meaningfully different decisions on the same fixture", () => {
    const b = decideAll("balanced", files);
    const s = decideAll("strict", files);
    const m = decideAll("maximum-privacy", files);
    // The PII table: allowed under Balanced, kept local under Strict/Max.
    expect(b.get("data/people.csv")).not.toBe("local-only");
    expect(s.get("data/people.csv")).toBe("local-only");
    // The binary image: only Maximum Privacy forces it local.
    expect(s.get("assets/logo.png")).not.toBe("local-only");
    expect(m.get("assets/logo.png")).toBe("local-only");
    // The three decision sets are not all identical.
    expect(JSON.stringify([...s])).not.toBe(JSON.stringify([...b]));
    expect(JSON.stringify([...m])).not.toBe(JSON.stringify([...s]));
  });

  it("credentials/secrets are never weakened by any mode (monotonic on hard rules)", () => {
    for (const mode of SAFETY_MODES) {
      const d = decideAll(mode, files);
      // .env stays blocked; a private key stays at least redacted — never downgraded to allow.
      expect(d.get(".env")).toBe("block");
      expect(ACTION_RANK[d.get("keys/id_rsa")!]).toBeGreaterThanOrEqual(ACTION_RANK["redact"]);
    }
  });

  it("higher modes are monotonic: a file kept local in a lower mode stays >= restrictive", () => {
    const order = ["balanced", "strict", "maximum-privacy"] as const;
    for (const f of files) {
      let prevRank = -1;
      for (const mode of order) {
        const rank = ACTION_RANK[decideAll(mode, [f]).get(f.relpath)!];
        expect(rank).toBeGreaterThanOrEqual(prevRank);
        prevRank = rank;
      }
    }
  });
});

describe("prepare-loop hooks + helpers", () => {
  it("escalatesUnverified is true for Maximum Privacy only (Strict keeps ordinary unverified available-with-warning)", () => {
    // Corrected policy: only Maximum Privacy is companion-first/local-only for
    // content that could not be fully verified. Balanced and Strict keep ordinary
    // unverified documents available WITH a warning (Strict adds a stronger warning
    // but must NOT silently become Maximum Privacy) — see CLAUDE.md.
    expect(escalatesUnverified("balanced")).toBe(false);
    expect(escalatesUnverified("strict")).toBe(false);
    expect(escalatesUnverified("maximum-privacy")).toBe(true);
  });
  it("requiresZeroFindings is true for Maximum Privacy only", () => {
    expect(requiresZeroFindings("balanced")).toBe(false);
    expect(requiresZeroFindings("strict")).toBe(false);
    expect(requiresZeroFindings("maximum-privacy")).toBe(true);
  });
  it("labels are human-readable", () => {
    expect(safetyModeLabel("maximum-privacy")).toBe("Maximum Privacy");
  });
});
