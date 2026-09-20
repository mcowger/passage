import { realpath } from "node:fs/promises";
import { workspaceSchema, type Workspace } from "../../shared/domain/workspaces.ts";
import type {
  WorkspaceScriptRuntime,
  WorkspaceScriptType,
} from "../../shared/domain/workspace-actions.ts";
import type { MetadataRepositories } from "../metadata/repositories.ts";
import type { TerminalManager } from "../terminals/manager.ts";
import { tmuxGetSessionMeta, tmuxKillSession, tmuxListTerminalIds, type TmuxSessionMeta } from "../terminals/tmux.ts";
import { readPaseoConfig, type PaseoScriptEntry } from "./paseo-config.ts";
import {
  allocateWorkspaceServicePort,
  buildWorkspaceServiceEnv,
  isPortOpen,
  type ServicePeer,
} from "./service-ports.ts";

export class WorkspaceScriptError extends Error {
  constructor(
    public readonly code:
      | "not-found"
      | "archived"
      | "unknown-script"
      | "script-running"
      | "script-stopped"
      | "allocation-failed",
    message: string,
    public readonly terminalId?: string,
  ) {
    super(message);
    this.name = "WorkspaceScriptError";
  }
}

type RuntimeEntry = {
  entry: PaseoScriptEntry;
  lifecycle: "running" | "stopped";
  terminalId: string | null;
  exitCode: number | null;
  port: number | null;
};

export type WorkspaceScriptsEvents = {
  /** Invoked with a fresh snapshot whenever a script starts, stops, or
   *  settles. Wired to the workspace event hub; must never throw. */
  onScriptsChanged?: (workspaceId: string, runtime: WorkspaceScriptRuntime) => void;
};

function toSnapshot(workspaceId: string, runtime: RuntimeEntry): WorkspaceScriptRuntime {
  void workspaceId;
  return {
    name: runtime.entry.name,
    type: runtime.entry.type,
    lifecycle: runtime.lifecycle,
    terminalId: runtime.terminalId,
    exitCode: runtime.exitCode,
    port: runtime.port,
    url: runtime.port !== null ? `http://127.0.0.1:${runtime.port}` : null,
    // Display-only; probes run in list()/get(). Mutation snapshots report
    // unknown until the next read probes the port.
    health: null,
  };
}

const PORT_HEALTH_TIMEOUT_MS = 300;

/** Probe one snapshot's port for display health. Null when there is nothing
 *  to probe (stopped or portless); never throws. */
async function probeHealth(snapshot: WorkspaceScriptRuntime): Promise<WorkspaceScriptRuntime> {
  if (snapshot.lifecycle !== "running" || snapshot.port === null) return snapshot;
  try {
    const open = await isPortOpen(snapshot.port, PORT_HEALTH_TIMEOUT_MS);
    return { ...snapshot, health: open ? "healthy" : "unhealthy" };
  } catch {
    return { ...snapshot, health: "unhealthy" };
  }
}

/** Supervises `paseo.json` `scripts` for a workspace. Every start owns one
 *  daemon PTY (via `TerminalManager.createCommand`); stopping kills that
 *  PTY. Services receive an allocated port plus `PASEO_PORT` /
 *  `PASEO_SERVICE_*` / `HOST` env; one-shots run the same way but with no
 *  port. At most one live instance per script; crashes stay stopped with
 *  their exit code (manual restart only).
 *
 *  Service runtimes persist in sqlite and survive daemon restarts: the tmux
 *  session keeps the process alive and `recoverAfterRestart` (run after the
 *  terminal sweep) re-links the runtime record to the reattached PTY.
 *  One-shot script sessions stay anonymous and are reaped on restart. */
export class WorkspaceScriptsService {
  private readonly runtimes = new Map<string, Map<string, RuntimeEntry>>();
  /** Stable per-workspace port plan: allocated once, retained across
   *  restarts so peer env stays valid. Explicit `port` entries are
   *  pre-seeded and always win. */
  private readonly portPlans = new Map<string, Map<string, number>>();
  private readonly terminalIndex = new Map<string, { workspaceId: string; scriptName: string }>();

  constructor(
    private readonly repositories: MetadataRepositories,
    private readonly terminals: TerminalManager,
    private readonly events: WorkspaceScriptsEvents = {},
  ) {
    this.terminals.onExit((terminalId, exitCode) => this.handleTerminalExit(terminalId, exitCode));
  }

  /** Live list with display health: running services are probed in parallel
   *  (bounded timeout each). Stopped and portless entries report null. */
  async list(workspaceId: string): Promise<WorkspaceScriptRuntime[]> {
    return Promise.all(this.snapshots(workspaceId).map(probeHealth));
  }

