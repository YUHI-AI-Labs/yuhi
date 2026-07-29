import { describe, expect, it } from "vitest";
import { PREPARED_WINDOW_TITLE, PREPARED_WORKBENCH_COLORS } from "./branding.js";

describe("Prepared Workspace branding", () => {
  it("brands the window without exposing a path", () => {
    expect(PREPARED_WINDOW_TITLE).toMatch(/^Claude Code with Yuhi/);
    expect(PREPARED_WINDOW_TITLE).not.toContain("/" + "Users/");
    expect(PREPARED_WINDOW_TITLE).not.toContain("${rootPath}");
  });

  it("uses restrained Yuhi blue with readable foregrounds", () => {
    expect(PREPARED_WORKBENCH_COLORS["titleBar.activeBackground"]).toBe("#075EA8");
    expect(PREPARED_WORKBENCH_COLORS["statusBar.background"]).toBe("#075EA8");
    expect(PREPARED_WORKBENCH_COLORS["titleBar.activeForeground"]).toBe("#FFFFFF");
    expect(PREPARED_WORKBENCH_COLORS["statusBar.foreground"]).toBe("#FFFFFF");
  });
});
