import { describe, expect, test } from "bun:test";
import {
  DEFAULT_COMMIT_PROMPT,
  DEFAULT_TITLE_PROMPT,
  DEFAULT_WORKSPACE_SETTINGS,
  DEFAULT_WORKTREE_PROMPT,
  renderCommitPrompt,
  renderTitlePrompt,
  renderWorktreePrompt,
  workspaceSettingsSchema,
} from "./settings.ts";
import { DEFAULT_FONT_MAPPING } from "./customization.ts";

describe("workspace font mapping", () => {
  test("defaults fonts to the system stacks", () => {
    const { fonts, ...rest } = DEFAULT_WORKSPACE_SETTINGS;
    void fonts;
    const parsed = workspaceSettingsSchema.parse(rest);
    expect(parsed.fonts).toEqual(DEFAULT_FONT_MAPPING);
  });

  test("preserves an explicit per-surface mapping", () => {
    const parsed = workspaceSettingsSchema.parse({
      ...DEFAULT_WORKSPACE_SETTINGS,
      fonts: { ui: "inter", mono: "hack", editor: "hack", xterm: "meslo-lg" },
    });
    expect(parsed.fonts).toEqual({ ui: "inter", mono: "hack", editor: "hack", xterm: "meslo-lg" });
  });

  test("drops unknown keys from stored settings", () => {
    const parsed = workspaceSettingsSchema.parse({
      ...DEFAULT_WORKSPACE_SETTINGS,
      fontId: "system-default",
    });
    expect(parsed.fonts).toEqual(DEFAULT_FONT_MAPPING);
    expect("fontId" in parsed).toBe(false);
  });

  test("defaults prompt templates to blank (built-in default)", () => {
    expect(DEFAULT_WORKSPACE_SETTINGS.worktreePrompt).toBe("");
    expect(DEFAULT_WORKSPACE_SETTINGS.titlePrompt).toBe("");
    expect(DEFAULT_WORKSPACE_SETTINGS.commitPrompt).toBe("");
    const { worktreePrompt: _w, titlePrompt: _t, commitPrompt: _c, ...legacy } = DEFAULT_WORKSPACE_SETTINGS;
    void _w;
    void _t;
    void _c;
    const parsed = workspaceSettingsSchema.parse(legacy);
    expect(parsed.worktreePrompt).toBe("");
    expect(parsed.titlePrompt).toBe("");
    expect(parsed.commitPrompt).toBe("");
  });

  test("preserves explicit prompt templates", () => {
    const parsed = workspaceSettingsSchema.parse({
      ...DEFAULT_WORKSPACE_SETTINGS,
      worktreePrompt: "Purpose: {{purpose}}",
      titlePrompt: "Titles: {{messages}}",
      commitPrompt: "Files: {{files}} Diff: {{diff}}",
    });
    expect(parsed.worktreePrompt).toBe("Purpose: {{purpose}}");
    expect(parsed.titlePrompt).toBe("Titles: {{messages}}");
    expect(parsed.commitPrompt).toBe("Files: {{files}} Diff: {{diff}}");
  });

  test("renders worktree, title, and commit templates", () => {
    expect(renderWorktreePrompt("", "Fix login")).toBe(DEFAULT_WORKTREE_PROMPT.split("{{purpose}}").join("Fix login"));
    expect(renderWorktreePrompt("P: {{purpose}}", "Fix login")).toBe("P: Fix login");
    // Missing placeholder appends the value so the model still sees it.
    expect(renderWorktreePrompt("Custom", "Fix login")).toContain("Fix login");

    const title = renderTitlePrompt("", ["first", "second"]);
    expect(title).toContain("first");
    expect(title).toContain("second");
    expect(renderTitlePrompt("T: {{messages}}", ["hello"])).toContain("hello");
    expect(DEFAULT_TITLE_PROMPT).toContain("{{messages}}");

    const commit = renderCommitPrompt("", "a.ts (modified)", "+x");
    expect(commit).toContain("a.ts (modified)");
    expect(commit).toContain("+x");
    expect(renderCommitPrompt("F: {{files}} D: {{diff}}", "a", "b")).toBe("F: a D: b");
    expect(DEFAULT_COMMIT_PROMPT).toContain("{{files}}");
    expect(DEFAULT_COMMIT_PROMPT).toContain("{{diff}}");
    expect(DEFAULT_COMMIT_PROMPT).toContain("{{user_messages}}");
    expect(DEFAULT_COMMIT_PROMPT).toContain("{{final_assistant_messages}}");
  });

  test("renders commit conversation placeholders", () => {
    const rendered = renderCommitPrompt("U: {{user_messages}} A: {{final_assistant_messages}}", "a", "b", "req", "wrap");
    expect(rendered).toContain("U: req A: wrap");
    expect(rendered).toContain("a");
    expect(rendered).toContain("b");
    // Pre-existing custom templates without the new placeholders render
    // unchanged when there is no conversation context.
    expect(renderCommitPrompt("F: {{files}} D: {{diff}}", "a", "b")).toBe("F: a D: b");
    // Missing conversation placeholders are appended only when non-empty.
    expect(renderCommitPrompt("Custom", "a", "b", "req", "wrap")).toContain("req");
    expect(renderCommitPrompt("Custom", "a", "b", "req", "wrap")).toContain("wrap");
    expect(renderCommitPrompt("Custom", "a", "b")).not.toContain("User requests");
  });

  test("defaults ask to collapsed and backfills legacy expansion without ask", () => {
    expect(DEFAULT_WORKSPACE_SETTINGS.timelineExpansion.tools.ask).toBe("none");
    const { ask: _dropped, ...legacyTools } = DEFAULT_WORKSPACE_SETTINGS.timelineExpansion.tools;
    void _dropped;
    const parsed = workspaceSettingsSchema.parse({
      ...DEFAULT_WORKSPACE_SETTINGS,
      timelineExpansion: {
        ...DEFAULT_WORKSPACE_SETTINGS.timelineExpansion,
        tools: legacyTools,
      },
    });
    expect(parsed.timelineExpansion.tools.ask).toBe("none");
  });
});
