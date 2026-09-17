import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { workspaceSchema, type Workspace } from "../../shared/domain/workspaces.ts";
import {
  WORKSPACE_SETUP_ACTION_ID,
  type WorkspaceAction,
  type WorkspaceActionCommandResult,
  type WorkspaceActionRun,
  type WorkspaceActionRunStatus,
} from "../../shared/domain/workspace-actions.ts";
import type { MetadataRepositories } from "../metadata/repositories.ts";

export const PASEO_CONFIG_FILE_NAME = "paseo.json";
const MAX_COMMANDS = 50;
/** Finished runs retained in memory; the oldest finished run is evicted past this. */
const MAX_RETAINED_RUNS = 100;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 16_384;

export class WorkspaceActionError extends Error {
  constructor(
    public readonly code: "not-found" | "archived" | "unknown-action" | "action-running",
    message: string,
    public readonly runId?: string,
  ) {
    super(message);
    this.name = "WorkspaceActionError";
  }
}

/** Mirrors paseo's lifecycle normalization: a single string or an array of
 *  strings; blank and non-string entries are dropped. */
export function normalizeLifecycleCommands(commands: unknown): string[] {
  if (typeof commands === "string") {
    return commands.trim().length > 0 ? [commands] : [];
  }
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.filter(
    (command): command is string =>
      typeof command === "string" && command.trim().length > 0,
  );
}

/** Read `worktree.setup` commands from the `paseo.json` inside a workspace
 *  directory. Missing files, invalid JSON, and unexpected shapes all yield
 *  an empty list — everything except the setup list is ignored. */
