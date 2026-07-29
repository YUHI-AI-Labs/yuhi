import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(path.join(process.cwd(), "apps/vscode/package.json"), "utf8"),
) as {
  contributes: {
    viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
    views: Record<string, { id: string; name: string }[]>;
    commands: { command: string }[];
  };
};

describe("Yuhi Activity Bar contribution", () => {
  it("registers the Yuhi container and workspace view", () => {
    expect(manifest.contributes.viewsContainers.activitybar).toContainEqual({
      id: "yuhi",
      title: "Claude Code with Yuhi",
      icon: "media/yuhi-activity.svg",
    });
    expect(manifest.contributes.views.yuhi).toContainEqual({
      id: "yuhi.workspace",
      name: "Claude Code with Yuhi",
    });
  });

  it("uses a monochrome theme-aware SVG", () => {
    const svg = readFileSync(
      path.join(process.cwd(), "apps/vscode/media/yuhi-activity.svg"),
      "utf8",
    );
    expect(svg).toContain("currentColor");
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(svg).not.toContain("<style");
  });

  it("contributes both Activity Bar actions as commands", () => {
    const commands = manifest.contributes.commands.map(({ command }) => command);
    expect(commands).toContain("yuhi.prepareAndStartClaude");
    expect(commands).toContain("yuhi.reviewPrepared");
    expect(commands).toContain("yuhi.openClaudeHere");
    expect(commands).toContain("yuhi.switchWorkspace");
    expect(commands).toContain("yuhi.exitWorkspace");
    expect(commands).toContain("yuhi.restartFlow");
  });

  it("makes the initial-context guidance clickable instead of rendering a dead row", () => {
    const source = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/activity-view.ts"),
      "utf8",
    );
    expect(source).toContain('"Start Claude Code with Yuhi"');
    expect(source).toMatch(
      /"Yuhi prepares the initial context, then opens Claude Code\.",\s*"descriptionAction",\s*"yuhi\.prepareAndStartClaude"/s,
    );
    expect(source).not.toContain(
      'item("Prepare the initial context before opening Claude Code.", "description")',
    );
  });

  it("does not auto-run launch when the Activity Bar view becomes visible", () => {
    const source = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    expect(source).toContain("onDidChangeVisibility");
    expect(source).toContain("reconcilePreparedWorkspace(current, current)");
    expect(source).not.toMatch(
      /activityView\.visible\)\s*void openClaudeInPreparedWorkspace/,
    );
  });

  it("guards the visible launch flow against duplicate clicks", () => {
    const source = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    expect(source).toContain("let visibleCommandRunning = false");
    expect(source).toContain("if (visibleCommandRunning)");
    expect(source).toContain("visibleCommandRunning = true");
    expect(source).toMatch(/finally \{\s*visibleCommandRunning = false;/s);
  });

  it("always opens a source-folder picker for Start with Yuhi", () => {
    const source = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    expect(source).toContain("async function sourceWorkspaceForClaudeLaunch(");
    expect(source).toContain('title = "Choose a folder to prepare with Yuhi"');
    expect(source).toContain('openLabel = "Prepare this folder"');
    expect(source).toContain("defaultUri: vscode.Uri.file(openRoot)");
    expect(source).toContain("getWorkspaceRoot: () => sourceRoot");
    expect(source).not.toMatch(
      /async function sourceWorkspaceForClaudeLaunch\(\)[\s\S]*?if \(openRoot\) return openRoot/,
    );
  });

  it("offers explicit switch and exit actions without persisting a source path", () => {
    const activity = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/activity-view.ts"),
      "utf8",
    );
    const extension = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    expect(activity).toContain('"Switch Workspace with Yuhi"');
    expect(activity).toContain('"Exit Yuhi Workspace"');
    expect(extension).toContain('"Prepare and switch",');
    expect(extension).toContain('executeCommand("workbench.action.closeFolder")');
  });

  it("recovers an unavailable Prepared Workspace through the source picker", () => {
    const source = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    expect(source).toContain("async function commandOpenClaudeHere");
    expect(source).toContain("Previous Prepared Workspace is no longer available");
    expect(source).toContain('"Choose Source Folder and Prepare Again"');
    expect(source).toContain("await showRecoveryRequired");
    expect(source).toContain("runVisibleCommand(commandOpenClaudeHere)");
  });

  it("provides an always-available recovery command that resets transient flow state", () => {
    const activity = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/activity-view.ts"),
      "utf8",
    );
    const source = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    expect(activity.match(/Start Over \/ Choose Source Folder/g)?.length).toBe(2);
    expect(source).toContain("async function commandRestartFlow");
    expect(source).toContain("activePrepareController?.abort()");
    expect(source).toContain('pendingReviewDecision?.("cancel")');
    expect(source).toContain("visibleCommandRunning = false");
    expect(source).toContain("activityProvider?.setNotPrepared()");
    expect(source).toContain('registerCommand("yuhi.restartFlow"');
    expect(source).not.toContain(
      'registerCommand("yuhi.restartFlow", () =>\\n      runVisibleCommand',
    );
  });
});
