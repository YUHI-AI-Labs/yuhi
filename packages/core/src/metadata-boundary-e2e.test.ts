/**
 * P0-C regression: the ADVERSARIAL metadata scan.
 *
 * Withholding a sensitive file's bytes is only half the control. In a real workspace
 * the FILENAME is identifying data — school exports arrive as `9999990001 評定-0722.xlsx`
 * and rosters as `名簿-9999990001/`. This suite prepares a workspace whose withheld
 * files have identifying names, then scans EVERY agent-visible byte (each metadata
 * surface, plus the whole delivered tree, plus the tree's own filenames) and requires
 * a raw-identifier count of zero.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DocumentInspector, LocalModelProvider } from "@yuhi/shared";
import { prepareWorkspace } from "./prepare-workspace.js";
import { writePreparedRunSession } from "./prepared-run.js";

const STUDENT_ID = "9999990001";
/** Tokens that name only WITHHELD files in the fixture below. */
const IDENTIFYING_TOKENS = [STUDENT_ID, "評定", "名簿", "roster", "秘密鍵"];

/** Synthetic, non-functional key material — enough for the detector, no real secret. */
const FAKE_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA0FAKEKEYFAKEKEY0",
  "FAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEYFAKEKEY0",
  "-----END PRIVATE KEY-----",
  "",
].join("\n");

/** The metadata surfaces an agent can read inside a Prepared Workspace. */
const METADATA_SURFACES = [
  "manifest.json",
  ".yuhi/background-status.json",
  ".yuhi/session.json",
  ".yuhi/yuhi-mode-summary.json",
  ".yuhi/context/AGENT_HANDOFF.md",
  ".yuhi/context/document-index.md",
];

let sourceDir = "";
let managedBase = "";

beforeEach(() => {
  sourceDir = mkdtempSync(path.join(tmpdir(), "yuhi-mb-src-"));
  managedBase = mkdtempSync(path.join(tmpdir(), "yuhi-mb-managed-"));
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
  rmSync(managedBase, { recursive: true, force: true });
});