export function readPaseoSetupCommands(cwd: string): string[] {
  try {
    const json: unknown = JSON.parse(
      readFileSync(join(cwd, PASEO_CONFIG_FILE_NAME), "utf8"),
    );
    if (!json || typeof json !== "object" || !("worktree" in json)) return [];
    const worktree = (json as { worktree?: unknown }).worktree;
    if (!worktree || typeof worktree !== "object" || !("setup" in worktree)) {
      return [];
    }
    return normalizeLifecycleCommands(
      (worktree as { setup?: unknown }).setup,
    ).slice(0, MAX_COMMANDS);
  } catch {
    return [];
  }
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]`;
}

type MutableRun = Omit<WorkspaceActionRun, "commands" | "results"> & {
  commands: string[];
  results: WorkspaceActionCommandResult[];
};

function snapshot(record: MutableRun): WorkspaceActionRun {
  return { ...record, commands: [...record.commands], results: [...record.results] };
}

async function execSetupCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorkspaceActionCommandResult> {
  const startedAt = Date.now();
  if (signal.aborted) {
    return { command, exitCode: null, stdout: "", stderr: "[passage: action run cancelled]", durationMs: 0 };
  }
  // Project-authored command strings run under a stable non-login shell so
  // shell startup files cannot rewrite the environment behind our back.
  // BASH_ENV is stripped for the same reason (mirrors paseo).
  const env = { ...process.env };
  delete env.BASH_ENV;
  const process_ = Bun.spawn(["bash", "-c", command], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process_.kill();
    } catch {}
  }, timeoutMs);
  const onAbort = () => {
    try {
      process_.kill();
    } catch {}
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process_.stdout).text().catch(() => ""),
      new Response(process_.stderr).text().catch(() => ""),
      process_.exited,
    ]);
    const note = timedOut
      ? `\n[passage: command timed out after ${timeoutMs}ms]`
      : signal.aborted
        ? "\n[passage: action run cancelled]"
        : "";
    return {
      command,
      exitCode: timedOut || signal.aborted ? null : exitCode,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(`${stderr}${note}`),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export type WorkspaceActionsEvents = {
  /** Invoked with a fresh snapshot whenever a run starts or settles.
   *  Wired to the workspace event hub; must never throw. */
  onRunChanged?: (run: WorkspaceActionRun) => void;
};

export class WorkspaceActionsService {
  private readonly runs = new Map<string, { record: MutableRun; controller: AbortController }>();

  constructor(
    private readonly repositories: MetadataRepositories,
    private readonly commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    private readonly events: WorkspaceActionsEvents = {},
  ) {}

  list(workspaceId: string): WorkspaceAction[] {
    const workspace = this.requireWorkspace(workspaceId);
    const commands = readPaseoSetupCommands(workspace.cwd);
    if (commands.length === 0) return [];
    return [
      {
        id: WORKSPACE_SETUP_ACTION_ID,
        label: "Worktree setup",
        commands,
        source: "paseo.json",
      },
    ];
  }

  /** Start a workspace action run and return immediately with a `running`
   *  snapshot; commands execute in the background. At most one active run
   *  per workspace — a second start fails with `action-running`. The action
   *  id is the only client-controlled input; the commands themselves always
   *  come from `paseo.json`. */
  async start(workspaceId: string, actionId: string): Promise<WorkspaceActionRun> {
    if (actionId !== WORKSPACE_SETUP_ACTION_ID) {
      throw new WorkspaceActionError(
        "unknown-action",
        `Unknown workspace action "${actionId}". The only supported action is "${WORKSPACE_SETUP_ACTION_ID}".`,
      );
    }
    const workspace = this.requireWorkspace(workspaceId);
    const active = [...this.runs.values()].find(
      (entry) => entry.record.workspaceId === workspace.id && entry.record.status === "running",
    );
    if (active) {
      throw new WorkspaceActionError(
        "action-running",
        `Workspace action "${actionId}" is already running for this workspace.`,
        active.record.id,
      );
    }
    const cwd = await realpath(workspace.cwd).catch(() => {
      throw new WorkspaceActionError("not-found", "Workspace directory not found");
    });
    const commands = readPaseoSetupCommands(cwd);
    const now = new Date().toISOString();
    const record: MutableRun = {
      id: `arun_${crypto.randomUUID()}`,
      workspaceId: workspace.id,
      actionId: WORKSPACE_SETUP_ACTION_ID,
      status: "running",
      commands,
      results: [],
      currentCommand: commands[0] ?? null,
      error: null,
      startedAt: now,
      finishedAt: null,
    };
    const controller = new AbortController();
    this.runs.set(record.id, { record, controller });
    this.evictFinishedRuns();
    this.emit(snapshot(record));
    void this.execute(record, controller.signal, cwd);
    return snapshot(record);
  }

  get(workspaceId: string, runId: string): WorkspaceActionRun {
    const entry = this.runs.get(runId);
    if (!entry || entry.record.workspaceId !== workspaceId) {
      throw new WorkspaceActionError("not-found", "Action run not found");
    }
    return snapshot(entry.record);
  }

  /** Abort every running action in a workspace. Used before workspace
   *  archival/removal so setup runs don't outlive the worktree. Never
   *  throws; returns the cancelled run IDs. */
  cancelForWorkspace(workspaceId: string): string[] {
    const cancelled: string[] = [];
    for (const [id, entry] of this.runs) {
      if (entry.record.workspaceId === workspaceId && entry.record.status === "running") {
        try {
          entry.controller.abort();
          cancelled.push(id);
        } catch {}
      }
    }
    return cancelled;
  }

  /** Signal cancellation and return the current snapshot. The run settles to
   *  `cancelled` shortly after; already-settled runs are returned as-is. */
  cancel(workspaceId: string, runId: string): WorkspaceActionRun {
    const entry = this.runs.get(runId);
    if (!entry || entry.record.workspaceId !== workspaceId) {
      throw new WorkspaceActionError("not-found", "Action run not found");
    }
    if (entry.record.status === "running") entry.controller.abort();
    return snapshot(entry.record);
  }

  private async execute(record: MutableRun, signal: AbortSignal, cwd: string): Promise<void> {
    let status: WorkspaceActionRunStatus = "succeeded";
    let error: string | null = null;
    for (const command of record.commands) {
      record.currentCommand = command;
      const result = await execSetupCommand(command, cwd, this.commandTimeoutMs, signal);
      record.results.push(result);
      if (signal.aborted) {
        status = "cancelled";
        error = "Action run cancelled.";
        break;
      }
      if (result.exitCode !== 0) {
        status = "failed";
        error = `Setup command failed with exit code ${result.exitCode}: ${command}`.slice(0, 1024);
        break;
      }
    }
    record.status = status;
    record.error = error;
    record.currentCommand = null;
    record.finishedAt = new Date().toISOString();
    this.evictFinishedRuns();
    this.emit(snapshot(record));
  }

  private emit(run: WorkspaceActionRun): void {
    try {
      this.events.onRunChanged?.(run);
    } catch {}
  }

  private evictFinishedRuns(): void {
    if (this.runs.size <= MAX_RETAINED_RUNS) return;
    for (const [id, entry] of this.runs) {
      if (this.runs.size <= MAX_RETAINED_RUNS) break;
      if (entry.record.status !== "running") this.runs.delete(id);
    }
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const value = this.repositories.workspaces.get(workspaceId);
    if (!value) throw new WorkspaceActionError("not-found", "Workspace not found");
    const workspace = workspaceSchema.parse(value);
    if (workspace.archivedAt) {
      throw new WorkspaceActionError("archived", "Workspace is archived");
    }
    return workspace;
  }
}
