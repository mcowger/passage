import type { AgentHistory } from "../../shared/domain/agents.ts";
import type { PiRpcManager } from "./rpc/index.ts";
import { AgentRuntime, MAX_RUNTIME_DIAGNOSTICS } from "./runtime.ts";

/** Bound on the one-time boot sweep for agents left in a live-looking
 *  status by a prior daemon exit. Not a pagination limit -- generous on
 *  purpose so a large install still gets fully normalized on restart. */
const MAX_RESTART_RECONCILE = 10_000;
import { MetadataRepositories, type Agent, type Workspace } from "../metadata/repositories.ts";
import { AgentError, ID } from "./errors.ts";
import { parsePiExtensionUiDialog } from "./ui.ts";
import { errorFields, logger } from "../logging.ts";
import type { AgentSnapshot } from "./service.ts";

export type AgentViewsDeps = {
  repositories: MetadataRepositories;
  runtime: AgentRuntime;
  manager: PiRpcManager;
  listLimit: number;
  requireAgent: (agentId: string) => Agent;
  requireWorkspace: (workspaceId: string) => Workspace;
};

/**
 * Read model and interruption normalization: snapshots, lists, status
 * rollups, and the restart/interruption bookkeeping they share. Takes the
 * repositories, runtime container, and Pi manager plus the service's
 * require* guards; never spawns or mutates runs.
 */
export class AgentViews {
  private readonly repositories: MetadataRepositories;
  private readonly runtime: AgentRuntime;
  private readonly manager: PiRpcManager;
  private readonly listLimit: number;
  private readonly requireAgent: (agentId: string) => Agent;
  private readonly requireWorkspace: (workspaceId: string) => Workspace;

  constructor(deps: AgentViewsDeps) {
    this.repositories = deps.repositories;
    this.runtime = deps.runtime;
    this.manager = deps.manager;
    this.listLimit = deps.listLimit;
    this.requireAgent = deps.requireAgent;
    this.requireWorkspace = deps.requireWorkspace;
  }

  snapshot(agentId: string): AgentSnapshot {
    const agent = this.requireAgent(agentId);
    const process = this.manager.get(agentId);
    // A persisted `running`/`stopping`/`initializing`/`needs-attention`
    // status with no live Pi process and no boot in flight is stale: the
    // in-memory run state (runStartedAt, subscriptions, event chains,
    // pending questions) is gone after a daemon restart, and no further
    // socket event will ever correct it. Whatever the agent was doing was
    // interrupted, not completed and not a Pi/process error, so report
    // (and persist) the dedicated `interrupted` state rather than
    // inventing an idle, still-active, or genuinely-erroring state. The dot
    // color splits by cause (see classifyStaleInterruption): a restart
    // leftover renders neutral grey, a mid-life process loss stays red.
    // While a boot is pending the status is genuinely unknown, so leave it
    // alone.
    let baseStatus = agent.lastKnownStatus;
    if (!process && !this.runtime.pendingStarts.has(agentId) && this.isStaleActiveStatus(baseStatus)) {
      const cause = this.classifyStaleInterruption(agentId);
      this.markInterrupted(agentId, baseStatus, cause);
      baseStatus = "interrupted";
    }
    const diagnostic = this.runtime.diagnostics.get(agentId);
    const pendingUiRequest = baseStatus === "stopping"
      ? undefined
      : (() => {
          const pending = process?.getPendingUiRequest();
          return pending ? parsePiExtensionUiDialog(pending) : undefined;
        })() ?? this.runtime.pendingUiRequests.get(agentId);
    const lastKnownStatus = pendingUiRequest ? "needs-attention" : baseStatus;
    const interruptedByRestart = lastKnownStatus === "interrupted" && this.runtime.restartInterrupted.has(agentId) ? true : undefined;
    if (lastKnownStatus !== "interrupted") this.runtime.restartInterrupted.delete(agentId);
    return {
      ...agent,
      lastKnownStatus,
      ...(interruptedByRestart === undefined ? {} : { interruptedByRestart }),
      live: process !== undefined,
      persisted: agent.piSessionPath !== null,
      ...(pendingUiRequest ? { pendingUiRequest } : {}),
      ...(this.runtime.runStartedAt.has(agentId) ? { runStartedAt: this.runtime.runStartedAt.get(agentId)! } : {}),
      ...(process ? {
        generation: process.generation,
        stderr: [...process.stderr],
        stderrTruncated: process.stderrTruncated,
      } : diagnostic),
    };
  }

