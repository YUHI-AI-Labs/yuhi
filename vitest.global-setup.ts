/**
 * Runs ONCE, in the main process, before any test file starts.
 *
 * Several CLI test files spawn the BUILT binary (`apps/cli/dist/index.js`) as a real
 * subprocess rather than mocking it. Each used to run `pnpm --filter @yuhi-ai-labs/yuhi
 * build` in its own `beforeAll` — harmless when a file runs alone, but vitest runs test
 * files in separate parallel workers by default, so two files' builds raced on the SAME
 * `dist/` output: one worker's "clean output folder" step could delete a chunk another
 * worker's spawned CLI subprocess was mid-import on (`ERR_MODULE_NOT_FOUND`). Building
 * once here, before any worker starts, removes the race instead of asking each test file
 * to avoid it.
 */
import { execFileSync } from "node:child_process";

export default function globalSetup(): void {
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@yuhi-ai-labs/yuhi", "build"], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
}
