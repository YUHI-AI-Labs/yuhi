import pc from "picocolors";
import type { Action } from "@yuhi/shared";

export interface UiOptions {
  color: boolean;
  quiet: boolean;
  json: boolean;
}

let COLOR = true;

export function configureColor(enabled: boolean): void {
  COLOR = enabled && !process.env.NO_COLOR;
}

function paint(fn: (s: string) => string, s: string): string {
  return COLOR ? fn(s) : s;
}

export const ui = {
  bold: (s: string) => paint(pc.bold, s),
  dim: (s: string) => paint(pc.dim, s),
  green: (s: string) => paint(pc.green, s),
  yellow: (s: string) => paint(pc.yellow, s),
  red: (s: string) => paint(pc.red, s),
  cyan: (s: string) => paint(pc.cyan, s),
  blue: (s: string) => paint(pc.blue, s),
  magenta: (s: string) => paint(pc.magenta, s),
  gray: (s: string) => paint(pc.gray, s),
};

/** Blue Yuhi brand mark, mirroring the VS Code "Yuhi Mode" accent. */
export function yuhiMark(): string {
  return ui.bold(ui.blue("◆ YUHI"));
}

/**
 * A branded banner for the CLI, in the same blue accent as the VS Code panel.
 * `ready` mirrors "Yuhi Mode" (the Prepared Workspace is usable).
 */
export function yuhiBanner(state: "ready" | "partial" | "failed", detail?: string): string {
  const tail = detail ? "  " + ui.dim(detail) : "";
  if (state === "ready") {
    return `${yuhiMark()} ${ui.bold(ui.cyan("MODE"))}  ${ui.green("Prepared Workspace ready")}${tail}`;
  }
  if (state === "partial") {
    return `${yuhiMark()}  ${ui.yellow("Preparation incomplete")}${tail}`;
  }
  return `${yuhiMark()}  ${ui.red("Preparation failed")}${tail}`;
}

/** A text badge for each action (never color-only — accessibility). */
export function actionBadge(action: Action): string {
  switch (action) {
    case "allow":
      return ui.green("ALLOW");
    case "redact":
      return ui.yellow("REDACT");
    case "prepare-locally":
      return ui.magenta("PREPARE");
    case "block":
      return ui.red("BLOCK");
    case "local-only":
      return ui.cyan("LOCAL-ONLY");
    case "inject":
      return ui.cyan("RUNTIME");
    case "ask":
      return ui.yellow("ASK");
    case "metadata-only":
      return ui.dim("METADATA");
    case "summarize-local":
      return ui.dim("SUMMARIZE");
  }
}

export const symbols = {
  ok: () => ui.green("✓"),
  warn: () => ui.yellow("⚠"),
  err: () => ui.red("✗"),
  bullet: () => ui.dim("•"),
};

export function heading(title: string): string {
  return "\n" + ui.bold(title) + "\n";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
