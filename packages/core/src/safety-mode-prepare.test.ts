/**
 * v0.3.2 Safety Mode — prepare-loop escalation, exercised END-TO-END.
 *
 * The unit test in `safety-mode.test.ts` covers the policy transform in isolation.
 * This integration test runs the WHOLE `prepareWorkspace` pipeline under each mode
 * and asserts the observable escalation: which files actually land in the prepared
 * workspace on disk, which are kept local, and that the delivered sets shrink
 * monotonically (Balanced ⊇ Strict ⊇ Maximum Privacy) as the mode tightens.
 *
 * Assertions are behavioural — delivered sets, omitted flags, on-disk presence, and
 * raw-secret absence — never string pinning of report copy.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareWorkspace } from "./prepare-workspace.js";
import type { SafetyMode } from "./safety-mode.js";

let dir: string;
let managedDir: string;

// Distinctive fake secrets so we can prove the RAW value never reaches any mode's
// prepared workspace, regardless of how the file was routed.
const ENV_SECRET = "AKIAFAKEENVSECRET00000000";
const JSON_SECRET = "AKIAFAKEJSONSECRET11111111";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yuhi-safety-src-"));
  managedDir = mkdtempSync(path.join(tmpdir(), "yuhi-safety-managed-"));
  process.env.YUHI_HOME = managedDir;

  put("src/index.ts", "export const answer = 42;\n");
  // A credential file: never delivered raw in any mode (sanitized locally).
  put(".env", `PORT=3000\nAWS_SECRET_ACCESS_KEY=${ENV_SECRET}\n`);
  // A structured PII table: delivered de-identified under Balanced, kept local by
  // POLICY under Strict/Maximum Privacy (tabular-direct-identifier-column detector).
  put(
    "data/students.csv",
    "name,student_id,score\nTanaka Aoi,S-10241,42\nSato Ren,S-10242,88\n",
  );
  // A credential container that carries a MASKED finding but is NOT a tabular table,
  // so no Strict policy rule blocks it: delivered (sanitized) under Balanced/Strict,
  // kept local under Maximum Privacy by the zero-finding escalation.
  put("secrets.json", `{"apiKey":"${JSON_SECRET}","region":"us-east-1"}\n`);
  // An unverifiable binary: delivered `included-unverified` under Balanced, kept
  // local by the unverified escalation under Strict.
  writeFileSync(
    path.join(dir, "data/blob.bin"),
    Buffer.from([0, 1, 2, 3, 255, 254, 0, 42, 7, 0, 9, 250, 0, 13]),
  );

  put(
    "yuhi.yaml",
    'version: "1"\n' +
      "include_untracked: true\n" +
      "defaults: { action: allow }\n" +
      "rules:\n" +
      "  - name: env\n" +
      '    match: { paths: ["**/.env"] }\n' +
      "    action: prepare-locally\n" +
      "    processors: [sanitize-environment, safety-check]\n" +
      "  - name: students\n" +
      '    match: { paths: ["data/students.csv"] }\n' +
      "    action: prepare-locally\n" +
      "    processors: [pseudonymize, safety-check]\n" +
      "  - name: secrets\n" +
      '    match: { paths: ["secrets.json"] }\n' +
      "    action: prepare-locally\n" +
      "    processors: [sanitize-credentials, safety-check]\n",
  );
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

/** Walk a prepared workspace and return every delivered file's on-disk bytes. */
function allDeliveredBytes(outDir: string): Buffer[] {
  const out: Buffer[] = [];
  for (const rel of readdirSync(outDir, { recursive: true }) as string[]) {
    const abs = path.join(outDir, rel);
    if (statSync(abs).isFile()) out.push(readFileSync(abs));
  }
  return out;
}

interface Prepared {
  files: Awaited<ReturnType<typeof prepareWorkspace>>["files"];
  outDir: string;
  /** Source-relative paths actually delivered into the workspace (non-omitted, included-*). */
  delivered: Set<string>;
}

async function run(mode: SafetyMode): Promise<Prepared> {
  const report = await prepareWorkspace(dir, {
    managedWorkspaceBase: managedDir,
    safetyMode: mode,
    deferDocumentInspection: true,
  });
  const delivered = new Set(
    report.files
      .filter((f) => !f.omitted && (f.outcome ?? "").startsWith("included"))
      .map((f) => f.originalRelpath ?? f.relpath),
  );
  return { files: report.files, outDir: report.outDir, delivered };
}

