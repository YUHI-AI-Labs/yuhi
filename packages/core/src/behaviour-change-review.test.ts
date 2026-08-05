import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareWorkspace } from "./prepare-workspace.js";
import { buildSafePreparedRunSummary } from "./prepared-run.js";
import { renderYuhiModeHandoff } from "./yuhi-mode-summary.js";
import { validatePatchChange } from "./patch/validator.js";

/**
 * Pre-merge review of the two BEHAVIOUR changes on this branch.
 *
 * 1. A blocked pipeline delivers the partially de-identified output instead of
 *    falling back to the raw original.
 * 2. Redundant duplicate representations are replaced by a canonical alias.
 *
 * Both change delivered bytes, so each acceptance criterion is pinned here.
 */

let dir: string;
let managedDir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-review-"));
  managedDir = mkdtempSync(path.join(tmpdir(), "yuhi-managed-"));
  process.env.YUHI_HOME = managedDir;
});
afterEach(() => {
  delete process.env.YUHI_HOME;
  rmSync(dir, { recursive: true, force: true });
  rmSync(managedDir, { recursive: true, force: true });
});

function put(rel: string, content: string) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A name value echoed into a free-text column no classifier recognizes. */
const RESIDUE_TABLE =
  "氏名,メモ,成績\n" +
  "STUDENT_CANARY_001,follow up with STUDENT_CANARY_001,85\n" +
  "STUDENT_CANARY_002,no issues,92\n" +
  "STUDENT_CANARY_003,no issues,78\n";

// ---------------------------------------------------------------------------
// Behaviour 1 — partial de-identification instead of raw fallback
// ---------------------------------------------------------------------------

describe("BEHAVIOUR 1: partial de-identification never falls back to raw", () => {
  it("1a. does not deliver the raw original bytes", async () => {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    put("records.csv", RESIDUE_TABLE);
    const report = await prepareWorkspace(dir, {});
    const delivered = readFileSync(path.join(report.outDir, "records.csv"), "utf8");

    expect(sha(delivered)).not.toBe(sha(RESIDUE_TABLE));
    expect(report.tabularAcceptance!.rawFallbackUsed).toBe(false);
    expect(report.tabularAcceptance!.deliveryIntegrity!.rawFallbackFiles).toBe(0);
    // The classified column IS de-identified; only the unclassified echo survives.
    expect(delivered).not.toContain("STUDENT_CANARY_002");
    expect(delivered).not.toContain("STUDENT_CANARY_003");
  });

  it("1b. states the residual risk on CLI, handoff and the panel payload", async () => {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    put("records.csv", RESIDUE_TABLE);
    const report = await prepareWorkspace(dir, {});
    const integrity = report.tabularAcceptance!.deliveryIntegrity!;

    // The residue count must cover a PARTIAL delivery, not only a raw one.
    expect(integrity.identifierResidueFiles).toBeGreaterThan(0);
    expect(integrity.rawFallbackWithFindings).toBe(0);

    // CLI
    const { deliveryIntegrityWarnings, postTransformScanLabel } = await import(
      "./delivery-integrity.js"
    );
    const cli = [postTransformScanLabel(integrity), ...deliveryIntegrityWarnings(integrity)].join(
      "\n",
    );
    expect(cli).toMatch(/^Failed/m);
    expect(cli).not.toMatch(/Not applicable/);
    expect(cli).toMatch(/Detected identifier residue: \d+ file\(s\)/);
    expect(cli).toMatch(/partially de-identified/);

    // Handoff (read from the delivered artifact, not re-rendered from memory)
    const handoff = readFileSync(
      path.join(report.outDir, ".yuhi", "context", "AGENT_HANDOFF.md"),
      "utf8",
    );
    expect(handoff).toContain("Not fully de-identified");
    expect(handoff).toMatch(/Files still containing identifier residue: [1-9]/);
    expect(handoff).toMatch(/do not quote them/);

    // VS Code panel reads the same summary object; assert the field it renders.
    const summary = buildSafePreparedRunSummary(report);
    expect(summary.deliveryIntegrity?.identifierResidueFiles).toBe(
      integrity.identifierResidueFiles,
    );
    expect(summary.rawFallbackUsed).toBe(integrity.rawFallbackFiles > 0);
  });

  it("1c. launchAllowed stays consistent with the delivery policy", async () => {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    put("records.csv", RESIDUE_TABLE);
    const report = await prepareWorkspace(dir, {});
    const acceptance = report.tabularAcceptance!;

    // `file blocked != launch blocked` (CLAUDE.md): a warning never blocks launch...
    expect(acceptance.launchAllowed).toBe(true);
    // ...but the run must NOT claim the scan passed while residue exists.
    expect(acceptance.postTransformScanPassed).toBe(false);
    expect(acceptance.deliveryIntegrity!.postTransformScanFailed).toBeGreaterThan(0);
    // And the launch surface is downgraded rather than reported as plainly ready.
    const summary = buildSafePreparedRunSummary(report);
    expect(summary.launchAllowed).toBe(true);
    expect(summary.yuhiModeSummary!.launchStatus).toBe("ready-with-warnings");
    expect(summary.hasLimitations).toBe(true);
  });

  it("1d. keeps source binding, and Safe Apply refuses a transformed artifact", async () => {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    put("records.csv", RESIDUE_TABLE);
    const report = await prepareWorkspace(dir, {});

    // Source binding: the manifest's provenance still maps the delivered artifact
    // to its source (the manifest is the public surface a consumer reads).
    const manifest = JSON.parse(
      readFileSync(path.join(report.outDir, "manifest.json"), "utf8"),
    ) as { provenance?: { relpath: string }[] };
    expect(manifest.provenance?.some((p) => p.relpath === "records.csv")).toBe(true);
    // The original source file is untouched.
    expect(readFileSync(path.join(dir, "records.csv"), "utf8")).toBe(RESIDUE_TABLE);
    expect(report.sourceModified).toBe(0);

    // A pseudonymized artifact must never be written back over the real table:
    // its pseudonyms do not map to source values.
    const verdict = validatePatchChange({
      relpath: "records.csv",
      kind: "modified",
      representation: "background-artifact",
      afterContent: "anything",
    });
    expect(verdict.risk).toBe("blocked");
    expect(verdict.applyEligibility).toBe("blocked");
    expect(verdict.reasonCodes).toContain("patch-background-artifact");
  });
});

