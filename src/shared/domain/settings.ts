import { z } from "zod";
import {
  DEFAULT_FONT_MAPPING,
  fontMappingSchema,
} from "./customization.ts";

export const CURRENT_SETTINGS_SCHEMA_VERSION = 1;

export const expandModeSchema = z.enum(["always", "latest", "none"]);
export type ExpandMode = z.infer<typeof expandModeSchema>;

export const baselineTools = ["read", "write", "edit", "bash", "find", "grep", "ls", "ask"] as const;
export type BaselineTool = (typeof baselineTools)[number];

export const baselineToolExpansionSchema = z.object({
  read: expandModeSchema.default("latest"),
  write: expandModeSchema.default("latest"),
  edit: expandModeSchema.default("latest"),
  bash: expandModeSchema.default("latest"),
  find: expandModeSchema.default("latest"),
  grep: expandModeSchema.default("latest"),
  ls: expandModeSchema.default("latest"),
  ask: expandModeSchema.default("none"),
});
export type BaselineToolExpansion = z.infer<typeof baselineToolExpansionSchema>;

export const timelineExpansionSchema = z.object({
  thinking: expandModeSchema.default("latest"),
  tools: baselineToolExpansionSchema.default({
    read: "latest",
    write: "latest",
    edit: "latest",
    bash: "latest",
    find: "latest",
    grep: "latest",
    ls: "latest",
    ask: "none",
  }),
  otherTools: expandModeSchema.default("latest"),
});
export type TimelineExpansionSettings = z.infer<typeof timelineExpansionSchema>;

export const DEFAULT_TIMELINE_EXPANSION: TimelineExpansionSettings = {
  thinking: "latest",
  tools: {
    read: "latest",
    write: "latest",
    edit: "latest",
    bash: "latest",
    find: "latest",
    grep: "latest",
    ls: "latest",
    ask: "none",
  },
  otherTools: "latest",
};

/** Appearance preferences shared across every workspace: a theme change in
 *  one workspace applies everywhere, so a refresh that lands on another
 *  workspace never appears to lose the user's theme/fonts. */
export const appearanceSettingsSchema = z.object({
  themeId: z.string().min(1).max(64).default("passage-light"),
  /** Per-surface font mapping (ui, mono, editor, xterm), each a font catalog id. */
  fonts: fontMappingSchema.default(DEFAULT_FONT_MAPPING),
});
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  themeId: "passage-light",
  fonts: { ...DEFAULT_FONT_MAPPING },
};

export const workspaceSettingsSchema = appearanceSettingsSchema.extend({
  toolRendererPackId: z.string().min(1).max(64).default("builtin"),
  notificationsEnabled: z.boolean().default(false),
  editorWordWrap: z.boolean().default(true),
  editorTabSize: z.number().int().min(1).max(8).default(2),
  terminalFontSize: z.number().int().min(9).max(32).default(13),
  suggestModel: z.string().trim().max(256).default(""),
  /** Thinking level for suggestion-model runs (agent auto-titles,
   *  worktree metadata). Empty means the pi default. Constrained to the
   *  chosen model's supported levels in the UI; the daemon passes it
   *  through verbatim. */
  suggestThinkingLevel: z.string().trim().max(256).default(""),
  timelineExpansion: timelineExpansionSchema.default(DEFAULT_TIMELINE_EXPANSION),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  themeId: "passage-light",
  fonts: { ...DEFAULT_FONT_MAPPING },
  toolRendererPackId: "builtin",
  notificationsEnabled: false,
  editorWordWrap: true,
  editorTabSize: 2,
  terminalFontSize: 13,
  suggestModel: "",
  suggestThinkingLevel: "",
  timelineExpansion: DEFAULT_TIMELINE_EXPANSION,
};