function put(rel: string, content: string): void {
  const abs = path.join(sourceDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Reports a KNOWN personal-information finding, so the document stays local. */
const piiInspector: DocumentInspector = {
  canInspect: () => true,
  inspect: async (_input, onText) => {
    onText?.(`氏名: 山田太郎 学籍番号: ${STUDENT_ID} 連絡先: taro@example.com`);
    return { status: "inspected", extractedTextAvailable: true, extractionMethod: "pdf-text", warnings: [] };
  },
};

/** A benign local model, so the FOREGROUND summary artifacts are actually written. */
function fakeProvider(): LocalModelProvider {
  return {
    id: "fake",
    endpoint: "http://localhost:0",
    defaultModel: "fake",
    async health() {
      return { reachable: true, models: ["fake"] };
    },
    async listModels() {
      return ["fake"];
    },
    async generate() {
      return "A short, benign summary of the prepared document.";
    },
  } as unknown as LocalModelProvider;
}

/** Extraction succeeds with clean text, so a summary is produced rather than rejected. */
const cleanInspector: DocumentInspector = {
  canInspect: () => true,
  inspect: async (_input, onText) => {
    onText?.("Quarterly figures are within plan. No personal data in this document.");
    return { status: "inspected", extractedTextAvailable: true, extractionMethod: "pdf-text", warnings: [] };
  },
};

function filesUnder(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).filter((rel) => {
    try {
      return statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  });
}

function buildFixture(): void {
  // A grade table whose NAME and CONTENT both carry the student number.
  put(
    `data/${STUDENT_ID}-評定-0722.csv`,
    `student_id,氏名,score\n${STUDENT_ID},山田太郎,88\n2026990192,佐藤花子,91\n`,
  );
  // A document original: PDFs are never handed to the agent raw.
  put(`docs/roster-${STUDENT_ID}.pdf`, "%PDF-1.4 synthetic fixture bytes\n");
  // A whole DIRECTORY whose name identifies a class, holding a hard-blocked credential.
  put(
    `名簿-${STUDENT_ID}/meibo.env`,
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
  );
  // A private key is a KNOWN credential, so it is withheld in every Safety Mode — the
  // directory naming it must not survive on any surface either.
  put(`秘密鍵-${STUDENT_ID}/id_rsa`, FAKE_PRIVATE_KEY);
  put("src/app.ts", "export const app = 1;\n");
  put("yuhi.yaml", 'version: "1"\ninclude_untracked: true\ndefaults: { action: allow }\nrules: []\n');
}

interface ScanResult {
  outDir: string;
  withheld: string[];
  leaks: Record<string, string[]>;
  surfacesPresent: string[];
}

async function prepareAndScan(
  safetyMode: "balanced" | "strict" | "maximum-privacy",
  inspect: boolean,
): Promise<ScanResult> {
  buildFixture();
  const report = await prepareWorkspace(sourceDir, {
    safetyMode,
    managedWorkspaceBase: managedBase,
    ...(inspect ? { documentInspector: piiInspector } : { deferDocumentInspection: true }),
    deferLocalSummary: true,
  });
  // `session.json` is written by the launch path, not by prepare itself.
  await writePreparedRunSession(report);

  const outDir = report.outDir;
  const relpaths = filesUnder(outDir);
  const deliveredNames = relpaths.join("\n");
  const withheld = report.files
    .filter((file) => file.omitted === true)
    .map((file) => file.originalRelpath ?? file.relpath);

  // Only tokens that name a WITHHELD file and are carried by no delivered file: a
  // delivered file's own name is visible in the tree anyway, so it is not a leak.
  const tokens = IDENTIFYING_TOKENS.filter(
    (token) => withheld.some((source) => source.includes(token)) && !deliveredNames.includes(token),
  );

  const leaks: Record<string, string[]> = {};
  for (const rel of relpaths) {
    const text = readFileSync(path.join(outDir, rel)).toString("utf8");
    const hits = tokens.filter((token) => text.includes(token) || rel.includes(token));
    if (hits.length > 0) leaks[rel] = hits;
  }
  return {
    outDir,
    withheld,
    leaks,
    surfacesPresent: METADATA_SURFACES.filter((surface) => existsSync(path.join(outDir, surface))),
  };
}

describe("agent-visible metadata boundary (adversarial scan)", () => {
  for (const mode of ["balanced", "strict", "maximum-privacy"] as const) {
    for (const inspect of [false, true]) {
      it(`${mode}${inspect ? " (documents inspected)" : ""}: no withheld filename in any agent-visible byte`, async () => {
        const scan = await prepareAndScan(mode, inspect);
        // The scan must be meaningful: something WAS withheld and had an identifying name.
        expect(scan.withheld.length).toBeGreaterThan(0);
        expect(scan.leaks).toEqual({});
        // Every metadata surface exists (a missing surface must not pass by absence).
        expect(scan.surfacesPresent).toEqual(METADATA_SURFACES);
      }, 60_000);
    }
  }

  it("keeps the raw student number out of the workspace entirely, name and content", async () => {
    const scan = await prepareAndScan("balanced", false);
    for (const rel of filesUnder(scan.outDir)) {
      expect(rel).not.toContain(STUDENT_ID);
      expect(readFileSync(path.join(scan.outDir, rel)).toString("utf8")).not.toContain(STUDENT_ID);
    }
  }, 60_000);

  it("identifies a withheld file by documentId + kind-only displayName, never a path", async () => {
    const scan = await prepareAndScan("maximum-privacy", false);
    const manifest = JSON.parse(readFileSync(path.join(scan.outDir, "manifest.json"), "utf8")) as {
      files: { relpath: string; displayName?: string; documentId?: string; omitted?: boolean; originalRelpath?: string }[];
    };
    const withheldEntries = manifest.files.filter((file) => file.omitted === true);
    expect(withheldEntries.length).toBeGreaterThan(0);
    for (const entry of withheldEntries) {
      expect(entry.documentId).toMatch(/^doc-[0-9a-f]{12}$/);
      expect(entry.displayName).toBe(entry.relpath);
      // A kind-only label: identity plus at most an extension, and never a directory.
      expect(entry.relpath).toMatch(/^doc-[0-9a-f]{12}(?:\.[a-z0-9]{1,8})?$/);
      expect(entry.originalRelpath).toBeUndefined();
    }
    // Delivered entries keep the real (already de-identified) path the agent can see.
    const delivered = manifest.files.filter((file) => file.omitted !== true);
    expect(delivered.some((file) => file.relpath === "src/app.ts")).toBe(true);
  }, 60_000);

  it("names generated context artifacts by identity, not by the source basename", async () => {
    // The summary artifact lands under `.yuhi/`, which the filename de-identification
    // pass deliberately skips — so its NAME has to come from the document identity.
    buildFixture();
    // A text document whose own name carries the student number and needs summarizing.
    writeFileSync(
      path.join(sourceDir, "docs", `${STUDENT_ID}-評定-notes.txt`),
      "Long-form notes about the term. ".repeat(120),
    );
    const report = await prepareWorkspace(sourceDir, {
      safetyMode: "balanced",
      managedWorkspaceBase: managedBase,
      documentInspector: cleanInspector,
      provider: fakeProvider(),
    });
    const relpaths = filesUnder(report.outDir);
    // No agent-visible FILENAME anywhere carries the identifier — including `.yuhi/`.
    for (const rel of relpaths) expect(rel).not.toContain(STUDENT_ID);
    const index = readFileSync(
      path.join(report.outDir, ".yuhi", "context", "document-index.md"),
      "utf8",
    );
    expect(index).not.toContain(STUDENT_ID);
    // Whatever the index points at must actually exist in the workspace.
    for (const match of index.matchAll(/- Context file: (\S+)/g)) {
      expect(existsSync(path.join(report.outDir, ...match[1]!.split("/")))).toBe(true);
    }
  }, 120_000);

  it("counts withheld files honestly even though their names are gone", async () => {
    const scan = await prepareAndScan("maximum-privacy", false);
    const summary = JSON.parse(
      readFileSync(path.join(scan.outDir, ".yuhi", "yuhi-mode-summary.json"), "utf8"),
    ) as { contextAvailability: Record<string, number> };
    const availability = summary.contextAvailability;
    const stateSum = Object.values(availability).reduce((total, value) => total + value, 0);
    // Every withheld file is still REPORTED — the boundary removes names, not counts.
    expect(stateSum).toBeGreaterThanOrEqual(scan.withheld.length);
    expect(availability.knownRisksBlocked).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