// ---------------------------------------------------------------------------
// Behaviour 2 — duplicate representations replaced by a canonical alias
// ---------------------------------------------------------------------------

/** Large enough that a ~200-byte alias stub is a genuine reduction. */
const DUP_TABLE =
  "学籍番号,氏名,成績\n" +
  Array.from(
    { length: 200 },
    (_, i) =>
      `SID_CANARY_${String(i + 1).padStart(4, "0")},STUDENT_CANARY_${String(i + 1).padStart(4, "0")},${60 + (i % 41)}`,
  ).join("\n") +
  "\n";

/** Deliberately tiny: an alias stub would be BIGGER than this table. */
const SMALL_DUP_TABLE =
  "学籍番号,氏名,成績\nSID_CANARY_9001,STUDENT_CANARY_9001,85\n";

describe("BEHAVIOUR 2: duplicate representations collapse to a canonical alias", () => {
  async function prepareDuplicates() {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    // Exact duplicates (identical bytes) …
    put("roster.csv", DUP_TABLE);
    put("roster_copy.csv", DUP_TABLE);
    // … plus the same table with a different delimiter (normalized family).
    put("roster.tsv", DUP_TABLE.replace(/,/g, "\t"));
    return prepareWorkspace(dir, {});
  }

  it("2a. distinguishes exact from normalized duplicates", async () => {
    const report = await prepareDuplicates();
    const families = report.contentFamilies!.families;
    expect(families.length).toBeGreaterThan(0);
    const kinds = new Set(families.map((f) => f.kind));
    for (const kind of kinds) expect(["exact", "normalized"]).toContain(kind);
    // The byte-identical pair is an EXACT family, never mislabelled normalized.
    const exact = families.find((f) =>
      f.members.some((m) => m.relpath === "roster_copy.csv"),
    );
    expect(exact?.kind).toBe("exact");
  });

  it("2b. every alias resolves to the canonical public ID and path", async () => {
    const report = await prepareDuplicates();
    const aliases = report.files.filter(
      (f) => f.duplicateOfFamily && f.contextRepresentation === "compressed",
    );
    expect(aliases.length).toBeGreaterThan(0);

    for (const alias of aliases) {
      const body = readFileSync(path.join(report.outDir, alias.relpath), "utf8");
      expect(body).toContain(`Duplicate of dataset ${alias.duplicateOfFamily}`);
      expect(alias.canonicalRelpath).toBeTruthy();
      expect(body).toContain(alias.canonicalRelpath!);
      // The canonical it names must actually exist in the delivered tree.
      expect(existsSync(path.join(report.outDir, alias.canonicalRelpath!))).toBe(true);
      // …and be traceable by stable public id, not only by filename.
      expect(alias.canonicalDocumentId).toBeTruthy();
      expect(body).toContain(alias.canonicalDocumentId!);
      // The family it points at is recorded in the manifest metrics.
      const family = report.contentFamilies!.families.find(
        (f) => f.familyId === alias.duplicateOfFamily,
      );
      expect(family).toBeDefined();
      expect(family!.canonicalRelpath).toBe(alias.canonicalRelpath);
    }
  });

  it("2c. discloses that format-specific detail is not preserved", async () => {
    const report = await prepareDuplicates();
    const normalized = report.contentFamilies!.families.find((f) => f.kind === "normalized");
    if (normalized) {
      // A CSV+TSV family differs in delimiter, so the loss must be stated.
      expect(normalized.formatDetailLost).toBe(true);
      const alias = report.files.find(
        (f) => f.duplicateOfFamily === normalized.familyId && f.contextRepresentation === "compressed",
      );
      if (alias) {
        const body = readFileSync(path.join(report.outDir, alias.relpath), "utf8");
        expect(body).toMatch(/differ in encoding or format/);
        expect(body).toMatch(/preserves the DATA but/);
      }
    }
    // Every alias states which kind of duplicate it is.
    for (const alias of report.files.filter(
      (f) => f.duplicateOfFamily && f.contextRepresentation === "compressed",
    )) {
      const body = readFileSync(path.join(report.outDir, alias.relpath), "utf8");
      expect(body).toMatch(/Duplicate kind: /);
    }
  });

  it("2d. never orphans an alias: the canonical is always delivered", async () => {
    const report = await prepareDuplicates();
    const delivered = new Set(
      report.files.filter((f) => !f.omitted).map((f) => f.relpath),
    );
    for (const alias of report.files.filter((f) => f.duplicateOfFamily)) {
      // The canonical must be present AND not withheld/failed.
      expect(delivered.has(alias.canonicalRelpath!)).toBe(true);
      const canonical = report.files.find((f) => f.relpath === alias.canonicalRelpath);
      expect(canonical).toBeDefined();
      expect(canonical!.omitted).not.toBe(true);
      expect(canonical!.duplicateOfFamily).toBeUndefined(); // never an alias itself
    }
    // No family may consist only of aliases.
    for (const family of report.contentFamilies!.families) {
      expect(family.members.filter((m) => m.canonical)).toHaveLength(1);
    }
  });

  it("2e. achieves a real agent-visible byte and token reduction", async () => {
    const report = await prepareDuplicates();
    const metrics = report.contentFamilies!;
    expect(metrics.duplicateBytes).toBeGreaterThan(0);

    // Bytes actually on disk: each alias is far smaller than the table it replaced.
    for (const alias of report.files.filter((f) => f.duplicateOfFamily)) {
      const onDisk = readFileSync(path.join(report.outDir, alias.relpath), "utf8");
      expect(Buffer.byteLength(onDisk)).toBeLessThan(Buffer.byteLength(DUP_TABLE));
      // Accounting describes the delivered bytes, not the pre-alias content.
      expect(alias.afterChars).toBe(onDisk.length);
    }

    // AGENT-VISIBLE reduction, measured on the delivered tree. The original bug
    // subtracted the token estimate of the byte COUNT string (`"195"` ≈ 1 token), so
    // the accounting silently kept charging for the full duplicate content.
    //
    // Deliberately NOT asserted: equality between `preparedEstimatedTokens` and a
    // hand-summed byte total. That figure also covers generated `.yuhi` surfaces, so
    // an equality here would be brittle rather than meaningful.
    const summary = buildSafePreparedRunSummary(report);
    expect(summary.publicSummary!.preparedEstimatedTokens).toBeGreaterThan(0);

    // The saving is real: every aliased member shrank, in bytes and in tokens.
    const aliased = report.files.filter(
      (f) => !f.omitted && f.duplicateOfFamily && f.contextRepresentation === "compressed",
    );
    expect(aliased.length).toBeGreaterThan(0);
    const preAliasTokens = aliased.reduce((t, f) => t + Math.ceil(f.beforeChars / 4), 0);
    const aliasTokens = aliased.reduce((t, f) => t + Math.ceil((f.afterChars ?? 0) / 4), 0);
    expect(aliasTokens).toBeLessThan(preAliasTokens);

    // And on disk, not just in the accounting.
    let onDiskAliasBytes = 0;
    let preAliasBytes = 0;
    for (const file of aliased) {
      onDiskAliasBytes += Buffer.byteLength(
        readFileSync(path.join(report.outDir, file.relpath), "utf8"),
      );
      preAliasBytes += file.beforeChars;
    }
    expect(onDiskAliasBytes).toBeLessThan(preAliasBytes);
  });

  it("2f. an alias is never applied back over the real table", async () => {
    const report = await prepareDuplicates();
    const alias = report.files.find(
      (f) => f.duplicateOfFamily && f.contextRepresentation === "compressed",
    );
    expect(alias).toBeDefined();
    // Aliases are marked `compressed`, which Safe Apply refuses outright.
    expect(alias!.contextRepresentation).toBe("compressed");
    const verdict = validatePatchChange({
      relpath: alias!.relpath,
      kind: "modified",
      representation: "compressed",
      afterContent: "agent edited the stub",
    });
    expect(verdict.risk).toBe("blocked");
    expect(verdict.applyEligibility).toBe("blocked");
    expect(verdict.reasonCodes).toContain("patch-compressed-source");
  });

  it("2g. leaves no raw identifier in any delivered representation", async () => {
    const report = await prepareDuplicates();
    let joined = "";
    for (const file of report.files.filter((f) => !f.omitted)) {
      const abs = path.join(report.outDir, file.relpath);
      if (!existsSync(abs)) continue;
      joined += readFileSync(abs, "utf8");
    }
    // Names only: the SID canaries are operational keys and are preserved by policy.
    for (const canary of ["STUDENT_CANARY_001", "STUDENT_CANARY_002"]) {
      expect(joined).not.toContain(canary);
    }
  });

  it("2i. never aliases when the stub would be LARGER than the content", async () => {
    put("yuhi.yaml", 'version: "1"\nrules: []\n');
    put("tiny.csv", SMALL_DUP_TABLE);
    put("tiny_copy.csv", SMALL_DUP_TABLE);
    const report = await prepareWorkspace(dir, {});

    // The duplicate is still RECORDED …
    const family = report.contentFamilies!.families.find((f) =>
      f.members.some((m) => m.relpath === "tiny_copy.csv"),
    );
    expect(family).toBeDefined();
    // … but no member was rewritten, because a stub would cost more than it saves.
    const aliased = report.files.filter((f) => f.contextRepresentation === "compressed");
    expect(aliased).toHaveLength(0);
    // Delivered bytes never grew.
    for (const relpath of ["tiny.csv", "tiny_copy.csv"]) {
      const onDisk = readFileSync(path.join(report.outDir, relpath), "utf8");
      expect(onDisk).not.toContain("Duplicate of dataset");
      expect(Buffer.byteLength(onDisk)).toBeLessThanOrEqual(
        Buffer.byteLength(SMALL_DUP_TABLE) + 64,
      );
    }
  });

  it("2h. the handoff stays silent about residue when there is none", async () => {
    const report = await prepareDuplicates();
    const summary = buildSafePreparedRunSummary(report);
    expect(summary.deliveryIntegrity!.identifierResidueFiles).toBe(0);
    expect(renderYuhiModeHandoff(summary.yuhiModeSummary!)).not.toContain(
      "Not fully de-identified",
    );
  });
});
