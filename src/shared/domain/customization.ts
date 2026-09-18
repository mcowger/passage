import { z } from "zod";

const colorRegex = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)$|^hsla?\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+\s*)?\)$/;

export const themeColorSchema = z.string().regex(colorRegex, "Must be a valid hex, rgb, or hsl color string");

export const themeTokensSchema = z.object({
  background: themeColorSchema,
  foreground: themeColorSchema,
  surface: themeColorSchema,
  surfaceSubtle: themeColorSchema.optional(),
  surfaceElevated: themeColorSchema.optional(),
  surfaceHover: themeColorSchema.optional(),
  surfaceSelected: themeColorSchema.optional(),
  border: themeColorSchema,
  borderStrong: themeColorSchema,
  accent: themeColorSchema,
  accentHover: themeColorSchema,
  accentSubtle: themeColorSchema.optional(),
  muted: themeColorSchema,
  statusRunning: themeColorSchema,
  statusIdle: themeColorSchema,
  statusError: themeColorSchema,
  statusWarning: themeColorSchema,
  userCardBg: themeColorSchema.optional(),
  userCardBorder: themeColorSchema.optional(),
  composerBg: themeColorSchema.optional(),
  composerBorder: themeColorSchema.optional(),
  chipBg: themeColorSchema.optional(),
  secondary: themeColorSchema.optional(),
  secondaryForeground: themeColorSchema.optional(),
  chipBlueBg: themeColorSchema.optional(),
  chipBlueFg: themeColorSchema.optional(),
  chipBlueBorder: themeColorSchema.optional(),
  diffAdd: themeColorSchema.optional(),
  diffAddSubtle: themeColorSchema.optional(),
  diffRemove: themeColorSchema.optional(),
  diffRemoveSubtle: themeColorSchema.optional(),
  diffHunk: themeColorSchema.optional(),
  diffHunkSubtle: themeColorSchema.optional(),
  terminalBackground: themeColorSchema.optional(),
  terminalForeground: themeColorSchema.optional(),
  editorBackground: themeColorSchema.optional(),
});
export type ThemeTokens = z.infer<typeof themeTokensSchema>;

export const themePackSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(64),
  mode: z.enum(["dark", "light", "system"]),
  tokens: themeTokensSchema,
});
export type ThemePack = z.infer<typeof themePackSchema>;

/** Per-surface font roles. Each role maps to one entry in the font catalog. */
export const FONT_ROLES = ["ui", "mono", "editor", "xterm"] as const;
export type FontRole = (typeof FONT_ROLES)[number];

export const fontOptionSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(64),
  /** CSS font-family value (includes fallbacks). */
  family: z.string().min(1).max(256),
  category: z.enum(["ui", "mono"]),
});
export type FontOption = z.infer<typeof fontOptionSchema>;

export const fontMappingSchema = z.object({
  ui: z.string().min(1).max(64),
  mono: z.string().min(1).max(64),
  editor: z.string().min(1).max(64),
  xterm: z.string().min(1).max(64),
});
export type FontMapping = z.infer<typeof fontMappingSchema>;

/**
 * Individually selectable fonts. Every entry is self-hosted under
 * src/web/fonts with @font-face declarations in src/web/styles/fonts.css,
 * so builds and the standalone binary serve them with no webfont CDN.
 * `family` values must match the @font-face family names in fonts.css.
 */
export const AVAILABLE_FONTS: FontOption[] = [
  // UI (sans) fonts
  {
    id: "system-ui",
    name: "System Default",
    family: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    category: "ui",
  },
  {
    id: "inter",
    name: "Inter",
    family: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    category: "ui",
  },
  {
    id: "ibm-plex-sans",
    name: "IBM Plex Sans",
    family: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
    category: "ui",
  },
  {
    id: "manrope",
    name: "Manrope",
    family: "'Manrope', system-ui, -apple-system, sans-serif",
    category: "ui",
  },
  {
    id: "work-sans",
    name: "Work Sans",
    family: "'Work Sans', system-ui, -apple-system, sans-serif",
    category: "ui",
  },
  // Monospace (Nerd Font Mono) fonts — also used for editor and terminal roles
  {
    id: "system-mono",
    name: "System Mono",
    family: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    category: "mono",
  },
  {
    id: "jetbrains-mono",
    name: "JetBrains Mono",
    family: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    category: "mono",
  },
  {
    id: "fira-code",
    name: "Fira Code",
    family: "'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    category: "mono",
  },
  {
    id: "hack",
    name: "Hack",
    family: "'Hack', ui-monospace, Menlo, Consolas, monospace",
    category: "mono",
  },
  {
    id: "caskaydia-cove",
    name: "Caskaydia Cove",
    family: "'Caskaydia Cove', ui-monospace, Menlo, Consolas, monospace",
    category: "mono",
  },
  {
    id: "meslo-lg",
    name: "Meslo LG",
    family: "'Meslo LG', ui-monospace, Menlo, Consolas, monospace",
    category: "mono",
  },
  {
    id: "iosevka",
    name: "Iosevka",
    family: "'Iosevka', ui-monospace, Menlo, Consolas, monospace",
    category: "mono",
  },
  {
    id: "source-code-pro",
    name: "Source Code Pro",
    family: "'Source Code Pro', ui-monospace, Menlo, Consolas, monospace",
    category: "mono",
  },
  {
    id: "ubuntu-mono",
    name: "Ubuntu Mono",
    family: "'Ubuntu Mono', ui-monospace, Menlo, Consolas, monospace",
    category: "mono",
  },
];

