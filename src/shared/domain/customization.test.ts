import { describe, expect, test } from "bun:test";
import {
  AVAILABLE_FONTS,
  BUILTIN_THEMES,
  BUILTIN_TOOL_RENDERERS,
  DEFAULT_FONT_MAPPING,
  FONT_ROLES,
  fontMappingSchema,
  fontOptionsForRole,
  fontOptionSchema,
  resolveFontFamilies,
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

  test("validates the per-surface font catalog", () => {
    expect(AVAILABLE_FONTS.length).toBeGreaterThanOrEqual(10);
    const ids = new Set<string>();
    for (const font of AVAILABLE_FONTS) {
      expect(fontOptionSchema.safeParse(font).success).toBe(true);
      expect(ids.has(font.id)).toBe(false);
      ids.add(font.id);
      expect(font.family.length).toBeGreaterThan(0);
    }
    // Every embedded family from src/web/styles/fonts.css is selectable.
    for (const family of ["Inter", "IBM Plex Sans", "Manrope", "Work Sans", "JetBrains Mono", "Fira Code", "Hack", "Caskaydia Cove", "Meslo LG", "Iosevka", "Source Code Pro", "Ubuntu Mono"]) {
      expect(AVAILABLE_FONTS.some((font) => font.family.includes(family))).toBe(true);
    }
    expect(fontMappingSchema.safeParse(DEFAULT_FONT_MAPPING).success).toBe(true);
    for (const role of FONT_ROLES) {
      expect(ids.has(DEFAULT_FONT_MAPPING[role])).toBe(true);
    }
  });

  test("filters catalog options by role and resolves families with fallback", () => {
    expect(fontOptionsForRole(AVAILABLE_FONTS, "ui").every((font) => font.category === "ui")).toBe(true);
    expect(fontOptionsForRole(AVAILABLE_FONTS, "ui").length).toBeGreaterThan(0);
    for (const role of ["mono", "editor", "xterm"] as const) {
      const options = fontOptionsForRole(AVAILABLE_FONTS, role);
      expect(options.length).toBeGreaterThan(0);
      expect(options.every((font) => font.category === "mono")).toBe(true);
    }
    const resolved = resolveFontFamilies(AVAILABLE_FONTS, {
      ui: "inter",
      mono: "jetbrains-mono",
      editor: "fira-code",
      xterm: "no-such-font",
    });
    expect(resolved.ui).toContain("Inter");
    expect(resolved.mono).toContain("JetBrains Mono");
    expect(resolved.editor).toContain("Fira Code");
    // Unknown ids fall back to a usable system stack instead of an empty value.
    expect(resolved.xterm).toContain("monospace");
  });

  test("validates declarative tool renderer packs", () => {
    expect(toolRendererPackSchema.safeParse(BUILTIN_TOOL_RENDERERS).success).toBe(true);
    expect(BUILTIN_TOOL_RENDERERS.matchers.some((m) => m.toolName === "bash")).toBe(true);
    expect(BUILTIN_TOOL_RENDERERS.matchers.some((m) => m.toolName === "edit")).toBe(true);
  });
});
