import {
  timelineItemPayloadSchema,
  type AgentCapabilities,
  type AgentHistory,
  type AgentSummary,
} from "../shared/domain/agents.ts";
import type { EventEnvelope } from "../shared/protocol/index.ts";
import type { AgentSocket, AgentSocketState } from "./agentSocket.ts";
import type { ConnectionHealth } from "./socketLifecycle.ts";
import { computeIsMobile } from "./app/appHelpers.tsx";
import { applyRowUpsert, applyUsageEvent } from "./lib/transcript-apply.ts";

/**
 * Background keep-alive for recently viewed agents.
 *
 * Only the active pane per split group mounts an `AgentSessionPanel` (see
 * `SplitCanvas`), so switching tabs used to tear down the agent's `pi`
 * socket and drop its in-memory timeline -- the next visit paid a full
 * REST reload (`agent` + 20-row `history` + blocking `capabilities`) plus a
 * replay gap on a fresh socket. This store keeps the last N non-visible
 * agents warm instead: one `subscribeAgent` socket each (reusing the
 * existing per-agent socket helper, no multiplex protocol change) plus a
 * cached `{ summary, history, capabilities }` snapshot that the panel
 * hydrates from on mount for an instant paint.
 *
 * Cost model (measured envelope sizes, `bun -e` scratch):
 * - Idle agent: heartbeat only, ~110 B ping + ~74 B ack per second per
 *   socket ~= 0.6 MB/hour/socket. Desktop N=8 ~= 5 MB/hour; mobile N=3
 *   ~= 2 MB/hour. Zero event traffic while the agent is idle.
 * - Running agent: `message_update` deltas are ~280 B each; 10/s of active
 *   streaming ~= 2.7 KB/s (~0.16 MB/min). `row_upsert`s are ~0.7 KB for
 *   text rows, up to 32 KB for truncated tool results
 *   (`MAX_WIRE_ROW_BYTES`). Worst case with several agents running at once
 *   is a few MB/min -- fine on LAN/WiFi, which is why mobile keeps a
 *   smaller N. Daemon caps (32 subs/socket, 256 subjects, 1024 listeners
 *   per hub) are nowhere near N=8.
 * - Memory per cached agent is one 20-row history page + summary (~100s of
 *   KB); N=8 is a few MB at most, and socket-less data is capped at
 *   `KEEP_ALIVE_CACHE_MAX` entries.
 *
 * Ownership: exactly one live socket per agent. The visible panel owns its
 * socket while mounted (`take()` stops the background one); on unmount it
 * hands state back (`handOff()` restarts the background one from the last
 * applied sequence, so the daemon replays only the handoff gap). Background
 * deltas update the cached snapshot only -- no React state, no re-render --
 * except status/runStartedAt/attention transitions, which are forwarded to
 * `onAgentChanged` so tab-strip dots stay fresh. Title updates stay
 * cache-only: forwarding them would invoke the unmounted panel's
 * `onAgentChanged` render closure (stale `agents`/`layout`) and clobber
 * newer layout state.
 */

export const KEEP_ALIVE_DESKTOP_LIMIT = 8;
export const KEEP_ALIVE_MOBILE_LIMIT = 3;
/** Socket-less snapshots retained beyond the live-subscription budget, so a
 *  revisit still paints instantly and reconciles via REST. Data is cheap;
 *  sockets (heartbeats, iOS suspend churn) are the budgeted resource. */
export const KEEP_ALIVE_CACHE_MAX = 32;

export function keepAliveLimit(isMobile?: boolean): number {
  let mobile = isMobile;
  if (mobile === undefined) {
    try {
      mobile = computeIsMobile();
    } catch {
      mobile = false;
    }
  }
  return mobile ? KEEP_ALIVE_MOBILE_LIMIT : KEEP_ALIVE_DESKTOP_LIMIT;
}

export type KeepAliveSnapshot = {
  agent: AgentSummary;
  history?: AgentHistory;
  capabilities?: AgentCapabilities;
  nextBefore?: number;
  /** Last `pi` stream sequence applied to this snapshot. */
  sequence: number;
  /** True when the background socket fell behind (replay gap) or saw a
   *  `settled`/`transcript_reset` -- the next foreground mount reconciles
   *  via REST as usual. */
  stale: boolean;
};

export type KeepAliveHandOff = Omit<KeepAliveSnapshot, "stale"> & {
  onAgentChanged?: (agent: AgentSummary) => void;
};

/** Structural mirror of `subscribeAgent` (kept `import type`-only on purpose:
 *  this module must never evaluate the real socket helper itself. The
 *  transport is injected by the owner -- `AgentSessionPanel` passes its own
 *  `subscribeAgent` import, which is also what test `mock.module` stubs
 *  replace. Capturing the real binding here would pin it in bun's shared
 *  test-module registry ahead of those mocks and open real sockets.) */
