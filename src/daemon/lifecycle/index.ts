import { MAX_DAEMON_BLOCKERS_LISTED, type DaemonBlocker, type DaemonLifecycleSnapshot, type DaemonPhase } from "../../shared/protocol/index.ts";

export type { DaemonBlocker, DaemonPhase };

export type DaemonLifecycleOptions = {
  /** Cheap, synchronous, in-memory-only blocker pass. Safe to call on every
   *  agent-service event; used only to revoke a `ready` phase the instant
   *  new activity is observed, never to grant it. */
  listQuickBlockers: () => DaemonBlocker[];
  /** Authoritative blocker pass: the quick pass plus one bounded `get_state`
   *  probe against every remaining live agent, so readiness is never
   *  granted purely from cached in-memory flags (see `AgentService`). */
  listBlockers: () => Promise<DaemonBlocker[]>;
  /** Called whenever the phase actually changes, for the daemon to publish
   *  a `daemon-changed` invalidation. Never throws by contract. */
  onPhaseChanged?: (phase: DaemonPhase) => void;
};

export type CommitIdentity = { instanceId?: string; drainId?: string | null; readinessRevision?: number };
export type CommitResult = { committed: true } | { committed: false; reason: "not-ready" | "stale" };

/** One daemon lifecycle controller (`running -> draining -> ready ->
 *  `running` on cancel, back to `draining` on new activity; see AGENTS.md
 *  Pi process ownership): `ready -> stopping` only through `commit()`;
 *  any phase can jump straight to `stopping` through `forceStop()`.
 *  `stopping` is terminal -- there is no cancel from it. Phase is daemon
 *  memory
 *  only -- it does not survive a crash or restart, and every readiness
 *  decision is recomputed from live agent state, never trusted from a
 *  prior snapshot. */
export class DaemonLifecycle {
  readonly instanceId = crypto.randomUUID();
  private phase: DaemonPhase = "running";
  private drainId_: string | null = null;
  private readinessRevision_ = 0;
  private recomputing = false;
  private recomputeQueued = false;
  private readonly phaseWaiters = new Set<() => void>();
  private readonly listQuickBlockers: () => DaemonBlocker[];
  private readonly listBlockers: () => Promise<DaemonBlocker[]>;
  private readonly onPhaseChanged?: (phase: DaemonPhase) => void;

  constructor(options: DaemonLifecycleOptions) {
    this.listQuickBlockers = options.listQuickBlockers;
    this.listBlockers = options.listBlockers;
    this.onPhaseChanged = options.onPhaseChanged;
  }

  get currentPhase(): DaemonPhase { return this.phase; }
  get readinessRevision(): number { return this.readinessRevision_; }
  get drainId(): string | null { return this.drainId_; }

  /** Synchronous admission gate: `AgentService` consults this at the top of
   *  every new-work entry point (create/prompt/steer/follow-up/compact/
   *  model/thinking/explicit start), and again before lazily spawning a Pi
   *  process for a read. Closing on `beginDrain()` is itself synchronous --
   *  there is no window where a call after that point can still observe
   *  `running`. */
  isAdmissionOpen(): boolean { return this.phase === "running"; }

  /** Idempotent: already draining/ready is left alone. Synchronous state
   *  change; the (async) readiness recompute is kicked off after. */
  beginDrain(): void {
    if (this.phase !== "running") return;
    this.setPhase("draining");
    this.drainId_ = crypto.randomUUID();
    this.scheduleRecompute();
  }

  /** Reopens admission from `draining` or `ready`. No-op (returns false)
   *  once teardown has begun or if already running. */
  cancelDrain(): boolean {
    if (this.phase !== "draining" && this.phase !== "ready") return false;
    this.setPhase("running");
    this.drainId_ = null;
    return true;
  }

