import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Resolve an executable name on PATH without spawning anything. Cross-platform:
 * honors PATHEXT on Windows. Returns the absolute path or null.
 */
export function lookupOnPath(command: string): string | null {
  // Absolute/relative path given directly.
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? path.resolve(command) : null;
  }

  const pathVar = process.env.PATH ?? process.env.Path ?? "";
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function isInstalled(command: string): boolean {
  return lookupOnPath(command) !== null;
}