  async get(workspaceId: string, scriptName: string): Promise<WorkspaceScriptRuntime> {
    const found = this.snapshots(workspaceId).find((script) => script.name === scriptName);
    if (!found) {
      throw new WorkspaceScriptError("unknown-script", `Unknown workspace script "${scriptName}".`);
    }
    return probeHealth(found);
  }

  /** Explicit manifest ports for `service` scripts, regardless of runtime
   *  state. Used for preview defaults for services that have never been
   *  started (no planned port exists yet). Never throws beyond
   *  not-found/archived workspace errors. */
  declaredServicePorts(workspaceId: string): { name: string; port: number }[] {
    const workspace = this.requireWorkspace(workspaceId);
    return readPaseoConfig(workspace.cwd).scripts
      .filter((script) => script.type === "service" && script.port !== null)
      .map((script) => ({ name: script.name, port: script.port as number }));
  }

  private snapshots(workspaceId: string): WorkspaceScriptRuntime[] {
    const workspace = this.requireWorkspace(workspaceId);
    const config = this.configFor(workspace);
    const runtimes = this.runtimes.get(workspace.id);
    return config.scripts.map((entry) => {
      const runtime = runtimes?.get(entry.name);
      if (runtime) return toSnapshot(workspace.id, { ...runtime, entry });
      return {
        name: entry.name,
        type: entry.type,
        lifecycle: "stopped" as const,
        terminalId: null,
        exitCode: null,
        port: null,
        url: null,
        health: null,
      };
    });
  }

  async start(workspaceId: string, scriptName: string): Promise<WorkspaceScriptRuntime> {
    const workspace = this.requireWorkspace(workspaceId);
    const config = this.configFor(workspace);
    const entry = config.scripts.find((script) => script.name === scriptName);
    if (!entry) {
      throw new WorkspaceScriptError("unknown-script", `Unknown workspace script "${scriptName}".`);
    }
    let runtimes = this.runtimes.get(workspace.id);
    if (!runtimes) {
      runtimes = new Map();
      this.runtimes.set(workspace.id, runtimes);
    }
    const existing = runtimes.get(entry.name);
    if (existing?.lifecycle === "running") {
      throw new WorkspaceScriptError(
        "script-running",
        `Workspace script "${scriptName}" is already running.`,
        existing.terminalId ?? undefined,
      );
    }
    const cwd = await realpath(workspace.cwd).catch(() => {
      throw new WorkspaceScriptError("not-found", "Workspace directory not found");
    });

    let port: number | null = null;
    let peers: ServicePeer[] = [];
    if (entry.type === "service") {
      port = await this.portFor(workspace, config, entry, cwd);
      peers = this.peersFor(workspace.id, config, entry.name, port);
    }

    const env: Record<string, string> | undefined =
      entry.type === "service" ? buildWorkspaceServiceEnv({ scriptName: entry.name, peers }) : undefined;
    let summary;
    try {
      summary = await this.terminals.createCommand(workspace.id, {
        title: entry.name,
        command: entry.command,
        ...(env ? { env } : {}),
        ...(entry.type === "service" ? { persistent: true, scriptName: entry.name } : {}),
      });
    } catch (error) {
      throw new WorkspaceScriptError(
        "not-found",
        error instanceof Error ? error.message : "Could not start workspace script",
      );
    }
    const runtime: RuntimeEntry = {
      entry,
      lifecycle: "running",
      terminalId: summary.id,
      exitCode: null,
      port,
    };
    runtimes.set(entry.name, runtime);
    this.terminalIndex.set(summary.id, { workspaceId: workspace.id, scriptName: entry.name });
    if (entry.type === "service") {
      // Persist before emitting: a crash after this point must recover the
      // runtime; a persist failure terminates the orphaned PTY instead.
      try {
        this.repositories.scriptRuntimes.save({
          workspaceId: workspace.id,
          scriptName: entry.name,
          terminalId: summary.id,
          port,
          startedAt: new Date().toISOString(),
        });
      } catch (error) {
        runtimes.delete(entry.name);
        this.terminalIndex.delete(summary.id);
        try {
          this.terminals.terminate(summary.id);
        } catch {}
        throw new WorkspaceScriptError(
          "allocation-failed",
          error instanceof Error ? error.message : "Could not persist script runtime",
        );
      }
    }
    const snapshot = toSnapshot(workspace.id, runtime);
    this.emit(snapshot, workspace.id);
    return snapshot;
  }