export const DEFAULT_FONT_MAPPING: FontMapping = {
  ui: "system-ui",
  mono: "system-mono",
  editor: "system-mono",
  xterm: "system-mono",
};

/** Resolve a catalog id to its CSS font-family, falling back to `fallback`. */
export function fontFamilyById(options: FontOption[], id: string, fallback: string): string {
  return options.find((option) => option.id === id)?.family ?? fallback;
}

/** Resolve a full role mapping to CSS font-family values (unknown ids fall back to defaults). */
export function resolveFontFamilies(
  options: FontOption[],
  mapping: Partial<FontMapping> | undefined,
): Record<FontRole, string> {
  const defaults = resolveFontFamiliesFromCatalog(options, DEFAULT_FONT_MAPPING);
  if (!mapping) return defaults;
  return {
    ui: fontFamilyById(options, mapping.ui ?? DEFAULT_FONT_MAPPING.ui, defaults.ui),
    mono: fontFamilyById(options, mapping.mono ?? DEFAULT_FONT_MAPPING.mono, defaults.mono),
    editor: fontFamilyById(options, mapping.editor ?? DEFAULT_FONT_MAPPING.editor, defaults.editor),
    xterm: fontFamilyById(options, mapping.xterm ?? DEFAULT_FONT_MAPPING.xterm, defaults.xterm),
  };
}

function resolveFontFamiliesFromCatalog(options: FontOption[], mapping: FontMapping): Record<FontRole, string> {
  const byId = new Map(options.map((option) => [option.id, option.family] as const));
  const systemUi = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const systemMono = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  return {
    ui: byId.get(mapping.ui) ?? systemUi,
    mono: byId.get(mapping.mono) ?? systemMono,
    editor: byId.get(mapping.editor) ?? systemMono,
    xterm: byId.get(mapping.xterm) ?? systemMono,
  };
}

/** Catalog entries suitable for a role: sans options for UI, mono options elsewhere. */
export function fontOptionsForRole(options: FontOption[], role: FontRole): FontOption[] {
  const category = role === "ui" ? "ui" : "mono";
  return options.filter((option) => option.category === category);
}

export const toolMatcherSchema = z.object({
  toolName: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64).optional(),
  icon: z.string().min(1).max(32).optional(),
  summaryTemplate: z.string().min(1).max(256).optional(),
  category: z.enum(["file", "git", "command", "agent", "search", "generic"]).default("generic"),
});
export type ToolMatcher = z.infer<typeof toolMatcherSchema>;

export const toolRendererPackSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(64),
  matchers: z.array(toolMatcherSchema).max(50),
});
export type ToolRendererPack = z.infer<typeof toolRendererPackSchema>;

