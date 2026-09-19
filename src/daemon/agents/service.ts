import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentCapabilitiesSchema, type AgentHistory, type AgentStatus, type TimelineItem, type UserFileRef, type UserImageRef } from "../../shared/domain/agents.ts";
import { AttachmentCache, safeAttachmentContentType, withFileRefs } from "./attachments.ts";
import { getSlashCommands, piCommandsToSlashCommands } from "./slash-commands.ts";
import { agentFileSchema, agentImageSchema, type AgentFile, type AgentImage } from "../../shared/protocol/agents.ts";
import type { DaemonBlocker } from "../../shared/protocol/daemon.ts";
import { pageHistory, readPiHistory, type HistoryPage } from "./history/index.ts";
import { TranscriptState, truncateRowForWire } from "./transcript/index.ts";
import {
  PiRpcManager,
  responseData,
  type PiEvent,
  type PiExtensionUiResponse,
  type PiLifecycleEvent,
  type PiProcessHandle,
  type PiRpcOptions,
} from "./rpc/index.ts";
import { MetadataRepositories, type Agent } from "../metadata/repositories.ts";
import { AgentTitleSuggester, DEFAULT_AGENT_TITLE } from "./title-suggester.ts";
import { normalizeAvailableModels } from "../models/catalog.ts";
import { parsePiExtensionUiDialog } from "./ui.ts";
import { errorFields, logger } from "../logging.ts";
import {
  collectTitleSources,
  compactRefusalReason,
  isGitCommitToolEvent,
} from "./serviceHelpers.ts";
// Re-exported for existing importers (tests); new code should import from
// ./serviceHelpers.ts directly.
export { collectTitleSources, isGitCommitToolEvent } from "./serviceHelpers.ts";

const MAX_LIST = 100;
const MAX_LISTENERS = 64;
const MAX_TRANSCRIPTS = 256;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SHORT_VALUE_LENGTH = 256;
const MAX_RUNTIME_DIAGNOSTICS = 100;
/** Bound on the one-time boot sweep for agents left in a live-looking
 *  status by a prior daemon exit. Not a pagination limit -- generous on
 *  purpose so a large install still gets fully normalized on restart. */
const MAX_RESTART_RECONCILE = 10_000;
const DEFAULT_ABORT_TIMEOUT_MS = 30_000;
/** Bound on a drain readiness probe (listBlockers()): short enough that a
 *  hung agent shows up as an "unknown" blocker quickly rather than
 *  stalling every readiness recompute behind it. */
const BLOCKER_PROBE_TIMEOUT_MS = 5_000;
/** Summarizing a large session is a single LLM call that can run for
 *  minutes; the default 10s RPC admission timeout would false-fail it. */
const COMPACT_TIMEOUT_MS = 300_000;
/** Matches Pi's "session too small" compact refusal. */
/** Matches Pi's documented rejection of a bare `prompt` sent while it is
 *  already streaming (see rpc.md "During streaming"): benign and
 *  recoverable via steer/follow-up, not a crash. A race between the client
 *  believing the agent is idle (e.g. a stale WebSocket) and Pi actually
 *  still running can reach this even past Passage's own busy guard. */
const PI_ALREADY_STREAMING_PATTERN = /already (processing|streaming)/i;
/** Upper bound on the tool payload text scanned for a `git commit` invocation. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();

/** Title sources: the first user message plus any thinking/assistant text
 *  from the first agent response (rows after the first user message but
 *  before the second user message). Returns [] when no usable first user
 *  message exists yet. A text-less first response yields just [user]. */

type RuntimeSubscription = {
  generation: number;
  unsubscribeEvents: () => boolean;
  unsubscribeLifecycle: () => boolean;
};

type RuntimeDiagnostic = {
  // Absent for `interrupted` (no real Pi process/generation ever existed for
  // this record) -- present and positive for an actual observed process
  // exit. Never a placeholder 0: the public AgentSummary schema requires
  // `generation` to be a positive integer when present.
  generation?: number;
  exitStatus: string;
  stderr: string[];
  stderrTruncated: boolean;
};

type Cancellation = {
  process: PiProcessHandle;
  generation: number;
};

export type AgentCapabilities = ReturnType<typeof agentCapabilitiesSchema.parse>;

export type AgentSnapshot = Agent & {
  live: boolean;
  persisted: boolean;
  generation?: number;
  stderr?: string[];
  stderrTruncated?: boolean;
  exitStatus?: string;
  pendingUiRequest?: Record<string, unknown>;
  /** Epoch ms when Passage observed the current run start; absent when no run is active. */
  runStartedAt?: number;
};

export type AgentServiceEvent = {
  agentId: string;
  type: "status" | "settled" | "attention" | string;
  status: AgentStatus;
  generation?: number;
  error?: string;
  payload?: Record<string, unknown>;
};

export type CompactResult =
  | { compacted: true; tokensBefore?: number }
  | { compacted: false; reason: "session-too-short" | "already-compacted" };

/** Maps Pi's benign compact refusals to stable reasons. Anything else
 *  (genuine failures, aborts of the compaction itself) stays an error. */

export type AgentHistoryResult = HistoryPage | { unpersisted: true; history: null };

export class AgentError extends Error {
  constructor(readonly code: "not-found" | "archived" | "not-running" | "invalid-input" | "limit" | "draining", message: string) {
    super(message);
    this.name = "AgentError";
  }
}

/** True when a tool event looks like a successfully completed `git commit`
 *  invocation. Only completion events count: at call time the commit has not
 *  happened yet, so invalidating then would refetch unchanged status. Failed
 *  calls mutated nothing. The check is tool-agnostic (Pi tool names and arg
 *  shapes are version-sensitive); a false positive only costs one quiet
 *  client refetch. */

export class AgentService {
  private readonly listeners = new Set<(event: AgentServiceEvent) => void>();
  private readonly subscriptions = new Map<string, RuntimeSubscription>();
  private readonly previousRevisions = new Map<string, AgentHistory["revision"]>();
  private readonly leaves = new Map<string, string>();
  private readonly transcripts = new Map<string, TranscriptState>();
  private readonly transcriptSeeds = new Map<string, Promise<TranscriptState>>();
  private readonly transcriptEpochs = new Map<string, number>();
  private epochCounter = Date.now();
  private readonly diagnostics = new Map<string, RuntimeDiagnostic>();
  private readonly pendingUiRequests = new Map<string, Record<string, unknown>>();
  private readonly cancellations = new Map<string, Cancellation>();
  private readonly runStartedAt = new Map<string, number>();
  /** Agents with a compact RPC currently in flight. While set, reconcile
   *  must not promote the killed run's abort tombstone to an error
   *  status/row: the tombstone is expected, and the compaction entry
   *  landing right after it supersedes it. */
  private readonly compacting = new Set<string>();
  private readonly eventChains = new Map<string, Promise<void>>();
  /** Background boot kicked off by create(): lets the POST return (and the
   *  New Agent pane open) without waiting for Pi spawn + reconcile, while
   *  giving later per-agent operations something to wait on so they keep
   *  the old start-then-operate ordering. Never rejects. */
  private readonly pendingStarts = new Map<string, Promise<void>>();
  private readonly manager: PiRpcManager;
  private readonly listLimit: number;
  private readonly pi: Omit<PiRpcOptions, "cwd" | "sessionDir" | "sessionId">;
  private readonly sessionsRoot: string;
  private readonly attachmentCache: AttachmentCache;
  private readonly abortTimeoutMs: number;
  private readonly onWorkspaceGitChanged?: (workspaceId: string) => void;
  /** Daemon lifecycle admission gate. Defaults to always-open so tests/tools that never wire a
   *  `DaemonLifecycle` see no behavior change. */
  private readonly admissionGate: () => boolean;
  /** Agents with an auto-title suggestion currently in flight. Guards the
   *  fire-and-forget `maybeAutoTitle` so rapid consecutive user messages
   *  cannot spawn duplicate suggestion runs for the same agent. */
  private readonly titleSuggestions = new Set<string>();
  private readonly titleSuggester: Pick<AgentTitleSuggester, "suggestTitle">;
  /** Resolves the workspace's configured suggestion model + thinking level
   *  + prompt templates (Settings). Empty/undefined fields mean the
   *  suggestion backend's defaults. */
  private readonly getSuggestConfig?: (workspaceId: string) => { model?: string; thinkingLevel?: string; titlePrompt?: string } | undefined;