  /** Stop a running script by terminating its PTY. Already-stopped scripts
   *  are returned as-is (idempotent). */
  async stop(workspaceId: string, scriptName: string): Promise<WorkspaceScriptRuntime> {
    const workspace = this.requireWorkspace(workspaceId);
    const config = this.configFor(workspace);
    const entry = config.scripts.find((script) => script.name === scriptName);
    if (!entry) {
      throw new WorkspaceScriptError("unknown-script", `Unknown workspace script "${scriptName}".`);
    }
    const runtimes = this.runtimes.get(workspace.id);
    const runtime = runtimes?.get(entry.name);
    if (!runtime || runtime.lifecycle !== "running") {
      return runtime ? toSnapshot(workspace.id, runtime) : await this.get(workspaceId, scriptName);
    }
    if (runtime.terminalId) {
      this.terminalIndex.delete(runtime.terminalId);
      try {
        this.terminals.terminate(runtime.terminalId);
      } catch {}
    }
    try {
      this.repositories.scriptRuntimes.delete(workspace.id, entry.name);
    } catch {}
    runtime.lifecycle = "stopped";
    runtime.terminalId = null;
    const snapshot = toSnapshot(workspace.id, runtime);
    this.emit(snapshot, workspace.id);
    return snapshot;
  }

  /** Boot-time recovery, run after the terminal sweep: re-link persisted
   *  service runtimes to their reattached PTYs. Rows whose workspace is
   *  gone/archived, whose script vanished from `paseo.json` or changed away
   *  from `service`, or whose terminal did not survive are dropped -- and
   *  the orphaned process is terminated, never left running unmanaged.
   *  A final sweep terminates script-identified sessions with no row
   *  (starts that crashed between session creation and the sqlite save).
   *  Ports re-seed the stable plan so peer env and future allocations stay
   *  consistent. */
  async recoverAfterRestart(): Promise<{ reattached: string[]; dropped: string[] }> {
    const reattached: string[] = [];
    const dropped: string[] = [];
    const linked = new Set<string>();
    let rows: Array<{ workspaceId: string; scriptName: string; terminalId: string; port: number | null }>;
    try {
      rows = this.repositories.scriptRuntimes.listAll();
    } catch {
      return { reattached, dropped };
    }
    for (const row of rows) {
      const label = `${row.workspaceId}:${row.scriptName}`;
      const drop = (terminateFirst: boolean) => {
        if (terminateFirst) {
          try {
            if (this.terminals.get(row.terminalId)) this.terminals.terminate(row.terminalId);
            else tmuxKillSession(row.terminalId);
          } catch {}
        }
        try {
          this.repositories.scriptRuntimes.delete(row.workspaceId, row.scriptName);
        } catch {}
        dropped.push(label);
      };
      let workspace: Workspace;
      try {
        workspace = this.requireWorkspace(row.workspaceId);
      } catch {
        // Terminal sweep already reaped sessions for unknown workspaces.
        drop(false);
        continue;
      }
      let entry: PaseoScriptEntry | undefined;
      try {
        entry = this.configFor(workspace).scripts.find((script) => script.name === row.scriptName);
      } catch {
        entry = undefined;
      }
      if (!entry || entry.type !== "service") {
        drop(true);
        continue;
      }
      const terminal = this.terminals.get(row.terminalId);
      if (!terminal || terminal.status !== "running") {
        drop(false);
        continue;
      }
      let runtimes = this.runtimes.get(workspace.id);
      if (!runtimes) {
        runtimes = new Map();
        this.runtimes.set(workspace.id, runtimes);
      }
      runtimes.set(entry.name, { entry, lifecycle: "running", terminalId: row.terminalId, exitCode: null, port: row.port });
      this.terminalIndex.set(row.terminalId, { workspaceId: workspace.id, scriptName: entry.name });
      if (row.port !== null) {
        let plan = this.portPlans.get(workspace.id);
        if (!plan) {
          plan = new Map();
          this.portPlans.set(workspace.id, plan);
        }
        plan.set(entry.name, row.port);
      }
      linked.add(label);
      reattached.push(label);
      const runtime = runtimes.get(entry.name);
      if (runtime) this.emit(toSnapshot(workspace.id, runtime), workspace.id);
    }
    // Orphaned starts: tmux sessions carrying script identity with no
    // persisted row (crash between session creation and sqlite save).
    try {
      for (const id of tmuxListTerminalIds()) {
        let meta: TmuxSessionMeta | null = null;
        try {
          meta = tmuxGetSessionMeta(id);
        } catch {
          continue;
        }
        if (!meta?.script) continue;
        if (!linked.has(`${meta.workspace}:${meta.script}`)) {
          try {
            if (this.terminals.get(id)) this.terminals.terminate(id);
            else tmuxKillSession(id);
          } catch {}
        }
      }
    } catch {}
    return { reattached, dropped };
  }

