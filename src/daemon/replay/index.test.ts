import { describe, expect, test } from "bun:test";
import { commandEnvelopeSchema, eventEnvelopeSchema, responseSchema, snapshotRequiredSchema, MAX_PROTOCOL_PAYLOAD_BYTES, MAX_PROTOCOL_PAYLOAD_DEPTH, MAX_SNAPSHOT_METADATA_ENTRIES, MAX_SNAPSHOT_METADATA_KEY_LENGTH, MAX_SNAPSHOT_METADATA_VALUE_LENGTH } from "../../shared/protocol/index.ts";
import { IdempotencyCache, ReplayBuffer } from "./index.ts";

const event = (sequence: number, subjectId = "a") => ({ version: 1 as const, stream: "pi" as const, subjectId, sequence, type: "token", payload: { sequence } });
describe("protocol", () => {
  test("validates v1 and rejects malformed/version mismatch", () => {
    expect(commandEnvelopeSchema.safeParse({ version: 1, requestId: "r", channel: "pi", type: "start", payload: {} }).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse({ version: 2, requestId: "r", channel: "pi", type: "start", payload: {} }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...event(1), subjectId: "" }).success).toBe(false);
  });
  test("bounds snapshot metadata and models fallback", () => {
    expect(snapshotRequiredSchema.safeParse({ version: 1, stream: "pi", subjectId: "a", kind: "snapshot-required", metadata: {} }).success).toBe(true);
    const metadata = Object.fromEntries(Array.from({ length: MAX_SNAPSHOT_METADATA_ENTRIES + 1 }, (_, i) => [`k${i}`, "v"]));
    expect(snapshotRequiredSchema.safeParse({ version: 1, stream: "pi", subjectId: "a", kind: "snapshot-required", metadata }).success).toBe(false);
    expect(snapshotRequiredSchema.safeParse({ version: 1, stream: "pi", subjectId: "a", kind: "snapshot-required", metadata: { ["k".repeat(MAX_SNAPSHOT_METADATA_KEY_LENGTH + 1)]: "v" } }).success).toBe(false);
    expect(snapshotRequiredSchema.safeParse({ version: 1, stream: "pi", subjectId: "a", kind: "snapshot-required", metadata: { k: "v".repeat(MAX_SNAPSHOT_METADATA_VALUE_LENGTH + 1) } }).success).toBe(false);
    expect(responseSchema.safeParse({ version: 1, requestId: "r", ok: true, extra: 1 }).success).toBe(false);
  });
  test("accepts only bounded JSON payloads", () => {
    const command = { version: 1, requestId: "r", channel: "daemon", type: "ping", payload: {} };
    expect(commandEnvelopeSchema.safeParse(command).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse({ ...command, payload: "x".repeat(MAX_PROTOCOL_PAYLOAD_BYTES + 1) }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({ ...command, payload: undefined }).success).toBe(false);

    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth <= MAX_PROTOCOL_PAYLOAD_DEPTH; depth += 1) nested = { nested };
    expect(commandEnvelopeSchema.safeParse({ ...command, payload: nested }).success).toBe(false);
  });
});
describe("replay", () => {
  test("orders, evicts, detects gaps, and isolates subjects", () => {
    const buffer = new ReplayBuffer({ maxEntries: 2, maxBytes: 10000 }); buffer.append(event(1)); buffer.append(event(2)); buffer.append(event(3));
    expect(buffer.replay("pi", "a", 1)).toMatchObject({ kind: "replay", events: [event(2), event(3)] });
    expect(buffer.replay("pi", "a", 0).kind).toBe("snapshot-required"); expect(buffer.replay("pi", "b", 0).kind).toBe("snapshot-required");
    expect(() => buffer.append(event(3))).toThrow();
    expect(() => buffer.replay("pi", "a", -1)).toThrow();
  });
  test("evicts subjects, handles oversized events, and cleans up", () => {
    const buffer = new ReplayBuffer({ maxSubjects: 2, maxBytes: 10_000 });
    buffer.append(event(1, "a")); buffer.append(event(1, "b")); buffer.append(event(1, "c"));
    expect(buffer.replay("pi", "a", 0).kind).toBe("snapshot-required");
    expect(buffer.replay("pi", "c", 0).kind).toBe("replay");
    expect(buffer.removeSubject("pi", "b")).toBe(true); expect(buffer.removeSubject("pi", "b")).toBe(false);

    const bounded = new ReplayBuffer({ maxBytes: 150 });
    bounded.append(event(1));
    bounded.append({ ...event(2), payload: { text: "x".repeat(500) } });
    expect(bounded.replay("pi", "a", 1).kind).toBe("snapshot-required");
  });
  test("deduplicates retries and bounds cache", () => { const cache = new IdempotencyCache<number>({ maxEntries: 2 }); cache.set("a", 1); cache.set("b", 2); cache.set("a", 3); cache.set("c", 4); expect(cache.get("a")).toBe(3); expect(cache.has("b")).toBe(false); });
});
