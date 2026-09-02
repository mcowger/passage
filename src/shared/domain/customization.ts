import { z } from "zod";

const colorRegex = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)$|^hsla?\(\s*[\d.]+\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(?:,\s*[\d.]+\s*)?\)$/;

export const themeColorSchema = z.string().regex(colorRegex, "Must be a valid hex, rgb, or hsl color string");

export const themeTokensSchema = z.object({
  background: themeColorSchema,
  foreground: themeColorSchema,
  surface: themeColorSchema,
  surfaceElevated: themeColorSchema,
  border: themeColorSchema,
  borderStrong: themeColorSchema,
  accent: themeColorSchema,
  accentHover: themeColorSchema,
  muted: themeColorSchema,
  statusRunning: themeColorSchema,
  statusIdle: themeColorSchema,
  statusError: themeColorSchema,
  statusWarning: themeColorSchema,
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

export const fontPackSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(64),
  uiFontFamily: z.string().min(1).max(256),
  monoFontFamily: z.string().min(1).max(256),
  editorFontFamily: z.string().min(1).max(256),
});
export type FontPack = z.infer<typeof fontPackSchema>;

export const toolMatcherSchema = z.object({
  toolName: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64).optional(),
  icon: z.string().min(1).max(32).optional(),
  summaryTemplate: z.string().min(1).max(256).optional(),
  category: z.enum(["file", "git", "command", "agent", "search", "generic"]).default("generic"),
  showInConcise: z.boolean().default(true),
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
    id: "passage-dark",
    name: "Passage Dark (Default)",
    mode: "dark",
    tokens: {
      background: "#0b1120",
      foreground: "#e2e8f0",
      surface: "#0f172a",
      surfaceElevated: "#1e293b",
      border: "#1e293b",
      borderStrong: "#334155",
      accent: "#0891b2",
      accentHover: "#06b6d4",
      muted: "#94a3b8",
      statusRunning: "#10b981",
      statusIdle: "#0891b2",
      statusError: "#ef4444",
      statusWarning: "#f59e0b",
      terminalBackground: "#16232d",
      terminalForeground: "#abb2bf",
      editorBackground: "#0b1120",
    },
  },
  {
    id: "passage-light",
    name: "Passage Light",
    mode: "light",
    tokens: {
      background: "#f8fafc",
      foreground: "#0f172a",
      surface: "#ffffff",
      surfaceElevated: "#f1f5f9",
      border: "#e2e8f0",
      borderStrong: "#cbd5e1",
      accent: "#0284c7",
      accentHover: "#0369a1",
      muted: "#64748b",
      statusRunning: "#16a34a",
      statusIdle: "#0284c7",
      statusError: "#dc2626",
      statusWarning: "#d97706",
      terminalBackground: "#1e293b",
      terminalForeground: "#f8fafc",
      editorBackground: "#ffffff",
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
      surfaceElevated: "#434c5e",
      border: "#4c566a",
      borderStrong: "#d8dee9",
      accent: "#88c0d0",
      accentHover: "#81a1c1",
      muted: "#d8dee9",
      statusRunning: "#a3be8c",
      statusIdle: "#81a1c1",
      statusError: "#bf616a",
      statusWarning: "#ebcb8b",
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
      terminalBackground: "#000000",
      terminalForeground: "#ffffff",
      editorBackground: "#000000",
    },
  },
];

// Built-in font packs
export const BUILTIN_FONTS: FontPack[] = [
  {
    id: "system-default",
    name: "System Default",
    uiFontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    monoFontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    editorFontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  {
    id: "fira-code",
    name: "Fira Code",
    uiFontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    monoFontFamily: "'Fira Code', ui-monospace, monospace",
    editorFontFamily: "'Fira Code', ui-monospace, monospace",
  },
  {
    id: "jetbrains-mono",
    name: "JetBrains Mono",
    uiFontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    monoFontFamily: "'JetBrains Mono', ui-monospace, monospace",
    editorFontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
];

// Built-in tool renderer pack
export const BUILTIN_TOOL_RENDERERS: ToolRendererPack = {
  id: "builtin",
  name: "Default Tool Renderers",
  matchers: [
    { toolName: "read", displayName: "Read", icon: "📖", category: "file", showInConcise: true },
    { toolName: "edit", displayName: "Edit", icon: "✏️", category: "file", showInConcise: true },
    { toolName: "write", displayName: "Write", icon: "📝", category: "file", showInConcise: true },
    { toolName: "bash", displayName: "Ran", icon: "⚡", category: "command", showInConcise: true },
    { toolName: "glob", displayName: "Search files", icon: "🔍", category: "search", showInConcise: true },
    { toolName: "grep", displayName: "Search text", icon: "🔎", category: "search", showInConcise: true },
    { toolName: "git", displayName: "Git", icon: "±", category: "git", showInConcise: true },
  ],
};
