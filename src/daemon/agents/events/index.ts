import type { AgentService, AgentServiceEvent } from "../service.ts";
import { ReplayBuffer, type ReplayResult } from "../../replay/index.ts";
import {
  eventEnvelopeSchema,
  opaqueIdSchema,
  PROTOCOL_VERSION,
  type EventEnvelope,
} from "../../../shared/protocol/index.ts";

const DEFAULT_MAX_SUBJECTS = 256;
const DEFAULT_MAX_LISTENERS = 1024;
const MAX_ERROR_LENGTH = 512;

export type AgentEventListener = (event: EventEnvelope) => void;
export type AgentEventHubOptions = {
  maxSubjects?: number;
  maxListeners?: number;
  replay?: { maxEntries?: number; maxBytes?: number };
};
export type AgentEventSubscription = {
  replay: ReplayResult<EventEnvelope>;
  activate: () => void;
  unsubscribe: () => boolean;
};

type SubjectState = Set<AgentEventListener>;

function boundedError(error: string): string {
  return error.slice(0, MAX_ERROR_LENGTH);
}

export class AgentEventHub {
  private readonly listeners = new Map<string, SubjectState>();
  private readonly sequences = new Map<string, number>();
  private readonly replay: ReplayBuffer;
  private readonly maxSubjects: number;
  private readonly maxListeners: number;
  private listenerCount = 0;
  private disposed = false;
  private readonly unsubscribeService: () => boolean;

  constructor(service: Pick<AgentService, "subscribe">, options: AgentEventHubOptions = {}) {
    this.maxSubjects = options.maxSubjects ?? DEFAULT_MAX_SUBJECTS;
    this.maxListeners = options.maxListeners ?? DEFAULT_MAX_LISTENERS;
    if (![this.maxSubjects, this.maxListeners].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Event hub limits must be positive integers");
    this.replay = new ReplayBuffer({ maxSubjects: this.maxSubjects, ...options.replay });
    this.unsubscribeService = service.subscribe((event) => this.receive(event));
  }

  subscribe(agentId: string, afterSequence: number, listener: AgentEventListener): AgentEventSubscription {
    if (this.disposed) throw new Error("Event hub is disposed");
    opaqueIdSchema.parse(agentId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative safe integer");
    if (!this.listeners.has(agentId) && this.listeners.size >= this.maxSubjects) throw new Error("maximum event subjects reached");
    if (this.listenerCount >= this.maxListeners) throw new Error("maximum event listeners reached");
    const currentSequence = this.currentSequence(agentId);
    const replay = afterSequence === currentSequence
      ? { kind: "replay" as const, events: [] }
      : this.replay.replay("pi", agentId, afterSequence);
    const subject = this.listeners.get(agentId) ?? new Set<AgentEventListener>();
    const pending: EventEnvelope[] = [];
    let active = false;
    const bufferedListener: AgentEventListener = (event) => {
      if (active) listener(event);
      else pending.push(event);
    };
    this.listeners.set(agentId, subject);
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
      unsubscribe: () => this.removeListener(agentId, bufferedListener),
    };
  }

  currentSequence(agentId: string): number { return this.sequences.get(agentId) ?? 0; }

  removeSubject(agentId: string): boolean {
    const subject = this.listeners.get(agentId);
    if (subject) { this.listenerCount -= subject.size; this.listeners.delete(agentId); }
    this.replay.removeSubject("pi", agentId);
    return this.sequences.delete(agentId) || subject !== undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeService();
    this.listeners.clear(); this.sequences.clear(); this.replay.clear(); this.listenerCount = 0;
  }

  private removeListener(agentId: string, listener: AgentEventListener): boolean {
    const subject = this.listeners.get(agentId);
    if (!subject?.delete(listener)) return false;
    this.listenerCount -= 1;
    if (subject.size === 0) this.listeners.delete(agentId);
    return true;
  }

  private receive(event: AgentServiceEvent): void {
    if (this.disposed) return;
    if (!this.sequences.has(event.agentId) && this.sequences.size >= this.maxSubjects) return;
    const sequence = (this.sequences.get(event.agentId) ?? 0) + 1;
    this.sequences.set(event.agentId, sequence);
    const payload: Record<string, unknown> = {
      status: event.status,
      ...(event.payload ?? {}),
    };
    if (event.generation !== undefined && Number.isSafeInteger(event.generation) && event.generation >= 0) payload.generation = event.generation;
    if (event.error) payload.error = boundedError(event.error);
    try {
      const envelope = eventEnvelopeSchema.parse({ version: PROTOCOL_VERSION, stream: "pi", subjectId: event.agentId, sequence, type: event.type, payload });
      this.replay.append(envelope);
      for (const listener of [...(this.listeners.get(event.agentId) ?? [])]) {
        try { listener(envelope); } catch { /* listener isolation */ }
      }
    } catch {
      // If parsing fails for any oversized field, deliver minimal safe status event
      try {
        const fallbackEnvelope = eventEnvelopeSchema.parse({
          version: PROTOCOL_VERSION,
          stream: "pi",
          subjectId: event.agentId,
          sequence,
          type: event.type,
          payload: { status: event.status },
        });
        this.replay.append(fallbackEnvelope);
        for (const listener of [...(this.listeners.get(event.agentId) ?? [])]) {
          try { listener(fallbackEnvelope); } catch {}
        }
      } catch {}
    }
  }
}

export type { EventEnvelope };