  list(workspaceId: string, limit = this.listLimit): AgentSnapshot[] {
    this.requireWorkspace(workspaceId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.listLimit) throw new AgentError("invalid-input", "invalid list limit");
    return this.repositories.agents.listForWorkspace(workspaceId, limit).map((agent) => {
      // Same stale-status correction as snapshot().
      let lastKnownStatus = agent.lastKnownStatus;
      const process = this.manager.get(agent.id);
      if (!process && !this.runtime.pendingStarts.has(agent.id) && this.isStaleActiveStatus(lastKnownStatus)) {
        const cause = this.classifyStaleInterruption(agent.id);
        this.markInterrupted(agent.id, lastKnownStatus, cause);
        lastKnownStatus = "interrupted";
      }
      const interruptedByRestart = lastKnownStatus === "interrupted" && this.runtime.restartInterrupted.has(agent.id) ? true : undefined;
      if (lastKnownStatus !== "interrupted") this.runtime.restartInterrupted.delete(agent.id);
      return {
        ...agent,
        lastKnownStatus,
        ...(interruptedByRestart === undefined ? {} : { interruptedByRestart }),
        live: process !== undefined,
        persisted: agent.piSessionPath !== null,
        ...(this.runtime.runStartedAt.has(agent.id) ? { runStartedAt: this.runtime.runStartedAt.get(agent.id)! } : {}),
      };
    });
  }

  /** True for a persisted status that only makes sense while a run/boot/
   *  question is actually in flight -- i.e. one a daemon restart can leave
   *  behind with nothing left to ever settle it. */
  private isStaleActiveStatus(status: string): boolean {
    return status === "running" || status === "stopping" || status === "initializing" || status === "needs-attention";
  }
  statusByWorkspace(limit = 5000): Record<string, "attention" | "active" | "idle" | "empty"> {
    let rows: Array<{ id: string; workspaceId: string; lastKnownStatus: string }>;
    try {
      rows = this.repositories.agents.listNonArchivedStatus(limit);
    } catch {
      return {};
    }
    const seen: Record<string, { attention: boolean; active: boolean; idle: boolean }> = {};
    for (const row of rows) {
      let status = row.lastKnownStatus;
      // Pending UI request forces attention even when the persisted status lags.
      if (this.runtime.pendingUiRequests.has(row.id)) {
        status = "needs-attention";
      } else {
        const process = this.manager.get(row.id);
        if (process) {
          try {
            if (process.getPendingUiRequest?.()) status = "needs-attention";
          } catch {}
        } else if (!this.runtime.pendingStarts.has(row.id) && this.isStaleActiveStatus(status)) {
          try {
            this.markInterrupted(row.id, status, this.classifyStaleInterruption(row.id));
          } catch {}
          status = "interrupted";
        }
      }
      if (status !== "interrupted") this.runtime.restartInterrupted.delete(row.id);
      const bucket = (seen[row.workspaceId] ??= { attention: false, active: false, idle: false });
      if (status === "needs-attention" || status === "error") bucket.attention = true;
      else if (status === "running" || status === "stopping") bucket.active = true;
      // `initializing` is neutral/grey: nothing is live yet. `interrupted`
      // splits by cause: a daemon restart ended the process (expected, not
      // urgent), so it renders grey like `initializing`; a genuine mid-life
      // interruption keeps the red attention dot.
      else if (status === "initializing") { /* empty -- no bucket flag */ }
      else if (status === "interrupted") {
        if (this.runtime.restartInterrupted.has(row.id)) { /* empty -- no bucket flag */ }
        else bucket.attention = true;
      }
      else bucket.idle = true;
    }
    const out: Record<string, "attention" | "active" | "idle" | "empty"> = {};
    for (const [workspaceId, bucket] of Object.entries(seen)) {
      if (bucket.attention) out[workspaceId] = "attention";
      else if (bucket.active) out[workspaceId] = "active";
      else if (bucket.idle) out[workspaceId] = "idle";
      else out[workspaceId] = "empty";
    }
    return out;
  }

