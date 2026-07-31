import { describe, it, expect } from "vitest";
import { toPublicAgentSessionManifest } from "./session-manifest.js";
import type { AgentSession } from "./adapter.js";

function session(): AgentSession {
  return {
    sessionId: "sess-1",
    contextId: "sha256:" + "b".repeat(64),
    agent: { id: "claude", displayName: "Claude Code", adapterVersion: "0.3.4" },
    workingDirectory: "/Users/someone/managed/prepared/run-1",
    status: "exited",
    startedAt: "1970-01-01T00:00:00.000Z",
    exitCode: 0,
  };
}

describe("Agent Session Manifest — public projection", () => {
  it("records the Context ID and the agent id/displayName/adapterVersion", () => {
    const m = toPublicAgentSessionManifest(session());
    expect(m.kind).toBe("agent-session");
    expect(m.contextId).toBe(session().contextId);
    expect(m.agent).toEqual({ id: "claude", displayName: "Claude Code", adapterVersion: "0.3.4" });
    expect(m.sessionId).toBe("sess-1");
    expect(m.status).toBe("exited");
    expect(m.exitCode).toBe(0);
  });

  it("drops the absolute working directory (no abspath / user identity leaks)", () => {
    const m = toPublicAgentSessionManifest(session());
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("workingDirectory");
    expect("workingDirectory" in m).toBe(false);
  });

  it("records WHICH progressive revision it used and still drops the abspath", () => {
    const revisionId = "sha256:" + "c".repeat(64);
    const m = toPublicAgentSessionManifest({ ...session(), revision: 2, revisionId });
    expect(m.revision).toBe(2);
    expect(m.revisionId).toBe(revisionId);
    // The immutable base Context ID is unchanged by the revision fields.
    expect(m.contextId).toBe(session().contextId);
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("workingDirectory");
  });

  it("omits the revision fields entirely for a session that recorded none (backward-compatible)", () => {
    const m = toPublicAgentSessionManifest(session());
    expect("revision" in m).toBe(false);
    expect("revisionId" in m).toBe(false);
  });

  it("is a SEPARATE artifact from the deterministic Context Manifest", () => {
    // The session manifest is per-run (sessionId, status) and carries only a LINK
    // to the context via contextId — it is not the Context Manifest itself.
    const m = toPublicAgentSessionManifest(session());
    expect(m).toHaveProperty("sessionId");
    expect(m).toHaveProperty("contextId");
    expect(m).not.toHaveProperty("files");
    expect(m).not.toHaveProperty("summary");
  });
});
