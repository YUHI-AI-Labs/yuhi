import * as vscode from "vscode";
import type { PreparedMetrics } from "@yuhi/core";

export const YUHI_ACTIVITY_VIEW_ID = "yuhi.workspace";

type ActivityState =
  | { ready: false }
  | { ready: false; recovery: true; reason: string }
  | { ready: true; metrics: PreparedMetrics; runLabel: string; sandboxed: boolean };

export class YuhiActivityProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private state: ActivityState = { ready: false };

  setNotPrepared(): void {
    this.state = { ready: false };
    this.changed.fire(undefined);
  }

  setRecoveryRequired(reason: string): void {
    this.state = { ready: false, recovery: true, reason };
    this.changed.fire(undefined);
  }

  setPrepared(
    metrics: PreparedMetrics,
    runLabel = "Most recent prepared run",
    sandboxed = true,
  ): void {
    this.state = { ready: true, metrics, runLabel, sandboxed };
    this.changed.fire(undefined);
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    if (!this.state.ready && "recovery" in this.state) {
      return [
        item("Recovery required", "recoveryStatus", undefined, "warning"),
        item(this.state.reason, "recoveryReason"),
        item(
          "Choose Source Folder and Prepare Again",
          "primaryAction",
          "yuhi.restartFlow",
          "folder-opened",
        ),
        item("Open Source Workspace", "recoveryAction", "yuhi.openSourceWorkspace", "folder"),
        item("Dismiss Previous Run", "recoveryAction", "yuhi.dismissPreviousRun", "close"),
      ];
    }
    const status = item(
      this.state.ready
        ? this.state.sandboxed
          ? "Claude Code with Yuhi · Sandboxed"
          : "Yuhi advisory workspace · Claude blocked"
        : "Not prepared",
      "status",
    );
    const prepare = item("Prepare and Start", "action", "yuhi.prepareAndStartClaude", "play");
    const review = item(
      "Review Prepared Context",
      "action",
      "yuhi.reviewPrepared",
      "open-preview",
      !this.state.ready,
    );
    if (!this.state.ready) {
      return [
        status,
        item(
          "Start Claude Code with Yuhi",
          "primaryAction",
          "yuhi.prepareAndStartClaude",
          "shield",
        ),
        item(
          "Yuhi prepares the initial context, then opens Claude Code.",
          "descriptionAction",
          "yuhi.prepareAndStartClaude",
        ),
        prepare,
        item("Start Over / Choose Source Folder", "recoveryAction", "yuhi.restartFlow", "refresh"),
        review,
      ];
    }
    const m = this.state.metrics;
    return [
      status,
      item("Open Claude Code", "action", "yuhi.openClaudeHere", "comment-discussion"),
      review,
      item("Switch Workspace with Yuhi", "action", "yuhi.switchWorkspace", "folder-opened"),
      item("Start Over / Choose Source Folder", "recoveryAction", "yuhi.restartFlow", "refresh"),
      item("Exit Yuhi Workspace", "action", "yuhi.exitWorkspace", "sign-out"),
      item(`${m.filesSentUnchanged + m.filesPreparedLocally} files included`, "metric"),
      item(`${m.sensitiveValuesMasked} masked`, "metric"),
      item(`${m.filesExcluded} excluded`, "metric"),
      item(this.state.runLabel, "recent", undefined, "history"),
    ];
  }
}

function item(
  label: string,
  contextValue: string,
  command?: string,
  icon?: string,
  disabled = false,
): vscode.TreeItem {
  const treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  treeItem.contextValue = contextValue;
  if (command && !disabled) treeItem.command = { command, title: label };
  if (icon) treeItem.iconPath = new vscode.ThemeIcon(icon);
  if (command && !disabled) treeItem.tooltip = `${label}\nClick to run.`;
  if (disabled) treeItem.description = "Prepare first";
  return treeItem;
}
