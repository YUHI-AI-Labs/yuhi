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
      type: "webview",
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

  it("renders the preparation guidance as an actionable webview panel", () => {
    const panel = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/activity-panel.ts"),
      "utf8",
    );
    const view = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/activity-view.ts"),
      "utf8",
    );
    // The empty/ready panels offer real actions, wired to commands (not dead rows).
    expect(panel).toContain("Prepare with Yuhi");
    expect(panel).toContain("Start Claude Code");
    expect(view).toContain('vscode.commands.executeCommand("yuhi.prepareAndStartClaude")');
    expect(view).toContain("implements vscode.WebviewViewProvider");
  });

  it("does not auto-run launch when the Activity Bar view becomes visible", () => {
    const view = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/activity-view.ts"),
      "utf8",
    );
    const extension = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    // Becoming visible only reconciles prepared state; it must never auto-launch.
    expect(view).toContain("onDidChangeVisibility");
    expect(extension).toContain("reconcilePreparedWorkspace(current, current)");
    expect(view).not.toContain("openClaudeInPreparedWorkspace");
    expect(view).not.toContain("prepareAndStartClaude()");
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

  it("presents preparation as Yuhi processing with real phase and count progress", () => {
    const source = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    expect(source).toContain("Yuhi is processing locally…");
    expect(source).toContain("Step ${phaseIndex + 1} of ${PREPARATION_PHASES.length}");
    expect(source).toContain("onProgressDetail: (event)");
    expect(source).not.toContain("Qwen is processing");
  });

  it("uses recovery instead of preparing an already Prepared Workspace", () => {
    const source = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    expect(source).toContain("async function sourceWorkspaceForClaudeLaunch(");
    expect(source).toContain('title = "Choose a folder to prepare with Yuhi"');
    expect(source).toContain('openLabel = "Prepare this folder"');
    expect(source).toContain("defaultUri: vscode.Uri.file(openRoot)");
    expect(source).toContain("getWorkspaceRoot: () => sourceRoot");
    expect(source).toContain("await showPreparedWorkspaceRecovery(openRoot)");
    expect(source).not.toMatch(
      /async function sourceWorkspaceForClaudeLaunch\(\)[\s\S]*?if \(openRoot\) return openRoot/,
    );
  });

  it("keeps the activity panel on one guided path", () => {
    const panel = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/activity-panel.ts"),
      "utf8",
    );
    const extension = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    // The panel presents one guided path: Prepare → Start Claude Code (+ details).
    expect(panel).toContain("Prepare with Yuhi");
    expect(panel).toContain("Start Claude Code");
    expect(panel).not.toContain("Switch Workspace");
    expect(panel).not.toContain("Exit Yuhi Workspace");
    expect(extension).toContain('"Prepare and switch",');
    expect(extension).toContain('executeCommand("workbench.action.closeFolder")');
    expect(extension).toContain("originalWorkspaceForRun");
    expect(extension).toContain("Detected automatically");
  });

  it("hides internal commands from the normal Command Palette", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "apps/vscode/package.json"), "utf8"),
    ) as {
      contributes: {
        menus: {
          commandPalette: { command: string; when: string }[];
          "explorer/context": { command: string; group: string }[];
        };
      };
    };
    const hidden = new Set(
      packageJson.contributes.menus.commandPalette
        .filter(({ when }) => when === "false")
        .map(({ command }) => command),
    );
    for (const command of [
      "yuhi.doctor",
      "yuhi.setupLocalAI",
      "yuhi.prepareWorkspace",
      "yuhi.reviewPrepared",
      "yuhi.prepareHere",
      "yuhi.prepareAndOpen",
      "yuhi.reviewAgentChanges",
    ]) {
      expect(hidden).toContain(command);
    }
    expect(hidden).not.toContain("yuhi.prepareAndStartClaude");
    expect(packageJson.contributes.menus["explorer/context"]).toEqual([
      { command: "yuhi.prepareAndStartClaude", group: "yuhi@1" },
    ]);
  });

  it("shows honest elapsed preparation progress without fake percentages", () => {
    const source = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
    expect(source).toContain("Preparing with Yuhi");
    expect(source).toContain("processing locally");
    expect(source).toContain("seconds");
    expect(source).toContain("No files have been sent to Claude Code yet");
    expect(source).toContain("Preparation complete · Ready for review");
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
    const source = readFileSync(
      path.join(process.cwd(), "apps/vscode/src/extension.ts"),
      "utf8",
    );
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