  /** Seals the drain for good: `ready -> stopping`. Rechecks identity (a
   *  stale caller holding an old drainId/instanceId/readinessRevision
   *  cannot authorize exit) and, right before sealing, rechecks blockers
   *  one more time -- late activity between reaching `ready` and this call
   *  invalidates readiness rather than being ignored, and reverts to
   *  `draining` instead of committing over it. Not idempotent-successful:
   *  once truly committed the phase is `stopping` and a second call
   *  reports `not-ready` (stopping is not ready), which is the correct,
   *  safe answer for a duplicate caller -- see the daemon's own shutdown
   *  request dedup for making duplicates not re-run teardown. */
  async commit(identity?: CommitIdentity): Promise<CommitResult> {
    if (identity?.instanceId !== undefined && identity.instanceId !== this.instanceId) return { committed: false, reason: "stale" };
    if (identity?.drainId !== undefined && identity.drainId !== this.drainId_) return { committed: false, reason: "stale" };
    if (identity?.readinessRevision !== undefined && identity.readinessRevision !== this.readinessRevision_) return { committed: false, reason: "stale" };
    if (this.phase !== "ready") return { committed: false, reason: "not-ready" };
    const blockers = await this.listBlockers();
    if (blockers.length > 0) {
      if (this.phase === "ready") this.setPhase("draining");
      this.scheduleRecompute();
      return { committed: false, reason: "not-ready" };
    }
    // Re-check after the async gap: a concurrent cancelDrain() could have
    // run while the recheck above was in flight.
    if (this.phase !== "ready") return { committed: false, reason: "not-ready" };
    this.setPhase("stopping");
    return { committed: true };
  }

  /** Explicit, clearly-labeled interruption: jumps straight to `stopping` from any phase, seals admission, and
   *  cancels active work -- the caller still owns actually stopping
   *  processes/escalating the process tree; this only flips the phase.
   *  Idempotent. */
  forceStop(): void {
    if (this.phase === "stopping") return;
    this.setPhase("stopping");
  }

  /** Resolves once after the next phase change, however it happens
   *  (activity revoking `ready`, the async recompute granting it, cancel,
   *  commit, or force). Purely event-driven -- no polling, no timer, and
   *  therefore no deadline of its own. */
  waitForNextPhaseChange(): Promise<void> {
    return new Promise((resolve) => { this.phaseWaiters.add(resolve); });
  }

  /** Call after every agent-service event. Cheap and synchronous: it can
   *  only move `ready` back to `draining` (new/observed activity revokes
   *  readiness), and it kicks off the authoritative async recompute while
   *  draining. It never grants `ready` by itself. */
  onActivity(): void {
    if (this.phase === "ready" && this.listQuickBlockers().length > 0) {
      this.setPhase("draining");
    }
    if (this.phase === "draining") this.scheduleRecompute();
  }

  /** Bounded, wire-shaped snapshot. Blocker rows are capped for transport;
   *  `blockedCount` always reflects the complete set that actually decided
   *  readiness, so a large agent count can never manufacture false
   *  readiness through a truncated page. */
  async snapshot(): Promise<DaemonLifecycleSnapshot> {
    const blockers = this.phase === "draining" || this.phase === "ready" ? await this.listBlockers() : [];
    return {
      phase: this.phase,
      instanceId: this.instanceId,
      drainId: this.drainId,
      readinessRevision: this.readinessRevision_,
      blockedCount: blockers.length,
      blockers: blockers.slice(0, MAX_DAEMON_BLOCKERS_LISTED),
      blockersTruncated: blockers.length > MAX_DAEMON_BLOCKERS_LISTED,
    };
  }

  private setPhase(next: DaemonPhase): void {
    if (this.phase === next) return;
    this.phase = next;
    this.readinessRevision_ += 1;
    try { this.onPhaseChanged?.(next); } catch {}
    for (const waiter of [...this.phaseWaiters]) { try { waiter(); } catch {} }
    this.phaseWaiters.clear();
  }

  /** Coalesced async recompute: at most one `listBlockers()` call in
   *  flight, with at most one more queued behind it (never an unbounded
   *  pile-up from a burst of activity while draining). Only grants `ready`;
   *  `onActivity()` is what revokes it promptly. */
  private scheduleRecompute(): void {
    if (this.recomputing) { this.recomputeQueued = true; return; }
    this.recomputing = true;
    void this.listBlockers()
      .then((blockers) => {
        if (this.phase === "draining" && blockers.length === 0) this.setPhase("ready");
      })
      .catch(() => { /* a failed probe already reports itself as an "unknown" blocker; nothing to grant here */ })
      .finally(() => {
        this.recomputing = false;
        if (this.recomputeQueued) {
          this.recomputeQueued = false;
          this.scheduleRecompute();
        }
      });
  }
}
