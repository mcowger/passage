import { describe, expect, test } from "bun:test";
import {
  BUILTIN_FONTS,
  BUILTIN_THEMES,
  BUILTIN_TOOL_RENDERERS,
  fontPackSchema,
  themePackSchema,
  toolRendererPackSchema,
} from "./customization.ts";

describe("customization domain packs", () => {
  test("validates built-in themes against strict color and structure schemas", () => {
    expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(3);
    for (const theme of BUILTIN_THEMES) {
      const parsed = themePackSchema.safeParse(theme);
      expect(parsed.success).toBe(true);
      expect(theme.tokens.background).toMatch(/^#/);
      expect(theme.tokens.foreground).toMatch(/^#/);
      expect(theme.tokens.surface).toMatch(/^#/);
    }
  });

  test("rejects invalid theme colors or script injection", () => {
    const invalidTheme = {
      id: "evil-theme",
      name: "Evil",
      mode: "dark",
      tokens: {
        background: "javascript:alert(1)",
        foreground: "#ffffff",
        surface: "#121212",
        surfaceElevated: "#1e1e1e",
        border: "#404040",
        borderStrong: "#ffffff",
        accent: "#00e5ff",
        accentHover: "#18ffff",
        muted: "#a0a0a0",
        statusRunning: "#00e676",
        statusIdle: "#00e5ff",
        statusError: "#ff1744",
        statusWarning: "#ffd600",
      },
    };
    expect(themePackSchema.safeParse(invalidTheme).success).toBe(false);
  });

  test("validates built-in font packs", () => {
    expect(BUILTIN_FONTS.length).toBeGreaterThanOrEqual(2);
    for (const font of BUILTIN_FONTS) {
      expect(fontPackSchema.safeParse(font).success).toBe(true);
    }
  });

  test("validates declarative tool renderer packs", () => {
    expect(toolRendererPackSchema.safeParse(BUILTIN_TOOL_RENDERERS).success).toBe(true);
    expect(BUILTIN_TOOL_RENDERERS.matchers.some((m) => m.toolName === "bash")).toBe(true);
    expect(BUILTIN_TOOL_RENDERERS.matchers.some((m) => m.toolName === "edit")).toBe(true);
  });
});
