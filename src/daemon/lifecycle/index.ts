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

/** One daemon lifecycle controller (docs/BACKTOSQUAREONE.md step 5):
 *  `running -> draining -> ready -> running` (cancel) or `ready -> draining`
 *  (new activity observed). `stopping` is reserved for step 6's commit
 *  path; nothing in this controller transitions into it yet, and `ready`
 *  does not exit the process. Phase is daemon memory only -- it does not
 *  survive a crash or restart, and every readiness decision is recomputed
 *  from live agent state, never trusted from a prior snapshot. */
export class DaemonLifecycle {
  readonly instanceId = crypto.randomUUID();
  private phase: DaemonPhase = "running";
  private drainId: string | null = null;
  private readinessRevision_ = 0;
  private recomputing = false;
  private recomputeQueued = false;
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
    this.drainId = crypto.randomUUID();
    this.scheduleRecompute();
  }

  /** Reopens admission from `draining` or `ready`. No-op (returns false)
   *  once teardown has begun (step 6) or if already running. */
  cancelDrain(): boolean {
    if (this.phase !== "draining" && this.phase !== "ready") return false;
    this.setPhase("running");
    this.drainId = null;
    return true;
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
