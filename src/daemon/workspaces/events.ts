import { ReplayBuffer, type ReplayResult } from "../replay/index.ts";
import {
  eventEnvelopeSchema,
  filesChangedPayloadSchema,
  gitStatusChangedPayloadSchema,
  opaqueIdSchema,
  PROTOCOL_VERSION,
  workspaceActionsChangedPayloadSchema,
  type EventEnvelope,
  type FilesChangedPayload,
  type GitStatusChangedPayload,
  type WorkspaceActionsChangedPayload,
} from "../../shared/protocol/index.ts";

const DEFAULT_MAX_SUBJECTS = 256;
const DEFAULT_MAX_LISTENERS = 1024;

export type WorkspaceEventListener = (event: EventEnvelope) => void;
export type WorkspaceEventHubOptions = {
  maxSubjects?: number;
  maxListeners?: number;
  replay?: { maxEntries?: number; maxBytes?: number };
};
export type WorkspaceEventSubscription = {
  replay: ReplayResult<EventEnvelope>;
  activate: () => void;
  unsubscribe: () => boolean;
};

type SubjectState = Set<WorkspaceEventListener>;

/** Fan-out for workspace-scoped invalidations (e.g. `files-changed`) over the
 *  existing `/ws` multiplex. Mirrors `AgentEventHub` sequencing, bounded
 *  replay, and `snapshot-required` semantics, but events are emitted
 *  explicitly by HTTP route handlers after each mutation rather than
 *  forwarded from a service. Payloads are invalidation-only; receivers
 *  refetch authoritative HTTP snapshots. */
export class WorkspaceEventHub {
  private readonly listeners = new Map<string, SubjectState>();
  private readonly sequences = new Map<string, number>();
  private readonly replay: ReplayBuffer;
  private readonly maxSubjects: number;
  private readonly maxListeners: number;
  private listenerCount = 0;
  private disposed = false;

  constructor(options: WorkspaceEventHubOptions = {}) {
    this.maxSubjects = options.maxSubjects ?? DEFAULT_MAX_SUBJECTS;
    this.maxListeners = options.maxListeners ?? DEFAULT_MAX_LISTENERS;
    if (![this.maxSubjects, this.maxListeners].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Event hub limits must be positive integers");
    this.replay = new ReplayBuffer({ maxSubjects: this.maxSubjects, ...options.replay });
  }

  /** Publish a `files-changed` invalidation for a workspace. Never throws;
   *  invalid payloads are dropped so HTTP mutations always succeed. */
  emit(payload: FilesChangedPayload): EventEnvelope | null {
    const parsed = filesChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) return null;
    return this.publish(parsed.data.workspaceId, "files-changed", parsed.data);
  }

  /** Publish a `git-status-changed` invalidation for a workspace. Never
   *  throws; invalid payloads are dropped so HTTP mutations always succeed. */
  emitGitStatus(payload: GitStatusChangedPayload): EventEnvelope | null {
    const parsed = gitStatusChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) return null;
    return this.publish(parsed.data.workspaceId, "git-status-changed", parsed.data);
  }

  /** Publish an `actions-changed` invalidation for a workspace action run.
   *  Never throws; invalid payloads are dropped so HTTP mutations always
   *  succeed. Receivers refetch the run snapshot over HTTP. */
  emitActionsChanged(payload: WorkspaceActionsChangedPayload): EventEnvelope | null {
    const parsed = workspaceActionsChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) return null;
    return this.publish(parsed.data.workspaceId, "actions-changed", parsed.data);
  }

  private publish(workspaceId: string, type: string, payload: unknown): EventEnvelope | null {
    if (this.disposed) return null;
    if (!this.sequences.has(workspaceId) && this.sequences.size >= this.maxSubjects) return null;
    const sequence = (this.sequences.get(workspaceId) ?? 0) + 1;
    this.sequences.set(workspaceId, sequence);
    const envelope = eventEnvelopeSchema.safeParse({
      version: PROTOCOL_VERSION,
      stream: "workspace",
      subjectId: workspaceId,
      sequence,
      type,
      payload,
    });
    if (!envelope.success) return null;
    this.replay.append(envelope.data);
    for (const listener of [...(this.listeners.get(workspaceId) ?? [])]) {
      try { listener(envelope.data); } catch { /* listener isolation */ }
    }
    return envelope.data;
  }

  subscribe(workspaceId: string, afterSequence: number, listener: WorkspaceEventListener): WorkspaceEventSubscription {
    if (this.disposed) throw new Error("Event hub is disposed");
    opaqueIdSchema.parse(workspaceId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative safe integer");
    if (!this.listeners.has(workspaceId) && this.listeners.size >= this.maxSubjects) throw new Error("maximum event subjects reached");
    if (this.listenerCount >= this.maxListeners) throw new Error("maximum event listeners reached");
    const currentSequence = this.currentSequence(workspaceId);
    const replay = afterSequence === currentSequence
      ? { kind: "replay" as const, events: [] }
      : this.replay.replay("workspace", workspaceId, afterSequence);
    const subject = this.listeners.get(workspaceId) ?? new Set<WorkspaceEventListener>();
    const pending: EventEnvelope[] = [];
    let active = false;
    const bufferedListener: WorkspaceEventListener = (event) => {
      if (active) listener(event);
      else pending.push(event);
    };
    this.listeners.set(workspaceId, subject);
    subject.add(bufferedListener);
    this.listenerCount += 1;
    return {
      replay,
      activate: () => {
        if (active) return;
        active = true;
        for (const event of pending.splice(0)) {
          try { listener(event); } catch {}
        }
      },
      unsubscribe: () => this.removeListener(workspaceId, bufferedListener),
    };
  }

  currentSequence(workspaceId: string): number { return this.sequences.get(workspaceId) ?? 0; }

  removeSubject(workspaceId: string): boolean {
    const subject = this.listeners.get(workspaceId);
    if (subject) { this.listenerCount -= subject.size; this.listeners.delete(workspaceId); }
    this.replay.removeSubject("workspace", workspaceId);
    return this.sequences.delete(workspaceId) || subject !== undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear(); this.sequences.clear(); this.replay.clear(); this.listenerCount = 0;
  }

  private removeListener(workspaceId: string, listener: WorkspaceEventListener): boolean {
    const subject = this.listeners.get(workspaceId);
    if (!subject?.delete(listener)) return false;
    this.listenerCount -= 1;
    if (subject.size === 0) this.listeners.delete(workspaceId);
    return true;
  }
}

export type { EventEnvelope };
