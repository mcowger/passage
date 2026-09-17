import { z } from "zod";
import { workspaceSchema } from "./workspaces.ts";

/** Workspace actions are executable operations derived from workspace-local
 *  configuration. For now the only supported action is the worktree setup
 *  ("init") script list read from `paseo.json`; everything else in that file
 *  is ignored. Commands always come from the config file — never from a
 *  browser-supplied request body.
 *
 *  Setup commands (e.g. dependency installs) are commonly slow, so runs are
 *  asynchronous: starting an action returns a run snapshot immediately and
 *  the commands execute in the background. Clients refetch the run snapshot
 *  when they observe an `actions-changed` workspace event. Runs are live
 *  daemon memory like PTYs and Pi processes — they do not survive a daemon
 *  restart. */

export const WORKSPACE_SETUP_ACTION_ID = "setup" as const;

export const workspaceActionSchema = z.object({
  id: z.literal(WORKSPACE_SETUP_ACTION_ID),
  label: z.string().min(1).max(256),
  commands: z.array(z.string().min(1).max(4096)).max(50),
  source: z.literal("paseo.json"),
}).strict();
export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;

export const workspaceActionListSchema = z.object({
  actions: z.array(workspaceActionSchema).max(10),
}).strict();
export type WorkspaceActionList = z.infer<typeof workspaceActionListSchema>;

export const workspaceActionRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type WorkspaceActionRunStatus = z.infer<typeof workspaceActionRunStatusSchema>;

export const workspaceActionCommandResultSchema = z.object({
  command: z.string().max(4096),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(20_000),
  stderr: z.string().max(20_000),
  durationMs: z.number().int().nonnegative(),
}).strict();
export type WorkspaceActionCommandResult = z.infer<typeof workspaceActionCommandResultSchema>;

export const workspaceActionRunSchema = z.object({
  id: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  actionId: z.literal(WORKSPACE_SETUP_ACTION_ID),
  status: workspaceActionRunStatusSchema,
  commands: z.array(z.string().max(4096)).max(50),
  results: z.array(workspaceActionCommandResultSchema).max(50),
  /** The command currently executing; null once the run settles. */
  currentCommand: z.string().max(4096).nullable(),
  error: z.string().max(1024).nullable(),
  startedAt: z.string().min(1).max(64),
  finishedAt: z.string().min(1).max(64).nullable(),
}).strict();
export type WorkspaceActionRun = z.infer<typeof workspaceActionRunSchema>;

export const createWorktreeResponseSchema = z.object({
  workspace: workspaceSchema,
  /** The auto-started `setup` run. Null when the new worktree has no
   *  `paseo.json` setup commands. Creation succeeds even when setup later
   *  fails; poll the run for its terminal status. */
  setup: workspaceActionRunSchema.nullable(),
}).strict();
export type CreateWorktreeResponse = z.infer<typeof createWorktreeResponseSchema>;