  constructor(
    private readonly repositories: MetadataRepositories,
    options: {
      sessionsRoot: string;
      manager?: PiRpcManager;
      listLimit?: number;
      abortTimeoutMs?: number;
      /** Cap on concurrently live `pi --mode rpc` processes (default 32; see
       *  `PiRpcManager`). Ignored when `manager` is supplied directly. */
      maxActiveAgents?: number;
      attachmentCacheRoot?: string;
      attachmentCacheBytes?: number;
      pi?: Omit<PiRpcOptions, "cwd" | "sessionDir" | "sessionId">;
      /** Called (never-throw) when an agent run likely mutated its workspace's
       *  Git state, so the daemon can invalidate subscribed Git views. */
      onWorkspaceGitChanged?: (workspaceId: string) => void;
      /** True while the daemon accepts new agent work (`DaemonLifecycle
       *  .isAdmissionOpen`). Checked synchronously at every new-work entry
       *  point and before any lazy Pi spawn; already-admitted work is never
       *  affected by a later `false`. */
      admissionGate?: () => boolean;
      /** Override for the auto-title suggestion backend (tests). */
      titleSuggester?: Pick<AgentTitleSuggester, "suggestTitle">;
      /** Resolves the workspace's configured suggestion model + thinking
       *  level + prompt templates (Settings). Empty/undefined fields mean
       *  the suggestion backend's defaults. */
      getSuggestConfig?: (workspaceId: string) => { model?: string; thinkingLevel?: string; titlePrompt?: string } | undefined;
    },
  ) {
    if (!options.sessionsRoot) throw new AgentError("invalid-input", "sessionsRoot is required");
    if (options.listLimit !== undefined && (!Number.isSafeInteger(options.listLimit) || options.listLimit < 1 || options.listLimit > MAX_LIST)) {
      throw new AgentError("invalid-input", "invalid list limit");
    }
    if (options.abortTimeoutMs !== undefined && (!Number.isSafeInteger(options.abortTimeoutMs) || options.abortTimeoutMs < 1)) {
      throw new AgentError("invalid-input", "invalid abort timeout");
    }
    if (options.maxActiveAgents !== undefined && (!Number.isSafeInteger(options.maxActiveAgents) || options.maxActiveAgents < 1)) {
      throw new AgentError("invalid-input", "invalid max active agents");
    }
    this.sessionsRoot = resolve(options.sessionsRoot);
    this.manager = options.manager ?? new PiRpcManager(options.maxActiveAgents, { piDefaults: options.pi });
    this.listLimit = options.listLimit ?? MAX_LIST;
    this.pi = options.pi ?? {};
    this.attachmentCache = new AttachmentCache(
      options.attachmentCacheRoot ?? join(resolve(options.sessionsRoot), "..", "attachment-cache"),
      options.attachmentCacheBytes,
    );
    this.abortTimeoutMs = options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS;
    this.onWorkspaceGitChanged = options.onWorkspaceGitChanged;
    this.admissionGate = options.admissionGate ?? (() => true);
    this.titleSuggester = options.titleSuggester ?? new AgentTitleSuggester();
    this.getSuggestConfig = options.getSuggestConfig;
  }

  /** Refuses new agent work while the daemon is draining/ready/stopping.
   *  Called synchronously at the top of every new-work entry point, before
   *  any validation or async work, so admission closes exactly at the
   *  boundary `DaemonLifecycle.beginDrain()` set. */
  private assertAdmissionOpen(): void {
    if (!this.admissionGate()) throw new AgentError("draining", "Passage is draining; new agent work is not accepted");
  }

