import { createInterface } from "node:readline/promises";

/** Minimal yes/no prompt. Returns `def` when non-interactive. */
export async function confirm(question: string, def = false): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = def ? " [Y/n] " : " [y/N] ";
    const answer = (await rl.question(question + suffix)).trim().toLowerCase();
    if (answer === "") return def;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
