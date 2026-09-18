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

/** Default worktree metadata prompt. `{{purpose}}` is replaced with the
 *  user's purpose description before sending to the suggestion model. */
export const DEFAULT_WORKTREE_PROMPT = [
  "Generate workspace metadata for a Git worktree based on this purpose description.",
  'Purpose: "{{purpose}}"',
  "Return ONLY a valid JSON object (no markdown, no backticks, no code fence) with exactly these keys:",
  "- label: concise human-readable title (max 60 chars)",
  "- branch: valid git branch name like 'feature/short-name' or 'fix/short-name' (lowercase, hyphen-separated, no spaces)",
  "- folder: collision-safe directory name like 'short-name--wk_abcd' (lowercase, alphanumeric with hyphens/underscores, ending with a short suffix)",
].join("\n");

/** Default agent auto-title prompt. `{{messages}}` is replaced with the
 *  numbered first user messages before sending to the suggestion model. */
export const DEFAULT_TITLE_PROMPT = [
  "Suggest a short title for an AI agent conversation based on the user's first messages below.",
  "{{messages}}",
  "Return ONLY the title itself: 3-4 words, plain text, no quotes, no markdown, no trailing period.",
].join("\n");

/** Default auto-commit prompt. `{{files}}` is replaced with the changed
 *  file list and `{{diff}}` with the overall unified diff. */
export const DEFAULT_COMMIT_PROMPT = [
  "Write a concise git commit message for the changes below.",
  "Changed files:",
  "{{files}}",
  "Diff:",
  "{{diff}}",
  "Return ONLY the commit message: a short imperative subject line (max 72 chars),",
  "optionally followed by a blank line and a brief body. No quotes, no markdown, no code fence.",
].join("\n");

export const WORKTREE_PROMPT_PLACEHOLDERS = ["{{purpose}}"] as const;
export const TITLE_PROMPT_PLACEHOLDERS = ["{{messages}}"] as const;
export const COMMIT_PROMPT_PLACEHOLDERS = ["{{files}}", "{{diff}}"] as const;

const promptTemplateSchema = z.string().max(8000).default("");

/** Render a worktree prompt template, falling back to the default when the
 *  stored template is blank. When the template omits `{{purpose}}` the
 *  purpose is appended so the model still sees it. */
export function renderWorktreePrompt(template: string, purpose: string): string {
  const base = template.trim() === "" ? DEFAULT_WORKTREE_PROMPT : template;
  const clean = purpose.trim();
  if (base.includes("{{purpose}}")) return base.split("{{purpose}}").join(clean);
  return `${base}\nPurpose: "${clean}"`;
}

/** Render a title prompt template over the first user messages. */
export function renderTitlePrompt(template: string, messages: string[]): string {
  const base = template.trim() === "" ? DEFAULT_TITLE_PROMPT : template;
  const excerpt = messages
    .slice(0, 2)
    .map((message, index) => `Message ${index + 1}: "${message.slice(0, 1000).trim()}"`)
    .join("\n");
  if (base.includes("{{messages}}")) return base.split("{{messages}}").join(excerpt);
  return `${base}\n${excerpt}`;
}

/** Render a commit prompt template over the changed file list + diff. */
export function renderCommitPrompt(template: string, files: string, diff: string): string {
  const base = template.trim() === "" ? DEFAULT_COMMIT_PROMPT : template;
  let out = base.includes("{{files}}") ? base.split("{{files}}").join(files) : `${base}\nChanged files:\n${files}`;
  out = out.includes("{{diff}}") ? out.split("{{diff}}").join(diff) : `${out}\nDiff:\n${diff}`;
  return out;
}

/** Appearance preferences shared across every workspace: a theme change in
 *  one workspace applies everywhere, so a refresh that lands on another
 *  workspace never appears to lose the user's theme/fonts. Prompt templates
 *  are global for the same reason. */
export const appearanceSettingsSchema = z.object({
  themeId: z.string().min(1).max(64).default("passage-light"),
  /** Per-surface font mapping (ui, mono, editor, xterm), each a font catalog id. */
  fonts: fontMappingSchema.default(DEFAULT_FONT_MAPPING),
  /** Prompt templates (global). Blank means the built-in default. */
  worktreePrompt: promptTemplateSchema.default(""),
  titlePrompt: promptTemplateSchema.default(""),
  commitPrompt: promptTemplateSchema.default(""),
});
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  themeId: "passage-light",
  fonts: { ...DEFAULT_FONT_MAPPING },
  worktreePrompt: "",
  titlePrompt: "",
  commitPrompt: "",
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
  worktreePrompt: "",
  titlePrompt: "",
  commitPrompt: "",
  toolRendererPackId: "builtin",
  notificationsEnabled: false,
  editorWordWrap: true,
  editorTabSize: 2,
  terminalFontSize: 13,
  suggestModel: "",
  suggestThinkingLevel: "",
  timelineExpansion: DEFAULT_TIMELINE_EXPANSION,
};
