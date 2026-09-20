import type { AgentHistory, AgentStatus } from "../../shared/domain/agents.ts";
import { TranscriptState } from "./transcript/index.ts";
import type { PiProcessHandle } from "./rpc/index.ts";

export type AgentServiceEvent = {
  agentId: string;
  type: "status" | "settled" | "attention" | string;
  status: AgentStatus;
  generation?: number;
  error?: string;
  payload?: Record<string, unknown>;
};

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

export type Cancellation = {
  process: PiProcessHandle;
  generation: number;
};

/**
 * All mutable per-agent runtime bookkeeping: live subscriptions, transcript
 * caches, cancellations, epochs, and transient trackers. Configuration and
 * collaborators (repositories, Pi manager, suggesters) stay on the service;
 * behavior in progress of extraction takes this container instead of the
 * service itself.
 */
export class AgentRuntime {
  readonly listeners = new Set<(event: AgentServiceEvent) => void>();
  readonly subscriptions = new Map<string, RuntimeSubscription>();
  readonly previousRevisions = new Map<string, AgentHistory["revision"]>();
  readonly leaves = new Map<string, string>();
  readonly transcripts = new Map<string, TranscriptState>();
  readonly transcriptSeeds = new Map<string, Promise<TranscriptState>>();
  readonly transcriptEpochs = new Map<string, number>();
  epochCounter = Date.now();
  readonly diagnostics = new Map<string, RuntimeDiagnostic>();
  readonly pendingUiRequests = new Map<string, Record<string, unknown>>();
  readonly cancellations = new Map<string, Cancellation>();
  readonly runStartedAt = new Map<string, number>();
  /** Agents with a compact RPC currently in flight. While set, reconcile
   *  must not promote the killed run's abort tombstone to an error
   *  status/row: the tombstone is expected, and the compaction entry
   *  landing right after it supersedes it. */
  readonly compacting = new Set<string>();
  readonly eventChains = new Map<string, Promise<void>>();
  /** Background boot kicked off by create(): lets the POST return (and the
   *  New Agent pane open) without waiting for Pi spawn + reconcile, while
   *  giving later per-agent operations something to wait on so they keep
   *  the old start-then-operate ordering. Never rejects. */
  readonly pendingStarts = new Map<string, Promise<void>>();
  /** Agents whose current `interrupted` status was caused by a daemon
   *  restart (boot sweep), not by losing a live process mid-life. The
   *  status string alone cannot tell those apart, but the sidebar dot can:
   *  a restart is expected, so it renders neutral grey, while a genuine
   *  mid-life interruption keeps the red attention dot. Populated by
   *  `reconcileAfterRestart` (and by the lazy stale-status sweep when this
   *  daemon never owned a process for the agent); cleared the moment the
   *  agent leaves `interrupted`. In-memory only -- a fresh daemon rebuilds
   *  it from its own boot sweep. */
  readonly restartInterrupted = new Set<string>();
  /** Agents with an auto-title suggestion currently in flight. Guards the
   *  fire-and-forget `maybeAutoTitle` so rapid consecutive user messages
   *  cannot spawn duplicate suggestion runs for the same agent. */
  readonly titleSuggestions = new Set<string>();
}

/** Cap on retained per-agent crash/interruption diagnostics. */
export const MAX_RUNTIME_DIAGNOSTICS = 100;