  /** Decides whether a stale active status with no live process is a daemon-
   *  restart leftover (neutral grey) or a genuine mid-life process loss
   *  (red attention). A fresh daemon never owned a process for the agent,
   *  so any stale it finds is restart fallout -- including lazy sweeps that
   *  raced the boot reconciliation. Once this daemon has tracked live work
   *  for the agent (subscription, run, boot, cancellation, compaction, or
   *  an observed process exit), losing the process is unexpected. */
  private classifyStaleInterruption(agentId: string): "restart" | "process-lost" {
    if (this.runtime.restartInterrupted.has(agentId)) return "restart";
    if (this.runtime.diagnostics.get(agentId)?.generation !== undefined) return "process-lost";
    if (
      this.runtime.subscriptions.has(agentId) ||
      this.runtime.runStartedAt.has(agentId) ||
      this.runtime.eventChains.has(agentId) ||
      this.runtime.pendingStarts.has(agentId) ||
      this.runtime.cancellations.has(agentId) ||
      this.runtime.compacting.has(agentId) ||
      this.runtime.pendingUiRequests.has(agentId)
    ) return "process-lost";
    return "restart";
  }

  /** Persists `interrupted` -- distinct from `error`: Pi reported nothing
   *  wrong, Passage simply lost track of in-flight work (no live process,
   *  no boot in flight), most commonly because of a daemon restart. Records
   *  why without touching the Pi transcript: nothing this honest can say Pi
   *  itself produced that row. Never overwrites an already-recorded
   *  diagnostic (e.g. a real crash reported by onLifecycle earlier in this
   *  daemon's life). A `"restart"` cause marks the agent in
   *  `restartInterrupted` (grey dot); `"process-lost"` clears it (red).
   *  The set is bounded like the diagnostics map. */
  private markInterrupted(agentId: string, previousStatus: string, cause: "restart" | "process-lost"): void {
    if (!this.runtime.diagnostics.has(agentId)) {
      this.runtime.diagnostics.set(agentId, { exitStatus: `interrupted (${previousStatus})`, stderr: [], stderrTruncated: false });
      while (this.runtime.diagnostics.size > MAX_RUNTIME_DIAGNOSTICS) this.runtime.diagnostics.delete(this.runtime.diagnostics.keys().next().value!);
    }
    if (cause === "restart") {
      this.runtime.restartInterrupted.add(agentId);
      while (this.runtime.restartInterrupted.size > MAX_RUNTIME_DIAGNOSTICS) this.runtime.restartInterrupted.delete(this.runtime.restartInterrupted.values().next().value!);
    } else {
      this.runtime.restartInterrupted.delete(agentId);
    }
    this.runtime.runStartedAt.delete(agentId);
    try { this.repositories.agents.updateStatus(agentId, "interrupted"); } catch {}
  }

  /** One-time boot sweep, before serving agent commands: every agent still
   *  persisted as running/stopping/initializing/needs-attention belonged to
   *  a Pi process this fresh daemon does not own -- normalize it to
   *  `interrupted` (not `error`: Pi reported nothing wrong) instead of
   *  leaving a stale spinner or an unanswerable pending question. Never
   *  throws. */
  async reconcileAfterRestart(): Promise<{ interrupted: string[] }> {
    const interrupted: string[] = [];
    let agents: Agent[];
    try {
      agents = this.repositories.agents.listActiveRuntime(MAX_RESTART_RECONCILE);
    } catch (error) {
      logger("agent").warn("Restart reconciliation lookup failed", { event: "agent.restart_reconcile_lookup_failed", ...errorFields(error) });
      return { interrupted };
    }
    for (const agent of agents) {
      try {
        this.markInterrupted(agent.id, agent.lastKnownStatus, "restart");
        interrupted.push(agent.id);
      } catch (error) {
        logger("agent").warn("Restart reconciliation failed for agent", { event: "agent.restart_reconcile_failed", agentId: agent.id, ...errorFields(error) });
      }
    }
    if (interrupted.length > 0) {
      logger("agent").warn("Normalized agent runtime state interrupted by daemon restart", { event: "agent.restart_interrupted", count: interrupted.length });
    }
    return { interrupted };
  }
  /** Archived agents for a workspace, newest archival last in `id` order.
   *  Read-only: unlike list(), this stays available even when the workspace
   *  itself is archived, so the overview can always surface what was kept. */
  listArchived(workspaceId: string, limit = this.listLimit): AgentSnapshot[] {
    if (!ID.test(workspaceId)) throw new AgentError("invalid-input", "invalid workspace id");
    if (!this.repositories.workspaces.get(workspaceId)) throw new AgentError("not-found", "workspace not found");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.listLimit) throw new AgentError("invalid-input", "invalid list limit");
    return this.repositories.agents.listForWorkspace(workspaceId, limit, true).map((agent) => ({
      ...agent,
      live: false,
      persisted: agent.piSessionPath !== null,
    }));
  }
}