  subscribe(listener: (event: AgentServiceEvent) => void): () => boolean {
    if (this.listeners.size >= MAX_LISTENERS) throw new AgentError("limit", "maximum agent listeners reached");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    // (and persist) the dedicated `interrupted` attention state rather than
    // inventing an idle, still-active, or genuinely-erroring state. While a
    // boot is pending the status is genuinely unknown, so leave it alone.
    let baseStatus = agent.lastKnownStatus;
    if (!process && !this.pendingStarts.has(agentId) && this.isStaleActiveStatus(baseStatus)) {
      this.markInterrupted(agentId, baseStatus);
      baseStatus = "interrupted";
    }
    const diagnostic = this.diagnostics.get(agentId);
    const pendingUiRequest = baseStatus === "stopping"
      ? undefined
      : (() => {
          const pending = process?.getPendingUiRequest();
          return pending ? parsePiExtensionUiDialog(pending) : undefined;
        })() ?? this.pendingUiRequests.get(agentId);
    const lastKnownStatus = pendingUiRequest ? "needs-attention" : baseStatus;
    return {
      ...agent,
      lastKnownStatus,
      live: process !== undefined,
      persisted: agent.piSessionPath !== null,
      ...(pendingUiRequest ? { pendingUiRequest } : {}),
      ...(this.runStartedAt.has(agentId) ? { runStartedAt: this.runStartedAt.get(agentId)! } : {}),
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
      if (!process && !this.pendingStarts.has(agent.id) && this.isStaleActiveStatus(lastKnownStatus)) {
        this.markInterrupted(agent.id, lastKnownStatus);
        lastKnownStatus = "interrupted";
      }
      return {
        ...agent,
        lastKnownStatus,
        live: process !== undefined,
        persisted: agent.piSessionPath !== null,
        ...(this.runStartedAt.has(agent.id) ? { runStartedAt: this.runStartedAt.get(agent.id)! } : {}),
      };
    });
  }

  /** True for a persisted status that only makes sense while a run/boot/
   *  question is actually in flight -- i.e. one a daemon restart can leave
   *  behind with nothing left to ever settle it. */
  private isStaleActiveStatus(status: string): boolean {
    return status === "running" || status === "stopping" || status === "initializing" || status === "needs-attention";
  }

  /** At-a-glance agent activity per workspace for the sidebar dots.
   *  Single bounded query (no per-workspace fan-out), aggregated with the
   *  same attention > active > idle > empty priority as the web
   *  `getWorkspaceStatusKind`. Workspaces with no (non-archived) agents are
   *  absent from the map -- the client renders a missing entry as empty/gray.
   *  Applies the same stale-status correction as list()/snapshot() so a
   *  daemon restart never leaves a stuck orange dot, and treats a pending
   *  UI request as attention (red) even though list() rows omit it. */
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
      if (this.pendingUiRequests.has(row.id)) {
        status = "needs-attention";
      } else {
        const process = this.manager.get(row.id);
        if (process) {
          try {
            if (process.getPendingUiRequest?.()) status = "needs-attention";
          } catch {}
        } else if (!this.pendingStarts.has(row.id) && this.isStaleActiveStatus(status)) {
          try {
            this.markInterrupted(row.id, status);
          } catch {}
          status = "interrupted";
        }
      }
      const bucket = (seen[row.workspaceId] ??= { attention: false, active: false, idle: false });
      if (status === "needs-attention" || status === "error" || status === "interrupted") bucket.attention = true;
      else if (status === "running" || status === "stopping") bucket.active = true;
      else if (status === "initializing") { /* empty -- no bucket flag */ }
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

  /** Persists `interrupted` -- distinct from `error`: Pi reported nothing
   *  wrong, Passage simply lost track of in-flight work (no live process,
   *  no boot in flight), most commonly because of a daemon restart. Records
   *  why without touching the Pi transcript: nothing this honest can say Pi
   *  itself produced that row. Never overwrites an already-recorded
   *  diagnostic (e.g. a real crash reported by onLifecycle earlier in this
   *  daemon's life). */
  private markInterrupted(agentId: string, previousStatus: string): void {
    if (!this.diagnostics.has(agentId)) {
      this.diagnostics.set(agentId, { exitStatus: `interrupted (${previousStatus})`, stderr: [], stderrTruncated: false });
      while (this.diagnostics.size > MAX_RUNTIME_DIAGNOSTICS) this.diagnostics.delete(this.diagnostics.keys().next().value!);
    }
    this.runStartedAt.delete(agentId);
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
        this.markInterrupted(agent.id, agent.lastKnownStatus);
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

  /** Every agentId this service currently has any runtime bookkeeping for:
   *  a live process, an in-flight admitted operation, or a pending
   *  question. Bounded by the manager's live-process cap plus a handful of
   *  transient trackers -- never a full agent-table scan. This is exactly
   *  the set `listQuickBlockers()`/`listBlockers()` need to consider;
   *  anything not in it has no live process and nothing in flight, so it
   *  is trivially idle. */
  private candidateBlockerAgentIds(): Set<string> {
    return new Set<string>([
      ...this.pendingStarts.keys(),
      ...this.cancellations.keys(),
      ...this.compacting,
      ...this.runStartedAt.keys(),
      ...this.eventChains.keys(),
      ...this.pendingUiRequests.keys(),
      ...this.subscriptions.keys(),
    ]);
  }

  /** Synchronous, in-memory-only reason a single agent is not idle, or
   *  undefined if nothing tracked says otherwise (which does not by itself
   *  mean idle -- see listBlockers()). Never performs I/O. */
  private quickBlockerReason(agentId: string): DaemonBlocker["reason"] | undefined {
    if (this.pendingStarts.has(agentId)) return "starting";
    if (this.cancellations.has(agentId)) return "cancelling";
    if (this.compacting.has(agentId)) return "compacting";
    if (this.eventChains.has(agentId)) return "reconciling";
    if (this.pendingUiRequests.has(agentId)) return "needs-attention";
    if (this.manager.get(agentId)?.getPendingUiRequest()) return "needs-attention";
    if (this.runStartedAt.has(agentId)) return "running";
    return undefined;
  }

  /** Cheap, synchronous blocker pass. Safe to call on every event; `DaemonLifecycle` uses it only to revoke a
   *  `ready` phase the instant new activity is observed, never to grant
   *  `ready` -- that requires the authoritative, get_state-verified
   *  `listBlockers()`. */
  listQuickBlockers(): DaemonBlocker[] {
    const blockers: DaemonBlocker[] = [];
    for (const agentId of this.candidateBlockerAgentIds()) {
      const reason = this.quickBlockerReason(agentId);
      if (reason) blockers.push({ agentId, reason });
    }
    return blockers;
  }

  /** Authoritative blocker pass: the quick pass plus one bounded `get_state`
   *  probe against every remaining candidate agent with a live process, so
   *  readiness is never granted purely from cached in-memory flags -- only
   *  ever revoked early by them. A probe failure (or a confirmed
   *  `isStreaming: true`) is a blocker; a missing process with nothing
   *  tracked is not probed at all, it is just idle. Never throws. */
  async listBlockers(): Promise<DaemonBlocker[]> {
    const blockers = this.listQuickBlockers();
    const blockedIds = new Set(blockers.map((blocker) => blocker.agentId));
    const probeIds = [...this.candidateBlockerAgentIds()].filter((agentId) => !blockedIds.has(agentId) && this.manager.get(agentId) !== undefined);
    const probes = await Promise.all(probeIds.map(async (agentId): Promise<DaemonBlocker | undefined> => {
      const process = this.manager.get(agentId);
      if (!process) return undefined;
      try {
        const state = await process.request({ type: "get_state" }, BLOCKER_PROBE_TIMEOUT_MS);
        const data = responseData<{ isStreaming?: unknown }>(state);
        return data?.isStreaming === true ? { agentId, reason: "running" } : undefined;
      } catch {
        return { agentId, reason: "unknown" };
      }
    }));
    for (const probe of probes) if (probe) blockers.push(probe);
    return blockers;
  }

  async create(workspaceId: string, title = "Agent"): Promise<AgentSnapshot> {
    this.assertAdmissionOpen();
    this.validateShortValue(title, "title");
    this.requireWorkspace(workspaceId);
    const agent: Agent = {
      id: `agt_${crypto.randomUUID()}`,
      workspaceId,
      piSessionId: `pi_${crypto.randomUUID()}`,
      piSessionPath: null,
      title,
      titleOverridden: title !== "Agent",
      modelPreference: null,
      thinkingPreference: null,
      lastKnownStatus: "initializing",
      archivedAt: null,
    };
    this.repositories.agents.save(agent);
    // Spawning the Pi process (manager.start) plus the initial reconcile
    // (get_state + get_entries RPCs + session history read) is slow. Await
    // it here and the POST stays open while Pi boots, which in turn keeps
    // the New Agent button from opening its pane until boot finishes. The
    // row is already persisted, so return the initializing snapshot now and
    // let the process come up in the background -- status/row events over
    // the agent socket bring the open pane live. start() reports its own
    // failures via an error status, so nothing is lost by not awaiting it.
    // Tracked in pendingStarts so prompt/steer/history/etc. still run
    // after boot (preserving the old ordering) and shutdown waits for it.
    const tracked: Promise<void> = this.start(agent.id, { admitted: true }).catch(() => undefined).finally(() => {
      if (this.pendingStarts.get(agent.id) === tracked) this.pendingStarts.delete(agent.id);
    });
    this.pendingStarts.set(agent.id, tracked);
    return this.snapshot(agent.id);
  }

  /** Wait for create()'s background boot for this agent, if still in flight. */
  private awaitPendingStart(agentId: string): Promise<void> {
    const pending = this.pendingStarts.get(agentId);
    if (!pending) return Promise.resolve();
    return pending;
  }

  /** `options.admitted` is set only by create()'s own background boot: that
   *  work was already admitted when create() passed the gate, so it must
   *  run to completion even if drain begins moments later. An explicit
   *  resume (HTTP/WS `start`) is new work and is gated normally. */
  async start(agentId: string, options?: { admitted?: boolean }): Promise<void> {
    if (!options?.admitted) this.assertAdmissionOpen();
    // Serialize behind create()'s background boot so two overlapping
    // starts (and their trailing reconciles) can't interleave. The
    // background invocation itself sees no entry (it is set only after
    // start() is entered), so this never self-waits.
    await this.awaitPendingStart(agentId);
    const agent = this.requireAgent(agentId);
    if (agent.lastKnownStatus === "stopping") {
      if (this.cancellations.has(agentId)) throw new AgentError("invalid-input", "agent cancellation is in progress");
      this.updateStatus(agentId, "initializing", "status");
    }
    const workspace = this.requireWorkspace(agent.workspaceId);
    const sessionDir = this.sessionDirectory(agent.id);
    try {
      await mkdir(sessionDir, { recursive: true });
      const process = await this.manager.start(agent.id, {
        ...this.pi,
        cwd: workspace.cwd,
        sessionDir,
        sessionId: agent.piSessionId,
      });
      // create() no longer awaits start(), so an archive can land while Pi
      // is still booting. Don't attach/reconcile (and resurrect the status
      // of) an agent that was archived mid-start; park the process instead.
      if (this.repositories.agents.get(agentId)?.archivedAt) {
        await this.manager.stop(agentId).catch(() => undefined);
        return;
      }
      this.diagnostics.delete(agent.id);
      this.attach(agent.id, process);
      await this.reconcile(agent.id);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      logger("agent").error("Agent could not start", { event: "agent.start_failed", agentId: agent.id, ...errorFields(cause) });
      this.updateStatus(agent.id, "error", "attention", undefined, error);
    }
  }

  async prompt(agentId: string, text: string, images?: AgentImage[], files?: AgentFile[]): Promise<void> {
    this.assertAdmissionOpen();
    this.validateMessage(text);
    const agent = this.requireAgent(agentId);
    this.rejectWhileStopping(agent);
    // Only reject when a run is genuinely live. After a daemon restart the
    // DB can still say `running` with no Pi process behind it; blocking
    // `prompt` then forces the client onto `steer`, which is a silent no-op
    // when idle and strands the user's message with no response.
    if (agent.lastKnownStatus === "running" && (this.manager.get(agentId) !== undefined || this.pendingStarts.has(agentId))) {
      throw new AgentError("invalid-input", "agent is active; use steer or follow-up, or wait for cancellation");
    }
    const validatedImages = images?.map((image) => agentImageSchema.parse(image));
    const imageRefs = validatedImages?.length ? await Promise.all(validatedImages.map((image) => this.attachmentCache.storeImage(image))) : undefined;
    const fileRefs = await this.storeUploads(agentId, files);
    const process = await this.ensureProcess(agentId);
    this.beginRun(agentId);
    // The transcript journals the original text plus file metadata; the
    // Pi-bound message carries the same text with file path references
    // folded in (same turn — a separate message confuses models). Files
    // never travel as model API blocks, only images do.
    await this.appendUserRow(agentId, text, imageRefs, fileRefs);
    this.updateStatus(agentId, "running", "status", process.generation);
    try {
      await process.request({ type: "prompt", message: withFileRefs(text, fileRefs), ...(validatedImages?.length ? { images: validatedImages } : {}) });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (PI_ALREADY_STREAMING_PATTERN.test(message)) {
        // Pi rejected the prompt before acceptance because it's genuinely
        // still streaming; the run in progress is untouched. Leave status
        // as running and report a normal, retryable conflict instead of a
        // fatal agent crash.
        throw new AgentError("invalid-input", "agent is active; use steer or follow-up, or wait for cancellation");
      }
      logger("agent").error("Agent prompt failed", { event: "agent.prompt_failed", agentId, generation: process.generation, ...errorFields(cause) });
      this.updateStatus(agentId, "error", "attention", process.generation, String(cause));
      throw cause;
    }
  }

  async steer(agentId: string, text: string, images?: AgentImage[], files?: AgentFile[]): Promise<void> {
    this.assertAdmissionOpen();
    this.validateMessage(text);
    this.rejectWhileStopping(this.requireAgent(agentId));
    const validatedImages = images?.map((image) => agentImageSchema.parse(image));
    const imageRefs = validatedImages?.length ? await Promise.all(validatedImages.map((image) => this.attachmentCache.storeImage(image))) : undefined;
    const fileRefs = await this.storeUploads(agentId, files);
    const process = await this.ensureProcess(agentId);
    await this.appendUserRow(agentId, text, imageRefs, fileRefs);
    await process.request({ type: "steer", message: withFileRefs(text, fileRefs), ...(validatedImages?.length ? { images: validatedImages } : {}) });
  }

  async followUp(agentId: string, text: string, images?: AgentImage[], files?: AgentFile[]): Promise<void> {
    this.assertAdmissionOpen();
    this.validateMessage(text);
    this.rejectWhileStopping(this.requireAgent(agentId));
    const validatedImages = images?.map((image) => agentImageSchema.parse(image));
    const imageRefs = validatedImages?.length ? await Promise.all(validatedImages.map((image) => this.attachmentCache.storeImage(image))) : undefined;
    const fileRefs = await this.storeUploads(agentId, files);
    const process = await this.ensureProcess(agentId);
    await this.appendUserRow(agentId, text, imageRefs, fileRefs);
    await process.request({ type: "follow_up", message: withFileRefs(text, fileRefs), ...(validatedImages?.length ? { images: validatedImages } : {}) });
  }

  async abort(agentId: string): Promise<void> {
    this.pendingUiRequests.delete(agentId);
    // Don't report "no process" for a create() whose boot is still in
    // flight; wait for it so an immediate New-Agent-then-abort still
    // reaches the stopping state instead of silently staying initializing.
    await this.awaitPendingStart(agentId);
    const agent = this.requireAgent(agentId);
    const process = this.manager.get(agentId);
    if (!process) {
      if (agent.lastKnownStatus === "running" || agent.lastKnownStatus === "stopping") {
        this.updateStatus(agentId, "error", "attention", undefined, "Pi process is not running");
      }
      return;
    }
    if (agent.lastKnownStatus === "stopping" && this.cancellations.has(agentId)) return;
    const cancellation = { process, generation: process.generation };
    this.cancellations.set(agentId, cancellation);
    this.updateStatus(agentId, "stopping", "status", process.generation);
    void this.completeAbort(agentId, cancellation);
  }

  async respondExtensionUi(agentId: string, response: PiExtensionUiResponse): Promise<void> {
    // Same boot race as abort(): the pane opens before Pi is up, so a fast
    // dialog response must wait for the process rather than 409.
    await this.awaitPendingStart(agentId);
    this.rejectWhileStopping(this.requireAgent(agentId));
    const process = this.requireProcess(agentId);
    process.respondExtensionUi(response);
    this.pendingUiRequests.delete(agentId);
    this.updateStatus(agentId, "running", "status", process.generation);
  }

  async capabilities(agentId: string): Promise<AgentCapabilities> {
    const process = await this.ensureProcess(agentId);
    const [modelsResponse, thinkingResponse, commandsResponse, stateResponse] = await Promise.all([
      process.request({ type: "get_available_models" }),
      process.request({ type: "get_available_thinking_levels" }),
      // Best-effort: older pi releases may not know `get_commands`.
      process.request({ type: "get_commands" }).catch(() => undefined),
      // Best-effort live defaults: a brand-new agent has no persisted
      // preference and no journaled model yet, so without this the
      // composer falls back to "model unavailable" until the next full
      // summary refetch (which only happens after the first settlement).
      process.request({ type: "get_state" }).catch(() => undefined),
    ]);
    const modelsData = responseData<{ models?: unknown[] }>(modelsResponse);
    const thinkingData = responseData<{ levels?: unknown[] }>(thinkingResponse);
    const models = normalizeAvailableModels(modelsData);
    const thinkingLevels = (thinkingData?.levels ?? [])
      .filter((value): value is string => typeof value === "string")
      .slice(0, 16);
    // User-level skills load like the pi TUI; project-local resources stay
    // disabled via the `--no-approve` spawn flag (see slash-commands.ts).
    const skillCommands = piCommandsToSlashCommands(
      commandsResponse ? responseData<{ commands?: unknown }>(commandsResponse)?.commands : undefined,
    );
    const stateData = stateResponse ? (responseData<Record<string, unknown>>(stateResponse) ?? {}) : {};
    const stateModel = stateData.model && typeof stateData.model === "object"
      ? stateData.model as Record<string, unknown>
      : undefined;
    const currentModel = stateModel && typeof stateModel.provider === "string" && typeof stateModel.id === "string"
      ? { provider: stateModel.provider, modelId: stateModel.id }
      : undefined;
    const currentThinkingLevel = typeof stateData.thinkingLevel === "string" && stateData.thinkingLevel.length > 0
      ? stateData.thinkingLevel
      : undefined;
    // Persist live defaults so later summary fetches agree with what the
    // composer already displayed from this response (same rule as reconcile).
    try {
      const agent = this.repositories.agents.get(agentId);
      if (agent && currentModel && !agent.modelPreference) {
        this.repositories.agents.updateModelPreference(agentId, `${currentModel.provider}/${currentModel.modelId}`);
      }
      if (agent && currentThinkingLevel && !agent.thinkingPreference) {
        this.repositories.agents.updateThinkingPreference(agentId, currentThinkingLevel);
      }
    } catch {}
    return agentCapabilitiesSchema.parse({
      models,
      thinkingLevels,
      ...(currentModel ? { currentModel } : {}),
      ...(currentThinkingLevel ? { currentThinkingLevel } : {}),
      slashCommands: [...getSlashCommands(), ...skillCommands],
      skillsAvailable: skillCommands.length > 0,
      skillsSupported: commandsResponse !== undefined,
    });
  }

  async compact(agentId: string, customInstructions?: string): Promise<CompactResult> {
    this.assertAdmissionOpen();
    if (customInstructions !== undefined) this.validateShortValue(customInstructions, "instructions");
    this.rejectWhileStopping(this.requireAgent(agentId));
    const process = await this.ensureProcess(agentId);
    // Pi aborts any in-flight run before summarizing; a too-short session
    // is a benign refusal, not an error, so map it to a reason instead of
    // throwing (the UI shows an info notice for it).
    this.compacting.add(agentId);
    let tokensBefore: number | undefined;
    try {
      const response = await process.request(
        customInstructions ? { type: "compact", customInstructions } : { type: "compact" },
        COMPACT_TIMEOUT_MS,
      );
      const data = responseData<{ tokensBefore?: unknown }>(response);
      if (typeof data?.tokensBefore === "number" && Number.isFinite(data.tokensBefore) && data.tokensBefore > 0) {
        tokensBefore = Math.floor(data.tokensBefore);
      }
    } catch (cause) {
      const reason = compactRefusalReason(cause);
      if (reason === undefined) throw cause;
      return { compacted: false, reason };
    } finally {
      this.compacting.delete(agentId);
    }
    // Compaction rewrites which journal entries are active, which invalidates
    // every row identity the current TranscriptState was built from -- unlike
    // every other mutation, this is a legitimate full reset, not an
    // incremental delta. Force a fresh seed on next access and tell the
    // client to refetch and replace its local timeline instead of merging.
    this.resetTranscript(agentId);
    return { compacted: true, ...(tokensBefore === undefined ? {} : { tokensBefore }) };
  }

  async model(agentId: string, provider: string, modelId: string): Promise<void> {
    this.assertAdmissionOpen();
    this.validateShortValue(provider, "provider");
    this.validateShortValue(modelId, "model");
    this.rejectWhileStopping(this.requireAgent(agentId));
    const capabilities = await this.capabilities(agentId);
    if (!capabilities.models.some((model) => model.provider === provider && model.id === modelId)) {
      throw new AgentError("invalid-input", "model is unavailable");
    }
    const process = await this.ensureProcess(agentId);
    await process.request({ type: "set_model", provider, modelId });
    this.repositories.agents.updateModelPreference(agentId, `${provider}/${modelId}`);
    (await this.getTranscript(agentId)).setModel(provider, modelId);
  }

  async thinking(agentId: string, level: string): Promise<void> {
    this.assertAdmissionOpen();
    this.validateShortValue(level, "thinking level");
    this.rejectWhileStopping(this.requireAgent(agentId));
    const capabilities = await this.capabilities(agentId);
    if (!capabilities.thinkingLevels.includes(level)) {
      throw new AgentError("invalid-input", "thinking level is unavailable");
    }
    const process = await this.ensureProcess(agentId);
    await process.request({ type: "set_thinking_level", level });
    this.repositories.agents.updateThinkingPreference(agentId, level);
  }

  /** The transcript (timeline + usage/model/etc.) is served straight from
   *  the in-memory `TranscriptState`, never a fresh file re-parse -- that is
   *  what makes it safe to call this on every reconnect/reload without
   *  racing the live event stream or reordering rows underneath it. A file
   *  read only happens once, lazily, to seed a brand new instance. */
  async history(agentId: string, before?: number, limit = 100): Promise<AgentHistoryResult> {
    let agent = this.requireAgent(agentId);
    if (!agent.piSessionPath) {
      if (agent.lastKnownStatus === "initializing" && !this.manager.get(agentId)) {
        // create() returns before the background start() puts a process in
        // the manager. Reconciling immediately would see "no process" and
        // flip a brand-new agent to error; wait for the in-flight start
        // (ensureProcess dedupes via the manager's pending start) instead.
        await this.ensureProcess(agentId).catch(() => undefined);
        agent = this.requireAgent(agentId);
      } else {
        await this.reconcile(agentId, !this.cancellations.has(agentId));
        agent = this.requireAgent(agentId);
      }
    }
    if (!agent.piSessionPath && !this.transcripts.has(agentId)) return { unpersisted: true, history: null };
    const state = await this.getTranscript(agentId);
    const snapshot = state.snapshot();
    const revision = this.previousRevisions.get(agentId) ?? { mtimeMs: 0, size: 0, contentHash: "" };
    const history: AgentHistory = {
      sessionId: agentId,
      revision,
      transcriptEpoch: this.currentEpoch(agentId),
      timeline: snapshot.timeline,
      branches: [],
      usage: snapshot.usage,
      contextUsage: snapshot.contextUsage,
      ...(snapshot.currentModel ? { currentModel: snapshot.currentModel } : {}),
      ...(snapshot.currentThinkingLevel ? { currentThinkingLevel: snapshot.currentThinkingLevel } : {}),
      ...(snapshot.sessionName ? { sessionName: snapshot.sessionName } : {}),
      unknownRecordCount: 0,
      agentErrorCount: snapshot.agentErrorCount,
      malformedRecordCount: 0,
      partialTail: false,
      invalidUtf8Count: 0,
      rewritten: false,
    };
    return pageHistory(history, before, limit);
  }

  /** Plain-text conversation excerpts for commit-message generation.
   *  Best-effort and side-effect-free: never spawns a Pi process and never
   *  throws. When `agentId` names a live workspace agent it is used alone;
   *  otherwise all non-archived workspace agents contribute in list order.
   *  Only `user`/`assistant` row text is returned (chronological); `thinking`
   *  (reasoning), `tool`, `summary`, `error`, and `unknown` rows are skipped,
   *  and image/file attachments are excluded because only each row's `text`
   *  field is read, never its `images`/`files` refs. */
  async getCommitConversation(workspaceId: string, agentId?: string): Promise<{ userMessages: string[]; finalAssistantMessages: string[] }> {
    const empty = { userMessages: [], finalAssistantMessages: [] };
    try {
      let ids: string[];
      if (agentId?.trim()) {
        const agent = this.repositories.agents.get(agentId.trim());
        if (!agent || agent.workspaceId !== workspaceId || agent.archivedAt) return empty;
        ids = [agent.id];
      } else {
        try {
          ids = this.repositories.agents.listForWorkspace(workspaceId, this.listLimit).map((a) => a.id);
        } catch {
          return empty;
        }
      }
      const users: string[] = [];
      const finals: string[] = [];
      for (const id of ids.slice(0, 10)) {
        let timeline: TimelineItem[];
        try {
          timeline = (await this.getTranscript(id)).snapshot().timeline;
        } catch {
          continue;
        }
        for (const row of timeline) {
          if (row.kind !== "user") continue;
          const text = row.text.trim();
          if (text) users.push(text);
        }
        for (let i = timeline.length - 1; i >= 0; i -= 1) {
          const row = timeline[i];
          if (row.kind !== "assistant") continue;
          const text = row.text.trim();
          if (text) {
            finals.push(text);
            break;
          }
        }
      }
      return {
        userMessages: users.slice(-20),
        finalAssistantMessages: finals.slice(-3),
      };
    } catch {
      return empty;
    }
  }

  async archive(agentId: string): Promise<void> {
    // Serialize behind a still-booting create() so the background start
    // can't attach/reconcile (or leak a process) around the archival.
    await this.awaitPendingStart(agentId);
    const agent = this.repositories.agents.get(agentId);
    if (!agent) throw new AgentError("not-found", "agent not found");
    this.detach(agentId);
    await this.manager.stop(agentId);
    const archivedAt = new Date().toISOString();
    this.repositories.agents.archive(agentId, archivedAt);
    this.repositories.agents.updateStatus(agentId, "archived");
    this.previousRevisions.delete(agentId);
    this.leaves.delete(agentId);
    this.diagnostics.delete(agentId);
    this.runStartedAt.delete(agentId);
    this.transcripts.delete(agentId);
    this.transcriptSeeds.delete(agentId);
    this.transcriptEpochs.delete(agentId);
    this.emit({ agentId, type: "status", status: "archived" });
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

  /** Promote an archived agent back to active. The Pi session (same
   *  piSessionId/sessionDir) resumes lazily on the next prompt/steer, so
   *  this is a metadata-only flip to `idle` -- no Pi spawn, no admission
   *  gate. Rejects archived workspaces via requireWorkspace. */
  async reopen(agentId: string): Promise<AgentSnapshot> {
    if (!ID.test(agentId)) throw new AgentError("invalid-input", "invalid agent id");
    const agent = this.repositories.agents.get(agentId);
    if (!agent) throw new AgentError("not-found", "agent not found");
    if (!agent.archivedAt) throw new AgentError("invalid-input", "agent is not archived");
    this.requireWorkspace(agent.workspaceId);
    this.repositories.agents.unarchive(agentId);
    this.repositories.agents.updateStatus(agentId, "idle");
    this.emit({ agentId, type: "status", status: "idle" });
    return this.snapshot(agentId);
  }

  async stop(agentId: string): Promise<void> {
    this.requireAgent(agentId);
    this.detach(agentId);
    this.runStartedAt.delete(agentId);
    await this.manager.stop(agentId);
  }

  /** Stop every live Pi process in a workspace (agent-browser/preview
   *  sessions are owned by WebPreviewManager, terminals by
   *  TerminalManager). Used before workspace archival/removal so no `pi
   *  --mode rpc` process outlives the worktree directory. Never throws. */
  async stopForWorkspace(workspaceId: string): Promise<string[]> {
    const log = logger("agent");
    let agents: { id: string }[];
    try {
      agents = this.repositories.agents.listForWorkspace(workspaceId, this.listLimit);
    } catch (error) {
      log.warn("Workspace agent lookup failed", { event: "agent.workspace_stop_lookup_failed", workspaceId, ...errorFields(error) });
      return [];
    }
    const stopped: string[] = [];
    await Promise.all(agents.map(async (agent) => {
      try {
        // Serialize behind a still-booting create() so the background
        // start can't leak a process around the teardown.
        await this.awaitPendingStart(agent.id);
        this.detach(agent.id);
        this.cancellations.delete(agent.id);
        this.runStartedAt.delete(agent.id);
        await this.manager.stop(agent.id);
        stopped.push(agent.id);
      } catch (error) {
        log.warn("Workspace agent stop failed", { event: "agent.workspace_stop_failed", agentId: agent.id, workspaceId, ...errorFields(error) });
      }
    }));
    if (stopped.length > 0) {
      log.info("Agents stopped for workspace", { event: "agent.workspace_stopped", workspaceId, count: stopped.length });
    }
    return stopped;
  }

  /** `options.interrupted` distinguishes step 6's two shutdown paths:
   *  - Safe (default): every agent here was already verified idle by the
   *    drain that reached `ready` (see DaemonLifecycle.commit), so there
   *    is nothing meaningful to reconcile from stopping it. Detach first,
   *    same as before -- an intentional, already-idle stop must not get
   *    flagged as an error by the ordinary crash-handling path.
   *  - Interrupted (explicit force): active work may really be getting cut
   *    off. Keep each process's lifecycle listener attached while it is
   *    stopped, so a forced exit still runs the ordinary onLifecycle
   *    handling (final diagnostics, status, transcript error row) instead
   *    of being silently dropped by an early detach, and await any
   *    in-flight event/lifecycle reconciliation that stop triggered --
   *    all while SQLite is still open. */
  async shutdown(options?: { interrupted?: boolean }): Promise<void> {
    // Let create()'s background boots finish (they clean up their own map
    // entries) so they never write to a closed database after this returns.
    await Promise.allSettled([...this.pendingStarts.values()]);
    this.pendingStarts.clear();
    if (options?.interrupted) {
      await this.manager.shutdown();
      await Promise.allSettled([...this.eventChains.values()]);
      for (const agentId of this.subscriptions.keys()) this.detach(agentId);
    } else {
      for (const agentId of this.subscriptions.keys()) this.detach(agentId);
      await this.manager.shutdown();
    }
    this.listeners.clear();
    this.previousRevisions.clear();
    this.leaves.clear();
    this.diagnostics.clear();
    this.compacting.clear();
    this.titleSuggestions.clear();
    this.runStartedAt.clear();
    this.eventChains.clear();
    this.transcripts.clear();
    this.transcriptSeeds.clear();
    this.transcriptEpochs.clear();
  }

  private attach(agentId: string, process: PiProcessHandle): void {
    const current = this.subscriptions.get(agentId);
    if (current?.generation === process.generation) return;
    this.detach(agentId);
    this.subscriptions.set(agentId, {
      generation: process.generation,
      unsubscribeEvents: process.subscribe((event) => this.enqueueEvent(agentId, event)),
      unsubscribeLifecycle: process.subscribeLifecycle((event) => this.enqueueLifecycle(agentId, event)),
    });
    logger("agent").info("Agent process subscribed", {
      event: "agent.process_subscribed",
      agentId,
      generation: process.generation,
    });
  }

  private detach(agentId: string): void {
    this.pendingUiRequests.delete(agentId);
    const subscription = this.subscriptions.get(agentId);
    if (!subscription) return;
    subscription.unsubscribeEvents();
    subscription.unsubscribeLifecycle();
    this.subscriptions.delete(agentId);
  }

  private enqueueEvent(agentId: string, event: PiEvent): void {
    this.enqueue(agentId, () => this.onEvent(agentId, event));
  }

  private enqueueLifecycle(agentId: string, event: PiLifecycleEvent): void {
    this.enqueue(agentId, async () => this.onLifecycle(agentId, event));
  }

  private enqueue(agentId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.eventChains.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.eventChains.set(agentId, next);
    while (this.eventChains.size > MAX_LIST) this.eventChains.delete(this.eventChains.keys().next().value!);
    void next.catch(() => {
      const process = this.manager.get(agentId);
      this.updateStatus(agentId, "error", "attention", process?.generation, "Agent event reconciliation failed");
    }).finally(() => {
      if (this.eventChains.get(agentId) === next) this.eventChains.delete(agentId);
    });
    return next;
  }

  private sanitizeEventPayload(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeEventPayload(item));
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
      return { type: "image", mimeType: record.mimeType };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = this.sanitizeEventPayload(v);
    }
    return out;
  }

  private async onEvent(agentId: string, event: PiEvent): Promise<void> {
    if (this.subscriptions.get(agentId)?.generation !== event.generation) return;
    const agent = this.repositories.agents.get(agentId);
    if (!agent) return;

    if (!agent.piSessionPath) {
      await this.reconcile(agentId);
    }

    const currentStatus = (this.repositories.agents.get(agentId)?.lastKnownStatus as AgentStatus) ?? "running";
    const rawPayload: Record<string, unknown> = {};
    if (event.id !== undefined) rawPayload.id = event.id;
    if (event.method !== undefined) rawPayload.method = event.method;
    if (event.title !== undefined) rawPayload.title = event.title;
    if (event.options !== undefined) rawPayload.options = event.options;
    if (event.placeholder !== undefined) rawPayload.placeholder = event.placeholder;
    if (event.prefill !== undefined) rawPayload.prefill = event.prefill;
    if (event.timeout !== undefined) rawPayload.timeout = event.timeout;
    if (event.questions !== undefined) rawPayload.questions = event.questions;
    if (event.statusKey !== undefined) rawPayload.statusKey = event.statusKey;
    if (event.statusText !== undefined) rawPayload.statusText = event.statusText;
    if (event.widgetKey !== undefined) rawPayload.widgetKey = event.widgetKey;
    if (event.widgetLines !== undefined) rawPayload.widgetLines = event.widgetLines;
    if (event.message !== undefined) rawPayload.message = event.message;
    if (event.assistantMessageEvent !== undefined) rawPayload.assistantMessageEvent = event.assistantMessageEvent;
    if (event.toolCallId !== undefined) rawPayload.toolCallId = event.toolCallId;
    if (event.toolName !== undefined) rawPayload.toolName = event.toolName;
    if (event.args !== undefined) rawPayload.args = event.args;
    if (event.result !== undefined) rawPayload.result = event.result;
    if (event.partialResult !== undefined) rawPayload.partialResult = event.partialResult;
    if (event.isError !== undefined) rawPayload.isError = event.isError;
    if (event.usage !== undefined) rawPayload.usage = event.usage;
    if (event.level !== undefined) rawPayload.level = event.level;
    if (event.delta !== undefined) rawPayload.delta = event.delta;
    if (event.text !== undefined) rawPayload.text = event.text;
    if (event.content !== undefined) rawPayload.content = event.content;
    if (event.thinking !== undefined) rawPayload.thinking = event.thinking;

    const payload = this.sanitizeEventPayload(rawPayload) as Record<string, unknown>;
    await this.applyTranscriptEvent(agentId, String(event.type ?? "event"), payload);

    // An agent-side `git commit` (Pi bash tool or any other tool) mutates the
    // repo outside Passage's Git HTTP routes, so no `git-status-changed`
    // invalidation would otherwise fire and the merge button / changes list
    // stay stale until a manual refresh. Invalidate immediately so subscribed
    // views re-check status mid-run; their quiet refetch bypasses op locks.
    if (isGitCommitToolEvent(String(event.type ?? "event"), payload)) {
      this.notifyWorkspaceGitChanged(agent.workspaceId);
    }

    if (event.type === "agent_settled") {
      // Backstop: a run may have mutated Git state through a path the
      // commit heuristic misses (helper scripts, aliases, rebase/merge), so
      // reconcile Git views after every settlement.
      this.notifyWorkspaceGitChanged(agent.workspaceId);
      this.pendingUiRequests.delete(agentId);
      await this.reconcile(agentId);
      this.endRun(agentId);
      const status = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
      this.emit({ agentId, type: "settled", status, generation: event.generation, payload });
    } else if (currentStatus === "stopping") {
      this.emit({ agentId, type: String(event.type ?? "event"), status: currentStatus, generation: event.generation, payload });
    } else if (event.type === "agent_start" || event.type === "turn_start") {
      this.beginRun(agentId);
      this.updateStatus(agentId, "running", "status", event.generation, undefined, payload);
    } else {
      const dialog = parsePiExtensionUiDialog(event);
      if (dialog) {
        this.pendingUiRequests.set(agentId, dialog);
        this.updateStatus(agentId, "needs-attention", "attention", event.generation, undefined, dialog);
      } else if (["error", "prompt_error", "extension_error"].includes(String(event.type))) {
        this.updateStatus(agentId, "error", "attention", event.generation, undefined, payload);
      } else {
        if (event.type === "thinking_level_changed" && typeof event.level === "string") {
          this.repositories.agents.updateThinkingPreference(agentId, event.level);
        }
        this.emit({ agentId, type: String(event.type ?? "event"), status: currentStatus, generation: event.generation, payload });
      }
    }
  }

  private async onLifecycle(agentId: string, event: PiLifecycleEvent): Promise<void> {
    if (this.subscriptions.get(agentId)?.generation !== event.generation) return;
    this.diagnostics.set(agentId, {
      generation: event.generation,
      exitStatus: `${event.lifecycle} (${event.exitCode})`,
      stderr: [...event.stderr],
      stderrTruncated: event.stderrTruncated,
    });
    while (this.diagnostics.size > MAX_RUNTIME_DIAGNOSTICS) this.diagnostics.delete(this.diagnostics.keys().next().value!);
    logger("agent").error("Agent Pi process ended", { event: "agent.process_ended", agentId, generation: event.generation, exitStatus: `${event.lifecycle} (${event.exitCode})`, exitCode: event.exitCode, stderrBytes: event.stderr.reduce((total, part) => total + encoder.encode(part).byteLength, 0), stderrTruncated: event.stderrTruncated });
    this.detach(agentId);
    const message = `Pi process exited (${event.exitCode})`;
    const state = await this.getTranscript(agentId);
    this.emitRowUpsert(agentId, state.appendError(message));
    this.updateStatus(agentId, "error", "attention", event.generation, message);
  }

  private async completeAbort(agentId: string, cancellation: Cancellation): Promise<void> {
    const { process, generation } = cancellation;
    try {
      const clearQueue = process.request({ type: "clear_queue" }, this.abortTimeoutMs);
      // A foreground daemon (e.g. `bun run dev` without `&`) holds the turn
      // inside a bash tool call that `abort` alone does not kill -- Pi
      // exposes `abort_bash` for exactly that. Best-effort: it rejects when
      // no bash command is running, which must not fail an otherwise clean stop.
      const abortBash = process.request({ type: "abort_bash" }, this.abortTimeoutMs).catch(() => undefined);
      const abort = process.request({ type: "abort" }, this.abortTimeoutMs);
      await Promise.all([clearQueue, abortBash, abort]);
      if (this.manager.get(agentId) !== process || process.generation !== generation) return;
      await this.enqueue(agentId, () => this.reconcile(agentId, true));
      // An aborted run may still have mutated the worktree before it was
      // stopped, and unlike natural settlement there is no `agent_settled`
      // event to invalidate Git views -- so a dirty tree would otherwise
      // keep rendering its stale clean snapshot (hiding the commit
      // affordance) until the next unrelated invalidation.
      const workspaceId = this.repositories.agents.get(agentId)?.workspaceId;
      if (workspaceId) this.notifyWorkspaceGitChanged(workspaceId);
    } catch (cause) {
      if (this.manager.get(agentId) !== process || process.generation !== generation) return;
      if (this.requireAgent(agentId).lastKnownStatus === "idle") return;
      const message = cause instanceof Error ? cause.message : "Unable to confirm agent cancellation";
      await this.manager.stop(agentId).catch(() => undefined);
      this.updateStatus(agentId, "error", "attention", generation, `Unable to confirm agent cancellation: ${message}`);
    } finally {
      if (this.cancellations.get(agentId) === cancellation) this.cancellations.delete(agentId);
    }
  }

  private async reconcile(agentId: string, allowStoppingToSettle = false): Promise<void> {
    const process = this.manager.get(agentId);
    if (!process) {
      this.updateStatus(agentId, "error", "attention", undefined, "Pi process is not running");
      return;
    }
    const [stateRecord, entriesRecord] = await Promise.all([
      process.request({ type: "get_state" }).catch(() => undefined),
      process.request({ type: "get_entries" }).catch(() => undefined),
    ]);
    if (!stateRecord || !entriesRecord) {
      this.updateStatus(agentId, "error", "attention", process.generation, "Unable to read Pi state");
      return;
    }
    const data = (responseData<Record<string, unknown>>(stateRecord) ?? stateRecord) as Record<string, unknown>;
    const entries = responseData<{ leafId?: unknown }>(entriesRecord);
    if (typeof entries?.leafId === "string") {
      this.remember(this.leaves, agentId, entries.leafId);
    }
    const sessionPath = typeof data.sessionFile === "string"
      ? data.sessionFile
      : typeof data.sessionPath === "string"
        ? data.sessionPath
        : undefined;
    if (sessionPath) {
      let canonical: string;
      try {
        canonical = await realpath(sessionPath);
      } catch {
        canonical = "";
      }
      if (canonical) {
        const directory = await realpath(this.sessionDirectory(agentId));
        const pathFromDirectory = relative(directory, canonical);
        const escapes = pathFromDirectory === ".." || pathFromDirectory.startsWith(`..${sep}`) || isAbsolute(pathFromDirectory);
        if (!escapes) this.repositories.agents.updateSessionPath(agentId, canonical);
        else {
          this.updateStatus(agentId, "error", "attention", process.generation, "Pi session path is outside its session directory");
          return;
        }
      }
    }
    const agent = this.requireAgent(agentId);
    const stateModel = data.model && typeof data.model === "object" ? data.model as Record<string, unknown> : undefined;
    if (stateModel && typeof stateModel.provider === "string" && typeof stateModel.id === "string") {
      if (!agent.modelPreference) {
        this.repositories.agents.updateModelPreference(agentId, `${stateModel.provider}/${stateModel.id}`);
      }
    }
    if (typeof data.thinkingLevel === "string" && !agent.thinkingPreference) {
      this.repositories.agents.updateThinkingPreference(agentId, data.thinkingLevel);
    }
    if (!agent.piSessionPath && !sessionPath) {
      const currentStatus = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
      const status = data.isStreaming === true
        ? currentStatus === "stopping" ? "stopping" : "running"
        : currentStatus === "initializing" ? "initializing" : currentStatus === "stopping" && !allowStoppingToSettle ? "stopping" : "idle";
      this.updateStatus(agentId, status, "status", process.generation);
      return;
    }
    const persistedPath = this.repositories.agents.get(agentId)?.piSessionPath;
    if (!persistedPath) {
      const currentStatus = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
      const status = data.isStreaming === true
        ? currentStatus === "stopping" ? "stopping" : "running"
        : currentStatus === "initializing" ? "initializing" : currentStatus === "stopping" && !allowStoppingToSettle ? "stopping" : "idle";
      this.updateStatus(agentId, status, "status", process.generation);
      return;
    }
    try {
      const history = await readPiHistory(persistedPath, {
        previousRevision: this.previousRevisions.get(agentId),
        leafId: this.leaves.get(agentId),
      });
      this.rememberRevision(agentId, history.revision);
      // A rewrite (external edit/truncation of the session file) invalidates
      // every row identity the live TranscriptState was built from -- unlike
      // every other mutation, that is a legitimate full reset. Otherwise,
      // reuse this already-fetched journal read to opportunistically refresh
      // tool rows (id-matched, safe) and metadata without any extra I/O.
      if (history.rewritten) {
        this.resetTranscript(agentId);
      } else {
        const state = await this.getTranscript(agentId);
        for (const row of state.refreshFromJournal(history)) this.emitRowUpsert(agentId, row);
      }
      const latestItem = history.timeline.at(-1);
      // A compact in flight just killed the current run on purpose (see
      // `compacting`): its abort tombstone is expected, and the compaction
      // entry landing right after it supersedes it, so don't flash an
      // error status/row for intentional behavior.
      const hasActiveError = !this.compacting.has(agentId) && latestItem && "error" in latestItem && Boolean(latestItem.error);
      const currentStatus = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
      if (currentStatus === "needs-attention") return;
      if (currentStatus === "stopping" && !allowStoppingToSettle) return;
      const confirmedCancellation = allowStoppingToSettle && currentStatus === "stopping" && data.isStreaming === false;
      if (hasActiveError && data.isStreaming !== true && !confirmedCancellation) {
        const message = String(latestItem.error);
        const lastRow = (await this.getTranscript(agentId)).snapshot().timeline.at(-1);
        if (!(lastRow?.kind === "error" && lastRow.text === message)) {
          this.emitRowUpsert(agentId, (await this.getTranscript(agentId)).appendError(message));
        }
        this.updateStatus(agentId, "error", "attention", process.generation, message);
        return;
      }
    } catch (cause) {
      logger("agent").error("Agent history reconciliation failed", { event: "agent.reconcile_failed", agentId, generation: process.generation, ...errorFields(cause) });
      this.updateStatus(agentId, "error", "attention", process.generation, "Unable to reconcile Pi session history");
      return;
    }
    const currentStatus = this.requireAgent(agentId).lastKnownStatus as AgentStatus;
    if (currentStatus === "needs-attention" || (currentStatus === "stopping" && (data.isStreaming === true || !allowStoppingToSettle))) return;
    this.updateStatus(agentId, data.isStreaming === true ? "running" : "idle", "status", process.generation);
  }

  private updateStatus(agentId: string, status: AgentStatus, type: AgentServiceEvent["type"], generation?: number, error?: string, payload?: Record<string, unknown>): void {
    if (status === "idle" || status === "error" || status === "interrupted" || status === "archived") this.endRun(agentId);
    this.repositories.agents.updateStatus(agentId, status);
    const runStartedAt = this.runStartedAt.get(agentId);
    const eventPayload = { ...(payload ?? {}), ...(runStartedAt !== undefined ? { runStartedAt } : {}) };
    this.emit({ agentId, type, status, ...(generation ? { generation } : {}), ...(error ? { error } : {}), ...(Object.keys(eventPayload).length > 0 ? { payload: eventPayload } : {}) });
  }

  /** Record the start of the current run. Idempotent per run so repeated
   *  `agent_start`/`turn_start` events do not move the anchor. */
  private beginRun(agentId: string): void {
    if (!this.runStartedAt.has(agentId)) this.runStartedAt.set(agentId, Date.now());
  }

  private endRun(agentId: string): void {
    this.runStartedAt.delete(agentId);
  }

  /** Returns this agent's transcript projector, seeding it from the journal
   *  on first access. Seeding and event application both run inside the
   *  per-agent serialized event chain (or, for `history()`, before any event
   *  can race it since it's the first await), so this is race-free without
   *  needing its own lock -- concurrent callers share the same in-flight
   *  seed promise instead of reading the file twice. */
  private async getTranscript(agentId: string): Promise<TranscriptState> {
    const existing = this.transcripts.get(agentId);
    if (existing) return existing;
    const inflight = this.transcriptSeeds.get(agentId);
    if (inflight) return inflight;
    const seed = (async () => {
      const state = new TranscriptState();
      const agent = this.repositories.agents.get(agentId);
      if (agent?.piSessionPath) {
        try {
          const history = await readPiHistory(agent.piSessionPath, { leafId: this.leaves.get(agentId) });
          state.seed(history);
          this.rememberRevision(agentId, history.revision);
        } catch {
          // Leave a fresh, empty instance -- live events still build a
          // reasonable view, and the next reconcile will retry the read.
        }
      }
      this.transcripts.set(agentId, state);
      while (this.transcripts.size > MAX_TRANSCRIPTS) {
        const oldest = this.transcripts.keys().next().value!;
        this.transcripts.delete(oldest);
        this.transcriptEpochs.delete(oldest);
      }
      this.transcriptSeeds.delete(agentId);
      this.bumpEpoch(agentId);
      return state;
    })();
    this.transcriptSeeds.set(agentId, seed);
    return seed;
  }

  /** Applies one Pi/daemon event to the transcript and emits a `row_upsert`
   *  for every row it changed. This is the sole path that mutates timeline
   *  rows: whether a row arrived live or was replayed after a client
   *  reconnect, it goes through the exact same projector and the exact same
   *  wire event, so there is never a second, differently-ordered view of it. */
  private async applyTranscriptEvent(agentId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const state = await this.getTranscript(agentId);
    const changed = state.applyEvent(type, payload);
    for (const row of changed) this.emitRowUpsert(agentId, row);
    // Auto-title once the first agent response lands: message_end carries
    // the completed assistant text, turn_end follows a thinking-only turn,
    // and agent_settled covers text-less responses (tools-only, errors).
    if (type === "message_end" || type === "turn_end" || type === "agent_settled") {
      this.maybeAutoTitle(agentId, state.snapshot().timeline, type === "agent_settled");
    }
  }

  private emitRowUpsert(agentId: string, row: TimelineItem): void {
    const status = (this.repositories.agents.get(agentId)?.lastKnownStatus as AgentStatus) ?? "running";
    this.emit({ agentId, type: "row_upsert", status, payload: { row: truncateRowForWire(row) } });
  }

  private async appendUserRow(agentId: string, text: string, images?: UserImageRef[], files?: UserFileRef[]): Promise<void> {
    const state = await this.getTranscript(agentId);
    this.emitRowUpsert(agentId, state.addUserMessage(text, images, files));
    const timeline = state.snapshot().timeline;
    // Backstop: a second (or later) user message means the first response
    // was missed or produced no titlable event -- title with whatever the
    // first response contributed, or just the first user message.
    const userCount = timeline.filter((row) => row.kind === "user").length;
    if (userCount < 2) return;
    this.maybeAutoTitle(agentId, timeline, true);
  }

  /** Fire-and-forget auto-title: once the transcript holds the first user
   *  message plus the first agent response, asks the workspace's
   *  suggestion model for a 3-4 word title and persists it. Only agents
   *  still carrying the create() placeholder are eligible (a custom
   *  create-time title or an already applied suggestion opts out). Never
   *  throws and never blocks the message path -- failures simply leave the
   *  placeholder in place and retry on the next titlable event. */
  private maybeAutoTitle(agentId: string, timeline: TimelineItem[], allowUserOnly = false): void {
    const sources = collectTitleSources(timeline);
    if (sources.length === 0) return;
    if (sources.length === 1 && !allowUserOnly) return;
    const agent = this.repositories.agents.get(agentId);
    if (!agent || agent.archivedAt) return;
    if (agent.titleOverridden || agent.title !== DEFAULT_AGENT_TITLE) return;
    if (this.titleSuggestions.has(agentId)) return;
    this.titleSuggestions.add(agentId);
    void (async () => {
      try {
        let model: string | undefined;
        let thinkingLevel: string | undefined;
        let titlePrompt = "";
        try {
          const config = this.getSuggestConfig?.(agent.workspaceId);
          model = config?.model?.trim() || undefined;
          thinkingLevel = config?.thinkingLevel?.trim() || undefined;
          titlePrompt = config?.titlePrompt ?? "";
        } catch { model = undefined; thinkingLevel = undefined; titlePrompt = ""; }
        let cwd: string | undefined;
        try { cwd = this.repositories.workspaces.get(agent.workspaceId)?.cwd; } catch { cwd = undefined; }
        const title = await this.titleSuggester.suggestTitle(sources, cwd, model, thinkingLevel, titlePrompt);
        if (!title) return;
        const current = this.repositories.agents.get(agentId);
        if (!current || current.archivedAt || current.titleOverridden || current.title !== DEFAULT_AGENT_TITLE) return;
        this.repositories.agents.updateTitle(agentId, title);
        const status = (this.repositories.agents.get(agentId)?.lastKnownStatus as AgentStatus) ?? "idle";
        this.emit({ agentId, type: "title", status, payload: { title } });
      } catch {} finally {
        this.titleSuggestions.delete(agentId);
      }
    })();
  }

  /** Validates and writes file uploads into the shared attachment cache. */
  private async storeUploads(agentId: string, files?: AgentFile[]): Promise<UserFileRef[] | undefined> {
    this.requireAgent(agentId);
    if (!files?.length) return undefined;
    const validated = files.map((file) => agentFileSchema.parse(file));
    const refs = await Promise.all(validated.map((file) => this.attachmentCache.storeFile(file)));
    return refs.length ? refs : undefined;
  }

  /** Raw bytes for one cached image, for the image download route. Touches the entry for LRU. */
  async imageBytes(agentId: string, hash: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    this.requireAgent(agentId);
    const cached = await this.attachmentCache.read(hash);
    if (!cached || cached.kind !== "image") throw new AgentError("not-found", "image not found");
    return { bytes: cached.bytes, mimeType: cached.mimeType };
  }

  /** Raw bytes for one cached file attachment, for the file download route. Touches the entry for LRU. */
  async fileBytes(agentId: string, hash: string): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }> {
    this.requireAgent(agentId);
    const cached = await this.attachmentCache.read(hash);
    if (!cached || cached.kind !== "file") throw new AgentError("not-found", "file not found");
    return { bytes: cached.bytes, mimeType: safeAttachmentContentType(cached.mimeType), filename: cached.name };
  }

  /** Bumped whenever a `TranscriptState` instance is replaced outright (cold
   *  seed, daemon restart, or an explicit reset) so a reconnecting client can
   *  tell "the whole timeline actually changed, replace it" apart from
   *  "nothing changed but the metadata, merge it" -- see `AgentHistory.transcriptEpoch`.
   *  The counter starts near `Date.now()` (not 0) specifically so a fresh
   *  daemon process is exceedingly unlikely to reuse a value a client
   *  remembers from before a restart. */
  private bumpEpoch(agentId: string): void {
    this.epochCounter += 1;
    this.transcriptEpochs.set(agentId, this.epochCounter);
  }

  private currentEpoch(agentId: string): number {
    return this.transcriptEpochs.get(agentId) ?? 0;
  }

  private resetTranscript(agentId: string): void {
    this.transcripts.delete(agentId);
    this.transcriptSeeds.delete(agentId);
    this.bumpEpoch(agentId);
    const status = (this.repositories.agents.get(agentId)?.lastKnownStatus as AgentStatus) ?? "idle";
    this.emit({ agentId, type: "transcript_reset", status, payload: {} });
  }

  private emit(event: AgentServiceEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  /** Never-throw Git invalidation fan-out: a broken callback must not fail
   *  the serialized agent event chain. */
  private notifyWorkspaceGitChanged(workspaceId: string): void {
    try {
      this.onWorkspaceGitChanged?.(workspaceId);
    } catch {}
  }

  private requireWorkspace(workspaceId: string) {
    const workspace = this.repositories.workspaces.get(workspaceId);
    if (!workspace) throw new AgentError("not-found", "workspace not found");
    if (workspace.archivedAt) throw new AgentError("archived", "workspace archived");
    return workspace;
  }

  private requireAgent(agentId: string): Agent {
    if (!ID.test(agentId)) throw new AgentError("invalid-input", "invalid agent id");
    const agent = this.repositories.agents.get(agentId);
    if (!agent) throw new AgentError("not-found", "agent not found");
    if (agent.archivedAt) throw new AgentError("archived", "agent archived");
    return agent;
  }

  private rejectWhileStopping(agent: Agent): void {
    if (agent.lastKnownStatus === "stopping") {
      throw new AgentError("invalid-input", "agent cancellation is in progress");
    }
  }

  private async ensureProcess(agentId: string): Promise<PiProcessHandle> {
    this.requireAgent(agentId);
    // A prompt/steer/etc. racing create()'s background boot must run after
    // it (the old await-create ordering), not beside its trailing
    // reconcile -- otherwise the stale get_state read flips the just-set
    // running status back to idle and clears runStartedAt.
    await this.awaitPendingStart(agentId);
    let process = this.manager.get(agentId);
    if (!process) {
      // Not `{ admitted: true }`: this is a lazy spawn, so it goes through
      // start()'s own admission gate. That is the only enforcement point
      // capabilities()/history() (which never call assertAdmissionOpen()
      // themselves, since they must keep serving reads against an already
      // -live process while draining) need to refuse spawning a fresh Pi
      // process instead of silently bypassing the gate.
      await this.start(agentId);
      process = this.manager.get(agentId);
    }
    if (!process) throw new AgentError("not-running", "agent process could not be started");
    const subscription = this.subscriptions.get(agentId);
    if (subscription?.generation !== process.generation) {
      logger("agent").warn("Agent process has no event subscription", {
        event: "agent.process_unsubscribed",
        agentId,
        generation: process.generation,
      });
    }
    return process;
  }

  private requireProcess(agentId: string): PiProcessHandle {
    this.requireAgent(agentId);
    const process = this.manager.get(agentId);
    if (!process) throw new AgentError("not-running", "agent process is not running");
    return process;
  }

  private sessionDirectory(agentId: string): string {
    return join(this.sessionsRoot, agentId);
  }

  private validateMessage(value: string): void {
    if (!value || encoder.encode(value).byteLength > MAX_MESSAGE_BYTES) throw new AgentError("invalid-input", "invalid message");
  }

  private validateShortValue(value: string, name: string): void {
    if (!value.trim() || value.length > MAX_SHORT_VALUE_LENGTH) throw new AgentError("invalid-input", `invalid ${name}`);
  }

  private rememberRevision(agentId: string, revision: AgentHistory["revision"]): void {
    this.remember(this.previousRevisions, agentId, revision);
  }

  private remember<T>(entries: Map<string, T>, key: string, value: T): void {
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > MAX_LIST) entries.delete(entries.keys().next().value!);
  }
}
