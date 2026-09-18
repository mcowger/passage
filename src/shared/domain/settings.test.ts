import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKSPACE_SETTINGS,
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
