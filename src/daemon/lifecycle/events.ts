import { ReplayBuffer, type ReplayResult } from "../replay/index.ts";
import {
  DAEMON_SNAPSHOT_SUBJECT,
  daemonChangedPayloadSchema,
  eventEnvelopeSchema,
  PROTOCOL_VERSION,
  type DaemonChangedPayload,
  type EventEnvelope,
} from "../../shared/protocol/index.ts";

const DEFAULT_MAX_LISTENERS = 256;

export type DaemonEventListener = (event: EventEnvelope) => void;
export type DaemonEventHubOptions = {
  maxListeners?: number;
  replay?: { maxEntries?: number; maxBytes?: number };
};
export type DaemonEventSubscription = {
  replay: ReplayResult<EventEnvelope>;
  activate: () => void;
  unsubscribe: () => boolean;
};

/** Fan-out for daemon lifecycle invalidations (drain begin/cancel,
 *  readiness changes) over the existing `/ws` multiplex, on the single
 *  well-known `DAEMON_SNAPSHOT_SUBJECT`. Mirrors `WorkspaceEventHub`'s
 *  sequencing, bounded replay, and `snapshot-required` semantics, but
 *  there is exactly one subject -- there is exactly one daemon. Payloads
 *  are invalidation-only; receivers refetch `GET /api/daemon/snapshot`. */
export class DaemonEventHub {
  private readonly listeners = new Set<DaemonEventListener>();
  private readonly replay: ReplayBuffer;
  private readonly maxListeners: number;
  private sequence = 0;
  private disposed = false;

  constructor(options: DaemonEventHubOptions = {}) {
    this.maxListeners = options.maxListeners ?? DEFAULT_MAX_LISTENERS;
    if (!Number.isSafeInteger(this.maxListeners) || this.maxListeners < 1) throw new Error("Event hub limits must be positive integers");
    this.replay = new ReplayBuffer({ maxSubjects: 1, ...options.replay });
  }

  /** Publish a `daemon-changed` invalidation. Never throws; an invalid
   *  payload is dropped so the caller (a lifecycle transition) is never
   *  blocked by wire concerns. */
  emit(payload: DaemonChangedPayload): EventEnvelope | null {
    if (this.disposed) return null;
    const parsed = daemonChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) return null;
    const sequence = this.sequence + 1;
    const envelope = eventEnvelopeSchema.safeParse({
      version: PROTOCOL_VERSION,
      stream: "daemon",
      subjectId: DAEMON_SNAPSHOT_SUBJECT,
      sequence,
      type: "daemon-changed",
      payload: parsed.data,
    });
    if (!envelope.success) return null;
    this.sequence = sequence;
    this.replay.append(envelope.data);
    for (const listener of [...this.listeners]) {
      try { listener(envelope.data); } catch { /* listener isolation */ }
    }
    return envelope.data;
  }

  subscribe(afterSequence: number, listener: DaemonEventListener): DaemonEventSubscription {
    if (this.disposed) throw new Error("Event hub is disposed");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative safe integer");
    if (this.listeners.size >= this.maxListeners) throw new Error("maximum event listeners reached");
    const currentSequence = this.currentSequence();
    const replay = afterSequence === currentSequence
      ? { kind: "replay" as const, events: [] }
      : this.replay.replay("daemon", DAEMON_SNAPSHOT_SUBJECT, afterSequence);
    const pending: EventEnvelope[] = [];
    let active = false;
    const bufferedListener: DaemonEventListener = (event) => {
      if (active) listener(event);
      else pending.push(event);
    };
    this.listeners.add(bufferedListener);
    return {
      replay,
      activate: () => {
        if (active) return;
        active = true;
        for (const event of pending.splice(0)) {
          try { listener(event); } catch {}
        }
      },
      unsubscribe: () => this.listeners.delete(bufferedListener),
    };
  }

  currentSequence(): number { return this.sequence; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.replay.clear();
  }
}

export type { EventEnvelope };