export type SubscribeFn = (
  agentId: string,
  onMessage: (value: EventEnvelope | unknown, state: AgentSocketState) => void,
  onReconcile: () => Promise<void>,
  onHealthChange?: (health: ConnectionHealth) => void,
  initialSequence?: number,
) => AgentSocket;

type Entry = {
  snapshot: KeepAliveSnapshot;
  socket?: AgentSocket;
  onAgentChanged?: (agent: AgentSummary) => void;
};

function summaryChanged(current: AgentSummary, next: AgentSummary): boolean {
  return (
    current.status !== next.status ||
    current.runStartedAt !== next.runStartedAt ||
    current.title !== next.title ||
    JSON.stringify(current.pendingUiRequest ?? null) !== JSON.stringify(next.pendingUiRequest ?? null)
  );
}

/** Statuses after which the daemon drops `runStartedAt` (`endRun` in
 *  `AgentService.updateStatus`); settled envelopes omit the field, so the
 *  merge below must clear the cached value instead of keeping it forever. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["idle", "error", "interrupted", "archived"]);

export class AgentKeepAliveStore {
  private readonly entries = new Map<string, Entry>();
  /** Bumped by every `prune()`/`clear()` (workspace switch, logout). A
   *  `handOff()` from a panel unmounting late -- after the switch already
   *  pruned -- must not resurrect an old-workspace socket or evict the new
   *  workspace's entries, so handoffs whose workspace no longer matches are
   *  dropped outright once any prune has run. */
  private workspaceGeneration = 0;
  private activeWorkspace: string | undefined;

  constructor(private readonly subscribe: SubscribeFn) {}

  /** Live background sockets (budgeted). */
  liveCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.socket) count += 1;
    return count;
  }

  /** All retained agent ids, oldest first. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** Side-effect-free read for panel hydration. */
  peek(agentId: string): KeepAliveSnapshot | undefined {
    return this.entries.get(agentId)?.snapshot;
  }

  /**
   * Claim an agent for foreground display: stops its background socket and
   * removes the entry (the mounted panel owns the socket from here). The
   * returned snapshot carries the resume sequence for `subscribeAgent`.
   */
  take(agentId: string): KeepAliveSnapshot | undefined {
    const entry = this.entries.get(agentId);
    if (!entry) return undefined;
    entry.socket?.close();
    this.entries.delete(agentId);
    return entry.snapshot;
  }

  /**
   * Park a just-unmounted agent in the background: retains its snapshot and
   * (budget permitting) restarts a live socket from its last sequence.
   * Insertion order is MRU -- the just-handed-off agent is newest, and the
   * oldest live socket is parked first when over budget. Cross-workspace
   * entries are dropped so old-workspace sockets never linger.
   */
  handOff(agentId: string, handOff: KeepAliveHandOff, limit: number = keepAliveLimit()): void {
    const safeLimit = Number.isSafeInteger(limit) && limit >= 0 ? limit : KEEP_ALIVE_DESKTOP_LIMIT;
    if (this.workspaceGeneration > 0 && handOff.agent.workspaceId !== this.activeWorkspace) return;
    this.entries.get(agentId)?.socket?.close();
    this.entries.delete(agentId);
    for (const [id, entry] of this.entries) {
      if (entry.snapshot.agent.workspaceId !== handOff.agent.workspaceId) {
        entry.socket?.close();
        this.entries.delete(id);
      }
    }
    const { onAgentChanged, ...rest } = handOff;
    this.entries.set(agentId, {
      snapshot: { ...rest, stale: false },
      onAgentChanged,
    });
    // Shed down to the budget when it shrank, oldest first.
    while (this.liveCount() > safeLimit) {
      const oldest = [...this.entries.values()].find((entry) => entry.socket);
      if (!oldest) break;
      oldest.socket?.close();
      oldest.socket = undefined;
    }
    // The just-handed-off agent is MRU, so it takes priority for a slot:
    // park the oldest live socket to make room for it.
    const entry = this.entries.get(agentId);
    if (entry && !entry.socket && safeLimit > 0) {
      while (this.liveCount() >= safeLimit) {
        const oldest = [...this.entries.values()].find((candidate) => candidate.socket);
        if (!oldest) break;
        oldest.socket?.close();
        oldest.socket = undefined;
      }
      if (this.liveCount() < safeLimit) {
        entry.socket = this.subscribe(
          agentId,
          (value, state) => this.onEvent(agentId, value, state),
          () => this.onGap(agentId),
          undefined,
          handOff.sequence,
        );
      }
    }
    while (this.entries.size > KEEP_ALIVE_CACHE_MAX) {
      const oldestParked = [...this.entries.entries()].find(([, entry]) => !entry.socket);
      const victim = oldestParked?.[0] ?? this.entries.keys().next().value;
      if (victim === undefined || victim === agentId) break;
      this.entries.get(victim)?.socket?.close();
      this.entries.delete(victim);
    }
  }

  /** Drop every entry from other workspaces (workspace switch) and arm the
   *  generation guard so late handoffs from the old workspace are refused. */
  prune(workspaceId: string | undefined): void {
    this.workspaceGeneration += 1;
    this.activeWorkspace = workspaceId;
    for (const [id, entry] of this.entries) {
      if (entry.snapshot.agent.workspaceId !== workspaceId) {
        entry.socket?.close();
        this.entries.delete(id);
      }
    }
  }

  clear(): void {
    this.workspaceGeneration += 1;
    this.activeWorkspace = undefined;
    for (const entry of this.entries.values()) entry.socket?.close();
    this.entries.clear();
  }

  private onGap(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (entry) entry.snapshot.stale = true;
    // No REST refresh in the background: the next foreground mount always
    // reconciles, and the cached timeline stays usable as-is.
    return Promise.resolve();
  }

  private onEvent(agentId: string, value: EventEnvelope | unknown, state: AgentSocketState): void {
    const entry = this.entries.get(agentId);
    if (!entry) return;
    entry.snapshot.sequence = state.sequence;
    const payload =
      value !== null && typeof value === "object" && "payload" in value &&
        typeof (value as { payload?: unknown }).payload === "object"
        ? ((value as { payload: Record<string, unknown> }).payload as Record<string, unknown>)
        : undefined;
    const runStartedAt =
      typeof payload?.runStartedAt === "number" &&
        Number.isSafeInteger(payload.runStartedAt) &&
        (payload.runStartedAt as number) > 0
        ? (payload.runStartedAt as number)
        : undefined;
    if (state.status || runStartedAt !== undefined) {
      const next: AgentSummary = {
        ...entry.snapshot.agent,
        ...(state.status ? { status: state.status } : {}),
        ...(runStartedAt !== undefined ? { runStartedAt } : {}),
      };
      if (state.status && TERMINAL_STATUSES.has(state.status)) delete next.runStartedAt;
      if (summaryChanged(entry.snapshot.agent, next)) {
        entry.snapshot.agent = next;
        entry.onAgentChanged?.(next);
      }
    }
    if (value !== null && typeof value === "object" && "type" in value) {
      const type = (value as { type?: unknown }).type;
      if (typeof type === "string") {
        if (type === "attention" && payload?.id) {
          const next: AgentSummary = { ...entry.snapshot.agent, pendingUiRequest: payload };
          if (summaryChanged(entry.snapshot.agent, next)) {
            entry.snapshot.agent = next;
            entry.onAgentChanged?.(next);
          }
        } else if (
          type === "settled" ||
          type === "agent_settled" ||
          (state.status && state.status !== "needs-attention")
        ) {
          if (entry.snapshot.agent.pendingUiRequest !== undefined) {
            const next: AgentSummary = { ...entry.snapshot.agent, pendingUiRequest: undefined };
            entry.snapshot.agent = next;
            entry.onAgentChanged?.(next);
          }
        }
        if (type === "settled" || type === "agent_settled" || type === "transcript_reset") {
          entry.snapshot.stale = true;
        }
        if (type === "title" && payload && typeof payload.title === "string" && payload.title.trim()) {
          const title = payload.title.trim().slice(0, 256);
          // Cache-only by design: forwarding would run the unmounted
          // panel's `onAgentChanged` render closure against a stale layout
          // (see module doc). The tab label re-syncs on the next visit via
          // the mount load's `updateAgent` path.
          if (entry.snapshot.agent.title !== title) {
            entry.snapshot.agent = { ...entry.snapshot.agent, title };
          }
        }
        if (type === "row_upsert" && payload) {
          const parsed = timelineItemPayloadSchema.safeParse(payload.row);
          if (parsed.success) {
            entry.snapshot.history = applyRowUpsert(entry.snapshot.history, parsed.data);
          }
        } else {
          const nextHistory = applyUsageEvent(entry.snapshot.history, payload);
          if (nextHistory) entry.snapshot.history = nextHistory;
        }
      }
    }
  }
}

/** Process-wide keep-alive. Created and exported by `AgentSessionPanel` (which
 *  injects its own `subscribeAgent` import); `useWorkspaceResources` imports
 *  that same instance for workspace-switch pruning. */
