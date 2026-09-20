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

export const workspaceScriptTypeSchema = z.enum(["script", "service"]);
export type WorkspaceScriptType = z.infer<typeof workspaceScriptTypeSchema>;

/** A single `scripts` entry from `paseo.json`: the declared manifest for one
 *  runnable. `type` defaults to `"script"` (run once, report an exit
 *  code); `"service"` means supervised long-running with an allocated
 *  port and peer env. `port` is an explicit override that always wins over
 *  range/portScript allocation. */
export const workspaceScriptSchema = z.object({
  name: z.string().min(1).max(128),
  type: workspaceScriptTypeSchema,
  command: z.string().min(1).max(8192),
  port: z.number().int().min(1).max(65535).nullable(),
}).strict();
export type WorkspaceScript = z.infer<typeof workspaceScriptSchema>;

export const workspaceScriptLifecycleSchema = z.enum(["running", "stopped"]);
export type WorkspaceScriptLifecycle = z.infer<typeof workspaceScriptLifecycleSchema>;

/** Live runtime snapshot for one script. `port`/`url` are set for running
 *  services only (`url` is the direct `http://127.0.0.1:<port>` form until
 *  a reverse proxy exists). `terminalId` points at the backing PTY while
 *  running; `exitCode` is the last observed exit for stopped one-shots.
 *  `health` is a display-only loopback port probe (`healthy` = accepting,
 *  `unhealthy` = not) for running services — null when there is nothing
 *  to probe (stopped or portless). It drives no supervision: crashes stay
 *  stopped regardless, and a listening port implies nothing about
 *  correctness. */
export const workspaceScriptRuntimeSchema = z.object({
  name: z.string().min(1).max(128),
  type: workspaceScriptTypeSchema,
  lifecycle: workspaceScriptLifecycleSchema,
  terminalId: z.string().min(1).max(128).nullable(),
  exitCode: z.number().int().nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  url: z.string().max(512).nullable(),
  health: z.enum(["healthy", "unhealthy"]).nullable(),
}).strict();
export type WorkspaceScriptRuntime = z.infer<typeof workspaceScriptRuntimeSchema>;

export const workspaceScriptListSchema = z.object({
  scripts: z.array(workspaceScriptRuntimeSchema).max(50),
}).strict();
export type WorkspaceScriptList = z.infer<typeof workspaceScriptListSchema>;

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
