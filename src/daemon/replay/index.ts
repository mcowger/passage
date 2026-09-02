import type { EventEnvelope, OpaqueId, Stream } from "../../shared/protocol/index.ts";

export const DEFAULT_REPLAY_MAX_ENTRIES = 256;
export const DEFAULT_REPLAY_MAX_BYTES = 1024 * 1024;
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 1024;
export const DEFAULT_REPLAY_MAX_SUBJECTS = 256;

type Subject = `${Stream}:${OpaqueId}`;
export type ReplayResult<T> = { kind: "replay"; events: T[] } | { kind: "snapshot-required"; subjectId: OpaqueId; stream: Stream };
export type ReplayBufferOptions = { maxEntries?: number; maxBytes?: number; maxSubjects?: number };

function sizeOf(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

export class ReplayBuffer<T extends EventEnvelope = EventEnvelope> {
  private readonly buffers = new Map<Subject, { events: T[]; bytes: number; next: number }>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxSubjects: number;
  constructor(options: ReplayBufferOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_REPLAY_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_REPLAY_MAX_BYTES;
    this.maxSubjects = options.maxSubjects ?? DEFAULT_REPLAY_MAX_SUBJECTS;
    if (![this.maxEntries, this.maxBytes, this.maxSubjects].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Replay limits must be positive integers");
  }
  append(event: T): T {
    const key = `${event.stream}:${event.subjectId}` as Subject;
    let state = this.buffers.get(key);
    if (!state) {
      while (this.buffers.size >= this.maxSubjects) this.buffers.delete(this.buffers.keys().next().value!);
      state = { events: [], bytes: 0, next: 1 }; this.buffers.set(key, state);
    } else { this.buffers.delete(key); this.buffers.set(key, state); }
    if (event.sequence !== state.next) throw new Error("Replay sequence must be strictly monotonic");
    const bytes = sizeOf(event); state.next += 1;
    if (bytes > this.maxBytes) {
      state.events = [];
      state.bytes = 0;
      return event;
    }
    state.events.push(event); state.bytes += bytes;
    while (state.events.length > this.maxEntries || state.bytes > this.maxBytes) state.bytes -= sizeOf(state.events.shift()!);
    return event;
  }
  replay(stream: Stream, subjectId: OpaqueId, afterSequence: number): ReplayResult<T> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("afterSequence must be a non-negative safe integer");
    const state = this.buffers.get(`${stream}:${subjectId}` as Subject);
    if (!state) return { kind: "snapshot-required", stream, subjectId };
    this.buffers.delete(`${stream}:${subjectId}` as Subject); this.buffers.set(`${stream}:${subjectId}` as Subject, state);
    const first = state.events[0]?.sequence ?? state.next;
    if (afterSequence < first - 1 || afterSequence > state.next - 1) return { kind: "snapshot-required", stream, subjectId };
    return { kind: "replay", events: state.events.filter((event) => event.sequence > afterSequence) };
  }
  removeSubject(stream: Stream, subjectId: OpaqueId): boolean { return this.buffers.delete(`${stream}:${subjectId}` as Subject); }
  clear(): void { this.buffers.clear(); }
}

export type IdempotencyCacheOptions = { maxEntries?: number };
export class IdempotencyCache<T> {
  private readonly entries = new Map<string, T>();
  private readonly maxEntries: number;
  constructor(options: IdempotencyCacheOptions = {}) { this.maxEntries = options.maxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES; if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) throw new Error("Cache limit must be positive"); }
  get(requestId: string): T | undefined { const value = this.entries.get(requestId); if (value !== undefined) { this.entries.delete(requestId); this.entries.set(requestId, value); } return value; }
  set(requestId: string, value: T): void { this.entries.delete(requestId); this.entries.set(requestId, value); while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!); }
  has(requestId: string): boolean { return this.entries.has(requestId); }
  get size(): number { return this.entries.size; }
}
