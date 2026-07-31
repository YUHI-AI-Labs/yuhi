import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BackgroundPublisher,
  type BackgroundPreparationItem,
  type PublisherDeps,
  type RawExtraction,
} from "./index.js";

const roots: string[] = [];

interface Env {
  root: string;
  agentVisibleRoot: string;
  stagingDir: string;
}

function makeEnv(): Env {
  const root = mkdtempSync(path.join(tmpdir(), "yuhi-bg-pub-"));
  roots.push(root);
  const agentVisibleRoot = path.join(root, "ws");
  const stagingDir = path.join(root, "private", "staging");
  mkdirSync(agentVisibleRoot, { recursive: true });
  return { root, agentVisibleRoot, stagingDir };
}

function deps(env: Env, over: Partial<PublisherDeps> = {}): PublisherDeps {
  return {
    normalizer: { normalize: (t) => t },
    pseudonymizer: { pseudonymize: (t) => ({ text: t }) },
    inspector: { inspect: () => ({ ok: true, findings: [] }) },
    policy: { evaluate: () => ({ allowed: true }) },
    targets: { agentVisibleRoot: env.agentVisibleRoot, stagingDir: env.stagingDir },
    ...over,
  };
}

const item: BackgroundPreparationItem = {
  itemId: "i1",
  runId: "r1",
  contextId: "c1",
  relpath: "docs/report.pdf",
  kind: "document-extraction",
  sourceArtifactPath: "/abs/secret/docs/report.pdf",
  priority: 0,
  createdAt: 0,
};

function extraction(text: string): RawExtraction {
  return { text, preparedRelpath: "docs/report.md" };
}

/** All files that exist anywhere under a directory tree. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("BackgroundPublisher — safety gate", () => {
  it("refuses to construct when staging is inside the agent-visible root", () => {
    const env = makeEnv();
    expect(
      () =>
        new BackgroundPublisher(
          deps(env, {
            targets: {
              agentVisibleRoot: env.agentVisibleRoot,
              stagingDir: path.join(env.agentVisibleRoot, "staging"),
            },
          }),
        ),
    ).toThrow(/OUTSIDE/);
  });

  it("publishes the pseudonymized text atomically on full success", async () => {
    const env = makeEnv();
    const pub = new BackgroundPublisher(
      deps(env, { pseudonymizer: { pseudonymize: (t) => ({ text: t.replace("Alice", "PERSON_1") }) } }),
    );
    const out = await pub.publish(item, extraction("hello Alice"));
    expect(out.status).toBe("published");
    const target = path.join(env.agentVisibleRoot, "docs", "report.md");
    expect(readFileSync(target, "utf8")).toBe("hello PERSON_1");
  });

  it("publishes the de-identified text, never the raw pre-pseudonymize text", async () => {
    const env = makeEnv();
    const pub = new BackgroundPublisher(
      deps(env, {
        pseudonymizer: { pseudonymize: () => ({ text: "REDACTED-ONLY" }) },
      }),
    );
    await pub.publish(item, extraction("raw-secret-content"));
    const published = readFileSync(path.join(env.agentVisibleRoot, "docs", "report.md"), "utf8");
    expect(published).toBe("REDACTED-ONLY");
    expect(published).not.toContain("raw-secret-content");
  });

  it("keeps local (safety-rejected) when a secret is detected — nothing agent-visible", async () => {
    const env = makeEnv();
    const pub = new BackgroundPublisher(
      deps(env, { inspector: { inspect: () => ({ ok: false, findings: [{ category: "secret" }] }) } }),
    );
    const out = await pub.publish(item, extraction("AKIA... key"));
    expect(out).toEqual({ status: "rejected", reasonCode: "background-safety-rejected" });
    expect(listFiles(env.agentVisibleRoot)).toHaveLength(0);
  });

  it("keeps local (safety-rejected) when PII inspection flags a finding", async () => {
    const env = makeEnv();
    const pub = new BackgroundPublisher(
      deps(env, { inspector: { inspect: () => ({ ok: true, findings: [{ category: "pii" }] }) } }),
    );
    const out = await pub.publish(item, extraction("name: real person"));
    expect(out.status).toBe("rejected");
    expect(listFiles(env.agentVisibleRoot)).toHaveLength(0);
  });

  it("keeps local when policy blocks the artifact", async () => {
    const env = makeEnv();
    const pub = new BackgroundPublisher(deps(env, { policy: { evaluate: () => ({ allowed: false }) } }));
    const out = await pub.publish(item, extraction("anything"));
    expect(out.status).toBe("rejected");
    expect(listFiles(env.agentVisibleRoot)).toHaveLength(0);
  });

  it("never writes a pre-inspection artifact under the agent-visible root", async () => {
    const env = makeEnv();
    // Inspector rejects: the pipeline must not have written anything the agent can see,
    // in staging OR (especially) under the workspace root.
    const pub = new BackgroundPublisher(
      deps(env, { inspector: { inspect: () => ({ ok: false, findings: [{ category: "secret" }] }) } }),
    );
    await pub.publish(item, extraction("pre-inspection bytes"));
    expect(listFiles(env.agentVisibleRoot)).toHaveLength(0);
    // Staging must also be clean (no leftover temp).
    expect(listFiles(env.stagingDir)).toHaveLength(0);
  });

  it("leaves no partial file at the target when the publish rename fails", async () => {
    const env = makeEnv();
    const pub = new BackgroundPublisher(deps(env));
    // Pre-create a DIRECTORY where the file should be published so the atomic
    // rename onto the target fails.
    mkdirSync(path.join(env.agentVisibleRoot, "docs", "report.md"), { recursive: true });
    const out = await pub.publish(item, extraction("safe content"));
    expect(out).toEqual({ status: "failed", reasonCode: "background-publication-failed" });
    // The target is still the empty directory — no partial file was written into it,
    // and the private staging temp was cleaned up.
    expect(listFiles(path.join(env.agentVisibleRoot, "docs", "report.md"))).toHaveLength(0);
    expect(listFiles(env.stagingDir)).toHaveLength(0);
  });

  it("rejects an absolute or traversal publish path (no escape from the workspace)", async () => {
    const env = makeEnv();
    const pub = new BackgroundPublisher(deps(env));
    const abs = await pub.publish(item, { text: "x", preparedRelpath: "/etc/passwd" });
    expect(abs.status).toBe("failed");
    const trav = await pub.publish(item, { text: "x", preparedRelpath: "../../escape.md" });
    expect(trav.status).toBe("failed");
    expect(listFiles(env.agentVisibleRoot)).toHaveLength(0);
  });

  it("exposes only a reason code and relpath — no raw error, no absolute path", async () => {
    const env = makeEnv();
    const pub = new BackgroundPublisher(
      deps(env, {
        inspector: {
          inspect: () => {
            throw new Error(`boom at ${env.root}/secret/orig.pdf`);
          },
        },
      }),
    );
    // An injected inspector that throws must fail closed to keep-local, never
    // throw out of publish(), and never leak the absolute path in its error.
    const out = await pub.publish(item, extraction("x"));
    expect(out).toEqual({ status: "rejected", reasonCode: "background-safety-rejected" });
    expect(JSON.stringify(out)).not.toContain(env.root);
    expect(listFiles(env.agentVisibleRoot)).toHaveLength(0);
  });
});