  /** Restart: stop the live PTY (if any), then start again. The planned
   *  port is retained so peer env stays stable. */
  async restart(workspaceId: string, scriptName: string): Promise<WorkspaceScriptRuntime> {
    await this.stop(workspaceId, scriptName);
    return this.start(workspaceId, scriptName);
  }

  /** Stop every running script in a workspace. Used before workspace
   *  archival/removal and teardown runs so no service PTY outlives the
   *  worktree. Never throws; returns the stopped script names. */
  stopForWorkspace(workspaceId: string): string[] {
    const stopped: string[] = [];
    const runtimes = this.runtimes.get(workspaceId);
    if (!runtimes) return stopped;
    for (const [name, runtime] of runtimes) {
      if (runtime.lifecycle !== "running") continue;
      if (runtime.terminalId) {
        this.terminalIndex.delete(runtime.terminalId);
        try {
          this.terminals.terminate(runtime.terminalId);
        } catch {}
      }
      try {
        this.repositories.scriptRuntimes.delete(workspaceId, name);
      } catch {}
      runtime.lifecycle = "stopped";
      runtime.terminalId = null;
      stopped.push(name);
      this.emit(toSnapshot(workspaceId, runtime), workspaceId);
    }
    return stopped;
  }

  private handleTerminalExit(terminalId: string, exitCode: number | null): void {
    const location = this.terminalIndex.get(terminalId);
    if (!location) return;
    this.terminalIndex.delete(terminalId);
    const runtimes = this.runtimes.get(location.workspaceId);
    const runtime = runtimes?.get(location.scriptName);
    // A manual stop() already cleared this terminal and emitted; only settle
    // runtimes that still reference the exited PTY (natural exit / crash).
    if (!runtime || runtime.lifecycle !== "running" || runtime.terminalId !== terminalId) return;
    runtime.lifecycle = "stopped";
    runtime.terminalId = null;
    runtime.exitCode = exitCode;
    try {
      this.repositories.scriptRuntimes.delete(location.workspaceId, location.scriptName);
    } catch {}
    this.emit(toSnapshot(location.workspaceId, runtime), location.workspaceId);
  }

  private async portFor(
    workspace: Workspace,
    config: ReturnType<typeof readPaseoConfig>,
    entry: PaseoScriptEntry,
    cwd: string,
  ): Promise<number> {
    if (entry.port !== null) return entry.port;
    let plan = this.portPlans.get(workspace.id);
    if (!plan) {
      plan = new Map();
      this.portPlans.set(workspace.id, plan);
    }
    const planned = plan.get(entry.name);
    if (planned !== undefined) return planned;
    // Seed explicit ports so range allocation skips them.
    const reserved = new Set<number>();
    for (const script of config.scripts) {
      if (script.port !== null) reserved.add(script.port);
    }
    for (const port of plan.values()) reserved.add(port);
    let port: number;
    try {
      port = await allocateWorkspaceServicePort({
        allocation: config.servicePorts,
        cwd,
        scriptName: entry.name,
        workspaceId: workspace.id,
        branchName: workspace.branchRef ?? null,
        reservedPorts: reserved,
      });
    } catch (error) {
      throw new WorkspaceScriptError(
        "allocation-failed",
        error instanceof Error ? error.message : "Could not allocate a service port",
      );
    }
    plan.set(entry.name, port);
    return port;
  }

  private peersFor(
    workspaceId: string,
    config: ReturnType<typeof readPaseoConfig>,
    selfName: string,
    selfPort: number,
  ): ServicePeer[] {
    const plan = this.portPlans.get(workspaceId);
    const peers: ServicePeer[] = [{ scriptName: selfName, port: selfPort }];
    for (const script of config.scripts) {
      if (script.type !== "service" || script.name === selfName) continue;
      if (script.port !== null) {
        peers.push({ scriptName: script.name, port: script.port });
        continue;
      }
      const planned = plan?.get(script.name);
      if (planned !== undefined) peers.push({ scriptName: script.name, port: planned });
    }
    return peers;
  }

  private configFor(workspace: Workspace) {
    return readPaseoConfig(workspace.cwd);
  }

  private emit(runtime: WorkspaceScriptRuntime, workspaceId: string): void {
    try {
      this.events.onScriptsChanged?.(workspaceId, runtime);
    } catch {}
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const value = this.repositories.workspaces.get(workspaceId);
    if (!value) throw new WorkspaceScriptError("not-found", "Workspace not found");
    const workspace = workspaceSchema.parse(value);
    if (workspace.archivedAt) {
      throw new WorkspaceScriptError("archived", "Workspace is archived");
    }
    return workspace;
  }
}

export type { WorkspaceScriptType };
