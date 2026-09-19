import type { DaemonBlocker } from "../../shared/protocol/daemon.ts";
import { responseData, type PiRpcManager } from "./rpc/index.ts";
import { AgentRuntime } from "./runtime.ts";

/** Bound on a drain readiness probe (listBlockers()): short enough that a
 *  hung agent shows up as an "unknown" blocker quickly rather than
 *  stalling every readiness recompute behind it. */
const BLOCKER_PROBE_TIMEOUT_MS = 5_000;

/**
 * Drain-readiness blockers: which agents currently have runtime activity
 * that should hold the daemon out of `ready`. Takes the runtime container
 * and the Pi manager; the cheap synchronous pass plus one bounded
 * get_state probe per live candidate.
 */
export class AgentBlockers {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly manager: PiRpcManager,
  ) {}

  /** Every agentId this service currently has any runtime bookkeeping for:
   *  a live process, an in-flight admitted operation, or a pending
   *  question. Bounded by the manager's live-process cap plus a handful of
   *  transient trackers -- never a full agent-table scan. This is exactly
   *  the set `listQuickBlockers()`/`listBlockers()` need to consider;
   *  anything not in it has no live process and nothing in flight, so it
   *  is trivially idle. */
  private candidateBlockerAgentIds(): Set<string> {
    return new Set<string>([
      ...this.runtime.pendingStarts.keys(),
      ...this.runtime.cancellations.keys(),
      ...this.runtime.compacting,
      ...this.runtime.runStartedAt.keys(),
      ...this.runtime.eventChains.keys(),
      ...this.runtime.pendingUiRequests.keys(),
      ...this.runtime.subscriptions.keys(),
    ]);
  }

  /** Synchronous, in-memory-only reason a single agent is not idle, or
   *  undefined if nothing tracked says otherwise (which does not by itself
   *  mean idle -- see listBlockers()). Never performs I/O. */
  private quickBlockerReason(agentId: string): DaemonBlocker["reason"] | undefined {
    if (this.runtime.pendingStarts.has(agentId)) return "starting";
    if (this.runtime.cancellations.has(agentId)) return "cancelling";
    if (this.runtime.compacting.has(agentId)) return "compacting";
    if (this.runtime.eventChains.has(agentId)) return "reconciling";
    if (this.runtime.pendingUiRequests.has(agentId)) return "needs-attention";
    if (this.manager.get(agentId)?.getPendingUiRequest()) return "needs-attention";
    if (this.runtime.runStartedAt.has(agentId)) return "running";
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
}
