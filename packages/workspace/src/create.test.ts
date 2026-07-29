import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
  rmSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { isYuhiError, type FileDecision } from "@yuhi/shared";
import { scanRepo, redactText } from "@yuhi/scanner";
import { resolvePolicy } from "@yuhi/policy";
import { createWorkspace } from "./create.js";

let parent: string;
let src: string;
let yuhiHome: string;

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), "yuhi-ws-"));
  src = path.join(parent, "src-repo");
  yuhiHome = path.join(parent, "yuhi-home");
  mkdirSync(src, { recursive: true });
  process.env.YUHI_HOME = yuhiHome;
});
afterEach(() => {
  delete process.env.YUHI_HOME;
  rmSync(parent, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer) {
  const abs = path.join(src, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function hashTree(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const st = lstatSync(abs);
      const rel = path.relative(root, abs);
      if (st.isDirectory()) {
        h.update("D:" + rel + "\n");
        walk(abs);
      } else if (st.isSymbolicLink()) {
        h.update("L:" + rel + "\n");
      } else {
        h.update("F:" + rel + ":" + readFileSync(abs).toString("hex") + "\n");
      }
    }
  };
  walk(root);
  return h.digest("hex");
}

const rules = [
  { name: "block-env", match: { paths: ["**/.env"] }, action: "block" as const },
  { name: "redact-secrets", match: { detectors: ["api-key"] }, action: "redact" as const },
  { name: "local-customer", match: { paths: ["customer-data/**"] }, action: "local-only" as const },
];

function buildDecisions(root: string) {
  const scan = scanRepo(root, { largeFileBytes: 5_000_000, entropyThreshold: 4.0, keywords: [] });
  const matchable = scan.files.map((f) => ({ relpath: f.relpath, findings: f.findings }));
  const evalResult = resolvePolicy(
    { defaultAction: "allow", rules, interactive: false },
    matchable,
  );
  return { scan, decisions: evalResult.decisions };
}

describe("createWorkspace (security-critical)", () => {
  it("copies allowed files, blocks secrets/local-only, redacts, and never touches the source", () => {
    write("src/index.ts", "export const x = 1;\n");
    write("README.md", "# Public\n");
    write(".env", "SECRET=" + "sk-ant-" + "abcdefghijklmnopqrstuvwxyz012345\n");
    write("config/app.ts", 'const key = "' + "AKIA" + 'IOSFODNN7EXAMPLE"; // aws\n');
    write("customer-data/list.csv", "alice,bob\n");

    const before = hashTree(src);
    const { scan, decisions } = buildDecisions(src);

    const { manifest, treeDir } = createWorkspace({
      sourceRoot: src,
      agent: "dummy",
      policyHash: "testhash",
      decisions,
      scan,
      entropyThreshold: 4.0,
      keywords: [],
      isGitRepo: false,
    });

    // Source is byte-for-byte unchanged.
    expect(hashTree(src)).toBe(before);

    // Allowed files present & identical.
    expect(existsSync(path.join(treeDir, "src/index.ts"))).toBe(true);
    expect(readFileSync(path.join(treeDir, "src/index.ts"), "utf8")).toBe("export const x = 1;\n");

    // Blocked & local-only NOT present.
    expect(existsSync(path.join(treeDir, ".env"))).toBe(false);
    expect(existsSync(path.join(treeDir, "customer-data/list.csv"))).toBe(false);

    // Redacted file present but secret removed.
    const redacted = readFileSync(path.join(treeDir, "config/app.ts"), "utf8");
    expect(redacted).not.toContain("AKIA" + "IOSFODNN7EXAMPLE");
    expect(redacted).toContain("«REDACTED");

    // Manifest accounting.
    expect(manifest.blocked).toContain(".env");
    expect(manifest.localOnly).toContain("customer-data/list.csv");
    expect(manifest.counts.transformed).toBeGreaterThanOrEqual(1);
  });

  it("does not follow symlinks that point outside the repo", () => {
    write("real.txt", "hi\n");
    const secretOutside = path.join(parent, "outside-secret.txt");
    writeFileSync(secretOutside, "TOP SECRET\n");
    try {
      symlinkSync(secretOutside, path.join(src, "leak.txt"));
    } catch {
      return; // symlink not permitted on this platform
    }

    const { scan, decisions } = buildDecisions(src);
    const { treeDir, manifest } = createWorkspace({
      sourceRoot: src,
      agent: "dummy",
      policyHash: "h",
      decisions,
      scan,
      entropyThreshold: 4.0,
      keywords: [],
      isGitRepo: false,
    });

    expect(existsSync(path.join(treeDir, "leak.txt"))).toBe(false);
    expect(manifest.symlinksSkipped).toContain("leak.txt");
  });

  it("refuses to write outside the workspace (path traversal)", () => {
    // A malicious decision with a traversal relpath, backed by a real source file.
    const evil = path.join(parent, "evil.txt");
    writeFileSync(evil, "pwned\n");
    const scan = scanRepo(src, { largeFileBytes: 5_000_000, entropyThreshold: 4, keywords: [] });
    const decisions: FileDecision[] = [
      {
        relpath: "../evil.txt",
        action: "allow",
        ruleName: "x",
        reason: "",
        destinations: ["external"],
        findings: [],
      },
    ];
    let threw = false;
    try {
      createWorkspace({
        sourceRoot: src,
        agent: "dummy",
        policyHash: "h",
        decisions,
        scan,
        entropyThreshold: 4,
        keywords: [],
        isGitRepo: false,
      });
    } catch (e) {
      threw = true;
      expect(isYuhiError(e) && e.code).toBe("PATH_ESCAPE");
    }
    expect(threw).toBe(true);
    expect(existsSync(path.join(path.dirname(evil), "repo"))).toBe(false);
  });

  it("dry-run computes a manifest without writing any files", () => {
    write("src/index.ts", "x\n");
    const { scan, decisions } = buildDecisions(src);
    const { manifest, treeDir } = createWorkspace({
      sourceRoot: src,
      agent: "dummy",
      policyHash: "h",
      decisions,
      scan,
      entropyThreshold: 4,
      keywords: [],
      isGitRepo: false,
      dryRun: true,
    });
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(existsSync(treeDir)).toBe(false);
  });

  it("redactText leaves non-secret content intact", () => {
    const { redacted, count } = redactText("just some code here", {
      entropyThreshold: 4,
      keywords: [],
    });
    expect(count).toBe(0);
    expect(redacted).toBe("just some code here");
  });
});
