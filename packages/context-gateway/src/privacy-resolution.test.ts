/**
 * v0.4.8 Phase 3B/4 — Privacy Mode resolution shared by every dynamic-launch surface
 * (CLI `yuhi launch --dynamic-context`, VS Code Dynamic Terminal, Native GUI Mode).
 *
 * `resolveLaunchPrivacyMode` is pure and carries the safety-critical mode-mismatch
 * refusal, so it gets direct unit tests here rather than only being reachable through
 * a spawned CLI subprocess or a running editor.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readPreparedPrivacyMode, resolveLaunchPrivacyMode } from "./launch-session.js";

describe("readPreparedPrivacyMode", () => {
  it("reads a v0.4.8 manifest's recorded mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuhi-manifest-"));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({ privacyPolicy: { mode: "strict" } }),
      "utf8",
    );
    expect(await readPreparedPrivacyMode(dir)).toBe("strict");
  });

  it("returns undefined for a pre-0.4.8 manifest with no privacyPolicy field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuhi-manifest-"));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ contextId: "sha256:abc" }), "utf8");
    expect(await readPreparedPrivacyMode(dir)).toBeUndefined();
  });

  it("returns undefined rather than throwing when manifest.json is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuhi-manifest-"));
    expect(await readPreparedPrivacyMode(dir)).toBeUndefined();
  });

  it("returns undefined for a corrupt privacyPolicy.mode value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yuhi-manifest-"));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ privacyPolicy: { mode: "paranoid" } }), "utf8");
    expect(await readPreparedPrivacyMode(dir)).toBeUndefined();
  });
});

describe("resolveLaunchPrivacyMode", () => {
  it("defaults to balanced with no flags and an unknown-mode prepared run", () => {
    const result = resolveLaunchPrivacyMode({
      rawPrivacyMode: "",
      legacyDeliveryMode: "developer",
      preparedPrivacyMode: undefined,
      trustedLocalAcknowledged: false,
    });
    expect(result).toEqual({ ok: true, privacyMode: "balanced" });
  });

  it("an explicit privacy-mode selection wins over everything else", () => {
    const result = resolveLaunchPrivacyMode({
      rawPrivacyMode: "strict",
      legacyDeliveryMode: "developer",
      preparedPrivacyMode: "balanced",
      trustedLocalAcknowledged: false,
    });
    expect(result).toEqual({ ok: true, privacyMode: "strict" });
  });

  it("inherits the prepared run's mode when no explicit privacy-mode is given", () => {
    const result = resolveLaunchPrivacyMode({
      rawPrivacyMode: "",
      legacyDeliveryMode: "developer",
      preparedPrivacyMode: "strict",
      trustedLocalAcknowledged: false,
    });
    expect(result).toEqual({ ok: true, privacyMode: "strict" });
  });

  it("legacy delivery-mode strict maps to Privacy Mode strict when nothing else is set", () => {
    const result = resolveLaunchPrivacyMode({
      rawPrivacyMode: "",
      legacyDeliveryMode: "strict",
      preparedPrivacyMode: undefined,
      trustedLocalAcknowledged: false,
    });
    expect(result).toEqual({ ok: true, privacyMode: "strict" });
  });

  it("an invalid privacy-mode value fails closed", () => {
    const result = resolveLaunchPrivacyMode({
      rawPrivacyMode: "paranoid",
      legacyDeliveryMode: "developer",
      preparedPrivacyMode: undefined,
      trustedLocalAcknowledged: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(3);
    expect(result.message).toMatch(/Unknown Privacy Mode/);
  });

  it("trusted-local without acknowledgement fails closed", () => {
    const result = resolveLaunchPrivacyMode({
      rawPrivacyMode: "trusted-local",
      legacyDeliveryMode: "developer",
      preparedPrivacyMode: undefined,
      trustedLocalAcknowledged: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/acknowledg/i);
  });

  it("refuses an explicit balanced/strict launch against a Trusted-Local-prepared run", () => {
    const result = resolveLaunchPrivacyMode({
      rawPrivacyMode: "balanced",
      legacyDeliveryMode: "developer",
      preparedPrivacyMode: "trusted-local",
      trustedLocalAcknowledged: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.exitCode).toBe(3);
    expect(result.message).toMatch(/Privacy Mode mismatch/);
    expect(result.message).toMatch(/Trusted Local/);
  });

  it("does NOT refuse when no explicit selection is given, even against a Trusted-Local-prepared run (inherits instead)", () => {
    const result = resolveLaunchPrivacyMode({
      rawPrivacyMode: "",
      legacyDeliveryMode: "developer",
      preparedPrivacyMode: "trusted-local",
      trustedLocalAcknowledged: true,
    });
    expect(result).toEqual({ ok: true, privacyMode: "trusted-local" });
  });

  it("does NOT refuse an explicit trusted-local launch against a Trusted-Local-prepared run", () => {
    const result = resolveLaunchPrivacyMode({
      rawPrivacyMode: "trusted-local",
      legacyDeliveryMode: "developer",
      preparedPrivacyMode: "trusted-local",
      trustedLocalAcknowledged: true,
    });
    expect(result).toEqual({ ok: true, privacyMode: "trusted-local" });
  });

  it("does NOT refuse a Trusted-Local launch against a Balanced/Strict-prepared run (files are already masked at rest)", () => {
    const result = resolveLaunchPrivacyMode({
      rawPrivacyMode: "trusted-local",
      legacyDeliveryMode: "developer",
      preparedPrivacyMode: "strict",
      trustedLocalAcknowledged: true,
    });
    expect(result).toEqual({ ok: true, privacyMode: "trusted-local" });
  });
});
