import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStudentAliasContext, pseudonymizeStudentRecords } from "@yuhi/shared";

import {
  privateAliasRegistryPath,
  readPrivateAliasRegistry,
  writePrivateAliasRegistry,
} from "./alias-registry-store.js";
import { privateBackgroundDir } from "./status.js";

let managedBase: string;
const RUN = "run-alias-1";

beforeEach(() => {
  managedBase = mkdtempSync(path.join(tmpdir(), "yuhi-alias-registry-"));
});

afterEach(() => {
  rmSync(managedBase, { recursive: true, force: true });
});

describe("alias-registry-store", () => {
  it("round-trips a populated registry losslessly", async () => {
    const context = createStudentAliasContext();
    pseudonymizeStudentRecords("学籍番号,氏名\nSID_CANARY_001,山田太郎\n", context);

    await writePrivateAliasRegistry(managedBase, RUN, context);
    const restored = await readPrivateAliasRegistry(managedBase, RUN);
    expect(restored.nextEntity).toBe(context.nextEntity);
    expect([...restored.directValueTokens]).toEqual([...context.directValueTokens]);
  });

  it("writes under .internal/, never anywhere agent-visible, with private permissions", async () => {
    const context = createStudentAliasContext();
    await writePrivateAliasRegistry(managedBase, RUN, context);
    const file = privateAliasRegistryPath(managedBase, RUN);
    expect(file.startsWith(path.join(managedBase, ".internal"))).toBe(true);
    expect(file).toBe(path.join(privateBackgroundDir(managedBase, RUN), "alias-registry.json"));
    // 0600: owner read/write only.
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("leaves no temp file behind after a successful write", async () => {
    const context = createStudentAliasContext();
    await writePrivateAliasRegistry(managedBase, RUN, context);
    const dir = privateBackgroundDir(managedBase, RUN);
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(dir);
    expect(entries).toEqual(["alias-registry.json"]);
  });

  it("readPrivateAliasRegistry throws on a missing file (caller decides the safe fallback)", async () => {
    await expect(readPrivateAliasRegistry(managedBase, RUN)).rejects.toThrow();
  });

  it("readPrivateAliasRegistry throws on corrupt JSON rather than partially loading it", async () => {
    const dir = privateBackgroundDir(managedBase, RUN);
    mkdirSync(dir, { recursive: true });
    writeFileSync(privateAliasRegistryPath(managedBase, RUN), "{ not valid json", "utf8");
    await expect(readPrivateAliasRegistry(managedBase, RUN)).rejects.toThrow();
  });

  it("readPrivateAliasRegistry throws on a runId that does not match the file it read", async () => {
    const context = createStudentAliasContext();
    await writePrivateAliasRegistry(managedBase, RUN, context);
    await expect(readPrivateAliasRegistry(managedBase, "a-different-run")).rejects.toThrow();
  });

  it("a later run does not see an earlier run's registry (token-space isolation)", async () => {
    const contextA = createStudentAliasContext();
    pseudonymizeStudentRecords("学籍番号,氏名\nSID_CANARY_001,山田太郎\n", contextA);
    await writePrivateAliasRegistry(managedBase, "run-a", contextA);

    // "run-b" never had anything written for it.
    await expect(readPrivateAliasRegistry(managedBase, "run-b")).rejects.toThrow();
  });
});