/** The user-facing source path of an entry (pre-pseudonymization). */
function key(f: { relpath: string; originalRelpath?: string }): string {
  return f.originalRelpath ?? f.relpath;
}

describe("safety mode — prepare-loop escalation (end to end)", () => {
  it("delivers an opaque binary available-with-warning in Balanced and Strict, local only in Maximum Privacy", async () => {
    // Corrected policy: an uninspectable binary is still USEFUL context. Balanced and
    // Strict deliver the original WITH an inspection-pending warning (never labeled
    // verified); only Maximum Privacy keeps it local (companion-first). Known credentials
    // and private keys stay blocked in every mode (asserted in the tests below).
    const balanced = await run("balanced");
    const strict = await run("strict");
    const maximum = await run("maximum-privacy");

    for (const [mode, prepared] of [["balanced", balanced], ["strict", strict]] as const) {
      const bin = prepared.files.find((f) => key(f) === "data/blob.bin");
      expect(bin?.omitted, mode).toBe(false);
      expect(bin?.outcome, mode).toBe("included-unverified");
      expect(bin?.availabilityStatus, mode).toBe("available-with-warning");
      expect(bin?.originalShared, mode).toBe(true);
      expect(prepared.delivered.has("data/blob.bin"), mode).toBe(true);
      expect(existsSync(path.join(prepared.outDir, "data", "blob.bin")), mode).toBe(true);
    }

    // Maximum Privacy keeps the SAME binary local (not delivered, no companion needed).
    const maxBin = maximum.files.find((f) => key(f) === "data/blob.bin");
    expect(maxBin?.omitted).toBe(true);
    expect(maximum.delivered.has("data/blob.bin")).toBe(false);
    expect(existsSync(path.join(maximum.outDir, "data", "blob.bin"))).toBe(false);
  });

  it("Maximum Privacy also keeps local a finding-carrying file that Strict delivered", async () => {
    const strict = await run("strict");
    const maximum = await run("maximum-privacy");

    // secrets.json is sanitized and DELIVERED under Strict (no tabular policy rule
    // blocks it), and it carries a masked finding.
    const strictSecret = strict.files.find((f) => key(f) === "secrets.json");
    expect(strictSecret?.omitted).not.toBe(true);
    expect(strict.delivered.has("secrets.json")).toBe(true);
    expect((strictSecret?.maskedValues ?? 0)).toBeGreaterThan(0);

    // Maximum Privacy escalates it to local-only because it still carried a finding.
    const maxSecret = maximum.files.find((f) => key(f) === "secrets.json");
    expect(maxSecret?.omitted).toBe(true);
    expect(maxSecret?.keptLocalBySafetyMode).toBe("maximum-privacy");
    expect(maximum.delivered.has("secrets.json")).toBe(false);
    expect(existsSync(path.join(maximum.outDir, "secrets.json"))).toBe(false);
  });

  it("never delivers the raw credential in any mode", async () => {
    for (const mode of ["balanced", "strict", "maximum-privacy"] as const) {
      const prepared = await run(mode);
      const blob = Buffer.concat(allDeliveredBytes(prepared.outDir)).toString("latin1");
      expect(blob).not.toContain(ENV_SECRET);
      expect(blob).not.toContain(JSON_SECRET);
      // The raw .env source path is never delivered verbatim either.
      expect(existsSync(path.join(prepared.outDir, ".env")))
        // A sanitized .env may exist (Balanced/Strict) or be kept local (Maximum
        // Privacy) — but if present it must NOT contain the raw secret, already
        // asserted above.
        .toBe(mode !== "maximum-privacy");
    }
  });

  it("delivered sets shrink monotonically and are not all identical", async () => {
    const balanced = await run("balanced");
    const strict = await run("strict");
    const maximum = await run("maximum-privacy");

    const isSubset = (a: Set<string>, b: Set<string>) =>
      [...a].every((relpath) => b.has(relpath));

    // Balanced ⊇ Strict ⊇ Maximum Privacy.
    expect(isSubset(strict.delivered, balanced.delivered)).toBe(true);
    expect(isSubset(maximum.delivered, strict.delivered)).toBe(true);

    // The escalation actually does something at each step (not all identical).
    expect(balanced.delivered.size).toBeGreaterThan(strict.delivered.size);
    expect(strict.delivered.size).toBeGreaterThan(maximum.delivered.size);

    // The clean source file survives every mode — escalation is not a blanket deny.
    for (const prepared of [balanced, strict, maximum]) {
      expect(prepared.delivered.has("src/index.ts")).toBe(true);
    }
  });
});
