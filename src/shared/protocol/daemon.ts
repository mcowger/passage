import { z } from "zod";

/** Well-known subject for daemon lifecycle invalidations (drain begin/
 *  cancel, readiness changes). There is exactly one daemon per Passage
 *  instance, so -- like `WORKSPACES_SNAPSHOT_SUBJECT` -- this is a single
 *  global subject rather than a per-resource one. */
export const DAEMON_SNAPSHOT_SUBJECT = "daemon" as const;

/** `running` accepts new agent work. `draining` has closed admission and is
 *  waiting for admitted agent work to settle. `ready` means every tracked
 *  agent is verified idle -- a safe point to actually stop (step 6; this
 *  step does not exit on `ready`). `stopping` is reserved for step 6's
 *  commit path. Draining is daemon memory, not persisted authority: it does
 *  not survive a crash or restart. */
export const daemonPhaseSchema = z.enum(["running", "draining", "ready", "stopping"]);
export type DaemonPhase = z.infer<typeof daemonPhaseSchema>;

/** Why one agent is not yet idle. `starting`/`cancelling`/`compacting`/
 *  `reconciling` are known in-flight admitted operations; `needs-attention`
 *  is an unanswered extension question (answering it may revoke readiness
 *  again); `running` is a confirmed-active Pi turn; `unknown` is a failed
 *  or lost state probe -- never treated as idle. */
export const daemonBlockerReasonSchema = z.enum([
  "starting", "cancelling", "compacting", "reconciling", "needs-attention", "running", "unknown",
]);
export type DaemonBlockerReason = z.infer<typeof daemonBlockerReasonSchema>;

export const daemonBlockerSchema = z.object({
  agentId: z.string().min(1).max(128),
  reason: daemonBlockerReasonSchema,
}).strict();
export type DaemonBlocker = z.infer<typeof daemonBlockerSchema>;

/** Blocker rows on the wire are capped for transport, independent of the
 *  count actually used to decide readiness -- `blockedCount` always
 *  reflects the complete internal set, never just this page. */
export const MAX_DAEMON_BLOCKERS_LISTED = 50;

/** Lifecycle portion of `GET /api/daemon/snapshot`. No prompts, tool
 *  output, credentials, or raw Pi records -- agent identity and a bounded
 *  reason only. */
export const daemonLifecycleSnapshotSchema = z.object({
  phase: daemonPhaseSchema,
  /** Random per daemon-process boot; lets a client tell "the daemon I was
   *  talking to restarted" apart from "the same daemon changed phase". */
  instanceId: z.string().min(1).max(64),
  /** Random per drain attempt; null while `running`. */
  drainId: z.string().min(1).max(64).nullable(),
  /** Increments on every phase-affecting change. A commit request (step 6)
   *  must recheck this, not assume a previously observed `ready` still
   *  holds. */
  readinessRevision: z.number().int().nonnegative().safe(),
  blockedCount: z.number().int().nonnegative().safe(),
  blockers: z.array(daemonBlockerSchema).max(MAX_DAEMON_BLOCKERS_LISTED),
  blockersTruncated: z.boolean(),
}).strict();
export type DaemonLifecycleSnapshot = z.infer<typeof daemonLifecycleSnapshotSchema>;

export const daemonChangedReasonSchema = z.enum(["drain-begin", "drain-cancel", "readiness-changed"]);
export type DaemonChangedReason = z.infer<typeof daemonChangedReasonSchema>;

/** Invalidation-only payload for `daemon-changed` events on
 *  `DAEMON_SNAPSHOT_SUBJECT`. Receivers refetch `GET /api/daemon/snapshot`;
 *  lifecycle detail never rides the wire event itself. */
export const daemonChangedPayloadSchema = z.object({
  reason: daemonChangedReasonSchema,
}).strict();
export type DaemonChangedPayload = z.infer<typeof daemonChangedPayloadSchema>;

/** `subscribe`/`unsubscribe` payload on the `daemon` WS channel. There is
 *  only ever one subject (`DAEMON_SNAPSHOT_SUBJECT`), so unlike `pi`/
 *  `workspace` there is no subject id to carry. */
export const daemonSubscriptionPayloadSchema = z.object({
  afterSequence: z.number().int().nonnegative().safe().default(0),
}).strict();
export type DaemonSubscriptionPayload = z.infer<typeof daemonSubscriptionPayloadSchema>;
