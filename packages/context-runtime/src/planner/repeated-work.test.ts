import { describe, expect, it } from "vitest";
import { RepeatedWorkTracker, repeatedWorkHint } from "./repeated-work.js";

describe("RepeatedWorkTracker.observeDelivery", () => {
  it("classifies read/grep/glob/search/bash into their event types", () => {
    const t = new RepeatedWorkTracker();
    expect(t.observeDelivery("read", "obj-1", 100)?.type).toBe("exact-read");
    expect(t.observeDelivery("grep", "obj-2", 100)?.type).toBe("exact-search");
    expect(t.observeDelivery("glob", "obj-3", 100)?.type).toBe("exact-search");
    expect(t.observeDelivery("search", "obj-4", 100)?.type).toBe("exact-search");
    expect(t.observeDelivery("bash", "obj-5", 100)?.type).toBe("exact-command");
  });

  it("does not cover test/mcp/conversation tools", () => {
    const t = new RepeatedWorkTracker();
    expect(t.observeDelivery("test", "obj-1", 100)).toBeUndefined();
    expect(t.observeDelivery("mcp", "obj-1", 100)).toBeUndefined();
    expect(t.observeDelivery("conversation", "obj-1", 100)).toBeUndefined();
  });

  it("increments count per (objectId, type) pair, independently across objects", () => {
    const t = new RepeatedWorkTracker();
    t.observeDelivery("read", "obj-1", 50);
    const second = t.observeDelivery("read", "obj-1", 50);
    expect(second?.count).toBe(2);

    const otherObject = t.observeDelivery("read", "obj-2", 50);
    expect(otherObject?.count).toBe(1);
  });

  it("accumulates estimated avoidable tokens across events", () => {
    const t = new RepeatedWorkTracker();
    t.observeDelivery("read", "obj-1", 100);
    t.observeDelivery("read", "obj-1", 150);
    expect(t.stats().totalEstimatedAvoidableTokens).toBe(250);
  });
});

describe("RepeatedWorkTracker.observeRetrieval", () => {
  it("detects an exact repeated retrieval as contained-read", () => {
    const t = new RepeatedWorkTracker();
    const event = t.observeRetrieval("obj-1", "L10-L20", ["L10-L20"]);
    expect(event?.type).toBe("contained-read");
  });

  it("detects a strict-subset retrieval as contained-read", () => {
    const t = new RepeatedWorkTracker();
    const event = t.observeRetrieval("obj-1", "L12-L15", ["L10-L20"]);
    expect(event?.type).toBe("contained-read");
  });

  it("detects a partially-overlapping retrieval as overlapping-read", () => {
    const t = new RepeatedWorkTracker();
    const event = t.observeRetrieval("obj-1", "L15-L25", ["L10-L20"]);
    expect(event?.type).toBe("overlapping-read");
  });

  it("does not flag a disjoint retrieval", () => {
    const t = new RepeatedWorkTracker();
    const event = t.observeRetrieval("obj-1", "L30-L40", ["L10-L20"]);
    expect(event).toBeUndefined();
  });

  it("does not flag when there is no prior retrieval at all", () => {
    const t = new RepeatedWorkTracker();
    expect(t.observeRetrieval("obj-1", "L1-L10", [])).toBeUndefined();
  });
});

describe("RepeatedWorkTracker.shouldHint", () => {
  it("never hints on the first occurrence (count < 2)", () => {
    const t = new RepeatedWorkTracker();
    expect(t.shouldHint("obj-1", "exact-read", 1)).toBe(false);
  });

  it("hints once on the second occurrence, then never again for the same pair", () => {
    const t = new RepeatedWorkTracker();
    expect(t.shouldHint("obj-1", "exact-read", 2)).toBe(true);
    expect(t.shouldHint("obj-1", "exact-read", 3)).toBe(false);
    expect(t.shouldHint("obj-1", "exact-read", 4)).toBe(false);
  });

  it("hints independently per (objectId, type) pair", () => {
    const t = new RepeatedWorkTracker();
    expect(t.shouldHint("obj-1", "exact-read", 2)).toBe(true);
    expect(t.shouldHint("obj-1", "exact-search", 2)).toBe(true);
    expect(t.shouldHint("obj-2", "exact-read", 2)).toBe(true);
  });
});

describe("repeatedWorkHint", () => {
  it("returns a short, non-empty string for every type", () => {
    const types = ["exact-read", "contained-read", "overlapping-read", "exact-search", "exact-command", "premature-full-suite"] as const;
    for (const type of types) {
      const hint = repeatedWorkHint(type);
      expect(hint.length).toBeGreaterThan(0);
      expect(hint.length).toBeLessThan(120);
    }
  });

  it("distinguishes exact-search, exact-command, and overlapping-read from each other", () => {
    expect(repeatedWorkHint("exact-search")).not.toBe(repeatedWorkHint("exact-command"));
    expect(repeatedWorkHint("overlapping-read")).not.toBe(repeatedWorkHint("exact-command"));
  });
});
