import { z } from "zod";

export const CURRENT_SETTINGS_SCHEMA_VERSION = 1;

export const workspaceSettingsSchema = z.object({
  themeId: z.string().min(1).max(64).default("passage-light"),
  fontId: z.string().min(1).max(64).default("system-default"),
  toolRendererPackId: z.string().min(1).max(64).default("builtin"),
  agentActivityDetail: z.enum(["concise", "detailed"]).default("concise"),
  notificationsEnabled: z.boolean().default(false),
  editorWordWrap: z.boolean().default(true),
  editorTabSize: z.number().int().min(1).max(8).default(2),
  terminalFontSize: z.number().int().min(9).max(32).default(13),
  suggestModel: z.string().trim().max(256).default(""),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  themeId: "passage-light",
  fontId: "system-default",
  toolRendererPackId: "builtin",
  agentActivityDetail: "concise",
  notificationsEnabled: false,
  editorWordWrap: true,
  editorTabSize: 2,
  terminalFontSize: 13,
  suggestModel: "",
};