// Built-in theme packs
export const BUILTIN_THEMES: ThemePack[] = [
  {
    id: "passage-light",
    name: "Passage Warm Light (Default)",
    mode: "light",
    tokens: {
      background: "#fdfcfa",
      foreground: "#393a34",
      surface: "#ffffff",
      surfaceSubtle: "#f5f1ea",
      surfaceElevated: "#f5f1ea",
      surfaceHover: "#ebe6dc",
      surfaceSelected: "#e2dcce",
      border: "#e7e2d7",
      borderStrong: "#cfc7ba",
      accent: "#0f766e",
      accentHover: "#115e59",
      accentSubtle: "#ccfbf1",
      muted: "#82877d",
      statusRunning: "#d97706",
      statusIdle: "#6b7280",
      statusError: "#b91c1c",
      statusWarning: "#d97706",
      userCardBg: "#f6f2ea",
      userCardBorder: "#e7e2d7",
      composerBg: "#ffffff",
      composerBorder: "#e7e2d7",
      chipBg: "#ece7de",
      secondary: "#ece7de",
      secondaryForeground: "#393a34",
      chipBlueBg: "#e0f2fe",
      chipBlueFg: "#0369a1",
      chipBlueBorder: "#bfdbfe",
      diffAdd: "#15803d",
      diffAddSubtle: "#ecfdf5",
      diffRemove: "#b91c1c",
      diffRemoveSubtle: "#fef2f2",
      diffHunk: "#0369a1",
      diffHunkSubtle: "#f0f9ff",
      terminalBackground: "#191c1e",
      terminalForeground: "#ecebe8",
      editorBackground: "#ffffff",
    },
  },
  {
    id: "passage-dark",
    name: "Passage Charcoal Dark",
    mode: "dark",
    tokens: {
      background: "#141618",
      foreground: "#ecebe8",
      surface: "#1c1f22",
      surfaceSubtle: "#23272b",
      surfaceElevated: "#282d33",
      surfaceHover: "#2c3136",
      surfaceSelected: "#353b42",
      border: "#2e3339",
      borderStrong: "#444b54",
      accent: "#14b8a6",
      accentHover: "#2dd4bf",
      accentSubtle: "#134e48",
      muted: "#9aa0a6",
      statusRunning: "#f59e0b",
      statusIdle: "#9aa0a6",
      statusError: "#ef4444",
      statusWarning: "#f59e0b",
      userCardBg: "#23272c",
      userCardBorder: "#2e3339",
      composerBg: "#1c1f22",
      composerBorder: "#2e3339",
      chipBg: "#2a2f35",
      secondary: "#282d33",
      secondaryForeground: "#ecebe8",
      chipBlueBg: "#162a3d",
      chipBlueFg: "#38bdf8",
      chipBlueBorder: "rgba(56, 189, 248, 0.3)",
      diffAdd: "#22c55e",
      diffAddSubtle: "#0d2818",
      diffRemove: "#ef4444",
      diffRemoveSubtle: "#2d1215",
      diffHunk: "#38bdf8",
      diffHunkSubtle: "#0c2438",
      terminalBackground: "#141618",
      terminalForeground: "#ecebe8",
      editorBackground: "#1c1f22",
    },
  },
  {
    id: "nord",
    name: "Nord",
    mode: "dark",
    tokens: {
      background: "#2e3440",
      foreground: "#eceff4",
      surface: "#3b4252",
      surfaceSubtle: "#434c5e",
      surfaceElevated: "#434c5e",
      surfaceHover: "#4c566a",
      surfaceSelected: "#4c566a",
      border: "#4c566a",
      borderStrong: "#d8dee9",
      accent: "#88c0d0",
      accentHover: "#81a1c1",
      accentSubtle: "#3b4252",
      muted: "#d8dee9",
      statusRunning: "#a3be8c",
      statusIdle: "#9aa0a6",
      statusError: "#bf616a",
      statusWarning: "#ebcb8b",
      userCardBg: "#3b4252",
      userCardBorder: "#4c566a",
      composerBg: "#3b4252",
      composerBorder: "#4c566a",
      chipBg: "#434c5e",
      secondary: "#434c5e",
      secondaryForeground: "#eceff4",
      chipBlueBg: "#2e3b4d",
      chipBlueFg: "#88c0d0",
      chipBlueBorder: "rgba(136, 192, 208, 0.3)",
      diffAdd: "#a3be8c",
      diffAddSubtle: "#2e3b32",
      diffRemove: "#bf616a",
      diffRemoveSubtle: "#3b2e30",
      diffHunk: "#88c0d0",
      diffHunkSubtle: "#2e3840",
      terminalBackground: "#2e3440",
      terminalForeground: "#eceff4",
      editorBackground: "#2e3440",
    },
  },
  {
    id: "high-contrast-dark",
    name: "High Contrast Dark",
    mode: "dark",
    tokens: {
      background: "#000000",
      foreground: "#ffffff",
      surface: "#121212",
      surfaceSubtle: "#1e1e1e",
      surfaceElevated: "#1e1e1e",
      surfaceHover: "#2a2a2a",
      surfaceSelected: "#333333",
      border: "#404040",
      borderStrong: "#ffffff",
      accent: "#00e5ff",
      accentHover: "#18ffff",
      accentSubtle: "#00363a",
      muted: "#a0a0a0",
      statusRunning: "#00e676",
      statusIdle: "#a0a0a0",
      statusError: "#ff1744",
      statusWarning: "#ffd600",
      userCardBg: "#181818",
      userCardBorder: "#404040",
      composerBg: "#121212",
      composerBorder: "#404040",
      chipBg: "#222222",
      secondary: "#1e1e1e",
      secondaryForeground: "#ffffff",
      chipBlueBg: "#00363a",
      chipBlueFg: "#00e5ff",
      chipBlueBorder: "rgba(0, 229, 255, 0.4)",
      diffAdd: "#00e676",
      diffAddSubtle: "#002914",
      diffRemove: "#ff1744",
      diffRemoveSubtle: "#290008",
      diffHunk: "#00e5ff",
      diffHunkSubtle: "#002024",
      terminalBackground: "#000000",
      terminalForeground: "#ffffff",
      editorBackground: "#000000",
    },
  },
];

// Built-in tool renderer pack
export const BUILTIN_TOOL_RENDERERS: ToolRendererPack = {
  id: "builtin",
  name: "Default Tool Renderers",
  matchers: [
    { toolName: "read", displayName: "Read", icon: "📖", category: "file" },
    { toolName: "edit", displayName: "Edit", icon: "✏️", category: "file" },
    { toolName: "write", displayName: "Write", icon: "📝", category: "file" },
    { toolName: "bash", displayName: "Ran", icon: "⚡", category: "command" },
    { toolName: "glob", displayName: "Search files", icon: "🔍", category: "search" },
    { toolName: "grep", displayName: "Search text", icon: "🔎", category: "search" },
    { toolName: "git", displayName: "Git", icon: "±", category: "git" },
  ],
};
